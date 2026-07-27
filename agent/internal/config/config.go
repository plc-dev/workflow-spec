// Package config parses the exec-agent's startup flags (and, for the one
// secret-shaped value, an environment variable) into a Config.
//
// This is the Go-side counterpart to src/shared/config.ts's role (ADR-0009/
// ADR-0012) - NOT an extension of that closed TypeScript file, which is
// scoped to the single TypeScript package under src/ and does not govern
// this separate Go module (see docs/impl-plans/0010-exec-agent.md's "Open
// questions" #6). The agent is started via a platform-controlled Pod
// command override (ADR-0008), not via a service author's own invocation,
// so flags are its configuration surface for everything except the auth
// token below, which follows the project's own posture of never putting a
// secret-shaped value where `ps`/the Pod spec's `command` field can see it
// (mirroring ADR-0008's own "never the container's whole lifetime" secrets
// framing, applied here to the agent's own control-plane credential).
package config

import (
	"flag"
	"fmt"
	"os"
	"time"
)

// AuthTokenEnvVar is the environment variable the agent reads its
// shared-secret bearer token from (see server.authMiddleware). Sourced
// from a mounted Kubernetes Secret in a real deployment, never a
// Pod-spec `command` flag.
const AuthTokenEnvVar = "AGENT_AUTH_TOKEN"

// Config holds the exec-agent's fully-parsed startup configuration.
type Config struct {
	// Listen is the address the agent's HTTP server binds to, e.g. ":9464"
	// (the literal example ADR-0008 names).
	Listen string
	// ExecPath is the original CLI entrypoint the agent fork/execs on every
	// Invoke call - the service author's own binary, unmodified.
	ExecPath string
	// StateDir is the root directory Evict removes a stateId-named
	// subdirectory from. Only meaningful for the local-scratch-file
	// fallback path (D17); a per-hash CSI volume path never calls Evict.
	StateDir string
	// DedupTTL bounds how long a completed Invoke's result is kept in the
	// agent's local, in-memory dedup store (ADR-0008 Window C) - a latency
	// nicety only, never the durable idempotency gate.
	DedupTTL time.Duration
	// AuthToken, if non-empty, is required as a "Bearer <token>"
	// Authorization header on every /invoke and /evict request (see
	// docs/impl-plans/0010-exec-agent.md's post-review addition). Empty
	// means no application-level auth is enforced by the agent itself -
	// acceptable only when the cluster's own network policy already
	// restricts who can reach this port; the platform is expected to
	// always set this in a real deployment.
	AuthToken string
	// MaxInvokeTimeout caps the timeoutMs a caller may request on
	// /invoke, and sizes both the HTTP server's WriteTimeout and main's
	// shutdown drain window - so an in-flight Invoke can never legitimately
	// outlive either (docs/impl-plans/0010-exec-agent.md's post-review
	// addition: the shutdown drain was previously a hardcoded 10s
	// regardless of the caller-supplied, unbounded timeoutMs).
	MaxInvokeTimeout time.Duration
}

// Parse parses the given args (typically os.Args[1:]) into a Config, or
// returns an error for a missing required flag. AuthToken is read from the
// AuthTokenEnvVar environment variable, not a flag.
func Parse(args []string) (Config, error) {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	listen := fs.String("listen", ":9464", "address the agent's HTTP server binds to")
	execPath := fs.String("exec", "", "path to the original CLI entrypoint to fork/exec (required)")
	stateDir := fs.String("state-dir", "/var/run/agent-state", "root directory for Evict-managed local state")
	dedupTTL := fs.Duration("dedup-ttl", 30*time.Second, "how long a completed Invoke result is kept in the local dedup cache")
	maxInvokeTimeout := fs.Duration("max-invoke-timeout", 5*time.Minute, "upper bound a caller may request via timeoutMs on /invoke")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if *execPath == "" {
		return Config{}, fmt.Errorf("config: --exec is required")
	}

	return Config{
		Listen:           *listen,
		ExecPath:         *execPath,
		StateDir:         *stateDir,
		DedupTTL:         *dedupTTL,
		AuthToken:        os.Getenv(AuthTokenEnvVar),
		MaxInvokeTimeout: *maxInvokeTimeout,
	}, nil
}
