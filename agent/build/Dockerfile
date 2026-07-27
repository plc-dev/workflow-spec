# The init-container image (task 6.13, docs/adr/0008-in-pod-exec-agent.md):
# a static agent binary, nothing else. The platform's own init-container
# copies /platform/agent from this image onto a shared emptyDir; the
# target Pod's real container never derives from this image - it only
# receives the binary via the emptyDir mount, per ADR-0008's "requires no
# cooperation from the service author beyond what D12/D17 already
# mandate" claim.

FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
# CGO_ENABLED=0 for a fully static binary - no libc dependency in the
# final scratch-based image below.
RUN CGO_ENABLED=0 GOOS=linux go build -o /platform/agent .

# busybox, not scratch: the init-container usage (task 6.13) needs a shell
# + `cp` to copy the binary onto the target Pod's shared emptyDir - scratch
# has neither. Still a static Go binary on a minimal (~2MB) base, not a
# general-purpose distro image. When run directly (not as an
# init-container) its own ENTRYPOINT still starts the agent's HTTP server.
FROM busybox:1.36
COPY --from=builder /platform/agent /platform/agent
ENTRYPOINT ["/platform/agent"]
