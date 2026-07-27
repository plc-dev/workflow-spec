#!/usr/bin/env bash
# T14 (docs/impl-plans/0010-exec-agent.md): a real, local, ephemeral `kind`
# cluster used to actually exercise task 6.13's injection mechanism -
# init-container + shared emptyDir + Pod-template command override -
# against a real kubelet/API-server, plus 6.12/6.14's Invoke/Evict
# contract served from inside that real Pod.
#
# NOT wired into `go test ./...` - this is a deliberately separate,
# heavier script (kind cluster bring-up), run manually or as its own CI
# job, mirroring how docker-compose.dev.yml is kept separate from
# testcontainers' per-test ephemeral instances (ADR-0010).
#
# Usage: agent/deploy/kind/run-e2e.sh
# Requires: docker, kind, kubectl. Leaves no cluster behind on exit
# (success or failure) unless KEEP_CLUSTER=1 is set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLUSTER_NAME="exec-agent-e2e"
NAMESPACE="default"
POD_NAME="exec-agent-injection-test"

log() { echo "[run-e2e] $*" >&2; }

# Post-review addition: only ever delete the cluster THIS run created.
# The original version unconditionally deleted CLUSTER_NAME on any exit,
# including when an earlier run had deliberately kept it alive with
# KEEP_CLUSTER=1 and this run only reused it - destroying a cluster this
# invocation never created.
CREATED_CLUSTER=0
PF_PID=""
PF_LOG=""

cleanup() {
  if [ -n "${PF_PID}" ]; then
    kill "${PF_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${PF_LOG}" ]; then
    rm -f "${PF_LOG}"
  fi
  if [ "${CREATED_CLUSTER}" = "1" ] && [ "${KEEP_CLUSTER:-0}" != "1" ]; then
    log "tearing down kind cluster ${CLUSTER_NAME} (created by this run)"
    kind delete cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1 || true
  elif [ "${CREATED_CLUSTER}" = "1" ]; then
    log "KEEP_CLUSTER=1 set - leaving cluster ${CLUSTER_NAME} running"
  else
    log "cluster ${CLUSTER_NAME} was reused, not created by this run - leaving it as found"
  fi
}
trap cleanup EXIT

# Post-review addition: guard against test-pod.yaml (the manifest this
# script actually exercises) and pod-injection-example.yaml (the
# documented, untested onboarding template) drifting apart on the
# agent's own flag shape - a local review found this duplication had no
# automated check keeping the two in sync.
log "checking injection command flag-shape matches between test-pod.yaml and the documented example"
extract_agent_flags() { grep -oE -- '--[a-zA-Z][a-zA-Z0-9-]*' "$1" | sort -u; }
TEST_FLAGS="$(extract_agent_flags "${SCRIPT_DIR}/test-pod.yaml")"
EXAMPLE_FLAGS="$(extract_agent_flags "${AGENT_DIR}/deploy/pod-injection-example.yaml")"
if [ "${TEST_FLAGS}" != "${EXAMPLE_FLAGS}" ]; then
  log "FAIL: test-pod.yaml and pod-injection-example.yaml declare different agent flags - they have drifted"
  log "test-pod.yaml flags:"
  echo "${TEST_FLAGS}" >&2
  log "pod-injection-example.yaml flags:"
  echo "${EXAMPLE_FLAGS}" >&2
  exit 1
fi
log "PASS: injection flag shape matches between the tested manifest and the documented example"

log "building agent init-container image (build/Dockerfile)"
docker build -f "${AGENT_DIR}/build/Dockerfile" -t exec-agent:test "${AGENT_DIR}"

log "building fake-service image (the 'service author's' image - no agent code)"
docker build -f "${SCRIPT_DIR}/fake-service.Dockerfile" -t fake-service:test "${AGENT_DIR}"

log "creating kind cluster ${CLUSTER_NAME}"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  log "cluster ${CLUSTER_NAME} already exists, reusing"
else
  kind create cluster --name "${CLUSTER_NAME}" --config "${SCRIPT_DIR}/kind-cluster-config.yaml"
  CREATED_CLUSTER=1
fi

log "loading images into kind (no external registry needed)"
kind load docker-image exec-agent:test --name "${CLUSTER_NAME}"
kind load docker-image fake-service:test --name "${CLUSTER_NAME}"

log "waiting for the default namespace's default ServiceAccount to exist"
for i in $(seq 1 30); do
  if kubectl --context "kind-${CLUSTER_NAME}" get serviceaccount default -n "${NAMESPACE}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

log "applying test-pod.yaml"
kubectl --context "kind-${CLUSTER_NAME}" delete pod "${POD_NAME}" --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl --context "kind-${CLUSTER_NAME}" apply -f "${SCRIPT_DIR}/test-pod.yaml"

log "waiting for pod to become Ready"
kubectl --context "kind-${CLUSTER_NAME}" wait --for=condition=Ready "pod/${POD_NAME}" --timeout=90s

log "port-forwarding to the agent running inside the real pod"
PF_LOG="$(mktemp -t kind-port-forward.XXXXXX)"
kubectl --context "kind-${CLUSTER_NAME}" port-forward "pod/${POD_NAME}" 19464:9464 >"${PF_LOG}" 2>&1 &
PF_PID=$!

# Give port-forward a moment to establish.
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:19464/invoke" -X POST -d '{}' 2>/dev/null; then
    break
  fi
  sleep 0.5
done

log "asserting /invoke works through the real Pod's agent"
INVOKE_RESP=$(curl -sf -X POST http://127.0.0.1:19464/invoke \
  -H 'Content-Type: application/json' \
  -d '{"executionId":"e1","stepId":"s1","function":"f","args":{"foo":"bar"},"timeoutMs":5000}')
echo "${INVOKE_RESP}" | grep -q '"status":"ok"' || {
  log "FAIL: unexpected /invoke response: ${INVOKE_RESP}"
  exit 1
}
echo "${INVOKE_RESP}" | grep -q -- '--foo' || {
  log "FAIL: fake-cli did not observe the --foo flag: ${INVOKE_RESP}"
  exit 1
}
log "PASS: /invoke returned ok with the expected args, from inside a real kind Pod"

log "asserting /evict works through the real Pod's agent"
EVICT_RESP=$(curl -sf -X POST http://127.0.0.1:19464/evict \
  -H 'Content-Type: application/json' \
  -d '{"stateId":"does-not-exist"}')
echo "${EVICT_RESP}" | grep -q '"ack":true' || {
  log "FAIL: unexpected /evict response: ${EVICT_RESP}"
  exit 1
}
log "PASS: /evict acked"

log "asserting the fake-service container image itself has no agent/platform code"
if docker run --rm --entrypoint sh fake-service:test -c 'test -e /platform/agent' 2>/dev/null; then
  log "FAIL: fake-service:test unexpectedly contains /platform/agent - the injection claim is violated"
  exit 1
fi
log "PASS: fake-service:test contains no agent/platform code - injection is real, not baked in"

log "T14 PASSED"
