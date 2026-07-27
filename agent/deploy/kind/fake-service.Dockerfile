# The "service author's" image for the T14 injection test
# (docs/impl-plans/0010-exec-agent.md). Deliberately contains ONLY the
# fake-cli test fixture - no agent binary, no platform code at all - to
# actually demonstrate task 6.13's claim that onboarding a service
# requires no author-side Dockerfile changes: the agent arrives entirely
# via the init-container + emptyDir mechanism, never by rebuilding this
# image.
FROM alpine:3.20
COPY testdata/fake-cli.sh /usr/local/bin/fake-cli.sh
RUN chmod +x /usr/local/bin/fake-cli.sh
# No ENTRYPOINT/CMD override here on purpose - test-pod.yaml's command
# override (the platform's deployment templating) is what actually starts
# the agent as PID 1 in the real injection test, exactly mirroring how
# ADR-0008 says a real onboarded service's own image is never modified for
# this.
