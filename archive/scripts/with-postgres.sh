#!/usr/bin/env bash
# Shared Postgres lifecycle wrapper for this repo's spikes/registry/
# placement-resolver test suites.
#
# WHY THIS EXISTS: every one of those test suites is documented as running
# "against a real Postgres instance", but the actual container start/stop
# was previously done ad hoc (a human/agent running `docker run ...` by
# hand before `npm test`), never by the committed code itself. That meant
# `npm test` alone did nothing but throw an ECONNREFUSED - not a graceful
# skip, but also not a reproducible, self-contained test run for anyone
# who didn't already know the undocumented manual step. This script is
# that missing piece: it starts a throwaway Postgres container, waits for
# it to actually be ready (not just "docker run returned"), applies the
# caller's schema file, runs the caller's test command, and tears the
# container down - all from one `npm test` invocation, with no silent
# skip path anywhere.
#
# ENFORCEMENT, not graceful degradation: if `docker` isn't on PATH, if the
# container never becomes ready within the timeout, or if schema
# application fails, this script exits non-zero and prints why - it does
# NOT fall back to "skipping" the database-dependent tests. The test
# command itself is only ever invoked once Postgres is confirmed reachable.
#
# Usage:
#   with-postgres.sh --name <container> --port <hostPort> --db <dbname> \
#     --password <pw> --schema <path/to/schema.sql> -- <command...>
#
# The container is always removed (via --rm) whether the command succeeds,
# fails, or this script is interrupted (trap on EXIT).

set -euo pipefail

NAME=""
PORT=""
DB=""
PASSWORD=""
SCHEMA=""
CMD=()
READY_TIMEOUT_SECS="${WITH_POSTGRES_READY_TIMEOUT:-60}"

usage() {
  echo "Usage: $0 --name NAME --port PORT --db DB --password PW --schema SCHEMA.sql -- CMD..." >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --schema) SCHEMA="$2"; shift 2 ;;
    --) shift; CMD=("$@"); break ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$NAME" || -z "$PORT" || -z "$DB" || -z "$PASSWORD" || -z "$SCHEMA" || ${#CMD[@]} -eq 0 ]]; then
  usage
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required to run these tests against a real Postgres instance, but was not found on PATH. Refusing to skip the database-dependent tests - install/start Docker and re-run." >&2
  exit 1
fi

if [[ ! -f "$SCHEMA" ]]; then
  echo "ERROR: schema file '$SCHEMA' not found (resolved from $(pwd))." >&2
  exit 1
fi

cleanup() {
  local code=$?
  echo "==> stopping Postgres container '$NAME' ..." >&2
  docker stop "$NAME" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT

# Idempotent: remove any stale container of the same name from a previous
# interrupted run before starting a fresh one.
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "==> starting Postgres container '$NAME' on port $PORT (db=$DB) ..." >&2
docker run --rm -d --name "$NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" \
  postgres:16-bookworm >/dev/null

echo "==> waiting up to ${READY_TIMEOUT_SECS}s for Postgres to accept connections ..." >&2
ready=0
for _ in $(seq 1 "$READY_TIMEOUT_SECS"); do
  if docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "ERROR: Postgres in container '$NAME' did not become ready within ${READY_TIMEOUT_SECS}s. Failing (not skipping) the test run." >&2
  echo "---- container logs ----" >&2
  docker logs "$NAME" 2>&1 | tail -50 >&2 || true
  exit 1
fi

echo "==> applying schema from $SCHEMA ..." >&2
if ! docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" < "$SCHEMA" >/dev/null; then
  echo "ERROR: applying schema '$SCHEMA' failed. Failing the test run." >&2
  exit 1
fi

echo "==> running: ${CMD[*]}" >&2
"${CMD[@]}"
