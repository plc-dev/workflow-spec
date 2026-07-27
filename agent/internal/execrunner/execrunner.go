// Package execrunner translates an api.InvokeRequest into a real fork/exec
// of the wrapped CLI entrypoint, per docs/adr/0008-in-pod-exec-agent.md and
// design.md D17/D17a's binding-injection shape.
package execrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"time"

	"agent/internal/api"
	"agent/internal/config"
)

// flagNamePattern restricts translated flag names (from req.Args keys and
// req.DataFiles[i].Flag, minus their leading "--") to a safe, unambiguous
// shape - no leading "-" (which would let a caller smuggle a second flag
// via an Args key), no "=", no whitespace, nothing shell-special. This is
// argument-injection defense-in-depth: exec.Command never invokes a shell,
// but an unvalidated flag name could still redirect the wrapped CLI's own
// flag parsing (e.g. an Args key of "-e" or "-" or "output-file=/etc/x").
var flagNamePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]*$`)

// maxCapturedOutputBytes bounds how much of a subprocess's stdout/stderr
// the agent buffers in memory. A well-behaved CLI's output is small; a
// runaway or misbehaving one must not be able to force unbounded agent
// memory growth (docs/impl-plans/0010-exec-agent.md's post-review
// addition).
const maxCapturedOutputBytes = 8 << 20 // 8 MiB per stream

// Run fork/execs cfg.ExecPath with req's bindings translated into CLI
// flags/data-file arguments/subprocess-scoped secret env vars, and returns
// a fully-populated InvokeResponse. Run never returns a Go error for a
// subprocess failure/timeout/validation problem - those are reported via
// the response's Status/ExitCode/Stderr fields, matching ADR-0008's
// contract shape.
func Run(ctx context.Context, cfg config.Config, req api.InvokeRequest) api.InvokeResponse {
	args, err := buildArgs(req)
	if err != nil {
		return api.InvokeResponse{Status: api.StatusError, ExitCode: -1, Stderr: err.Error()}
	}

	// req.TimeoutMs is validated as strictly positive before this function
	// is ever called (server/invoke.go) - no "unbounded when zero" case
	// remains here.
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, cfg.ExecPath, args...) //nolint:gosec // ExecPath is platform-controlled, not user input; args are validated above
	cmd.Env = buildEnv(req.Secrets)

	if len(req.Stdin) > 0 {
		cmd.Stdin = bytes.NewReader(req.Stdin)
	}

	stdout := newLimitedBuffer(maxCapturedOutputBytes)
	stderr := newLimitedBuffer(maxCapturedOutputBytes)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	runErr := cmd.Run()

	resp := api.InvokeResponse{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}

	switch {
	case runErr == nil:
		resp.Status = api.StatusOK
		resp.ExitCode = 0
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		resp.Status = api.StatusTimeout
		resp.ExitCode = -1
	default:
		resp.Status = api.StatusError
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			resp.ExitCode = exitErr.ExitCode()
		} else {
			resp.ExitCode = -1
			if resp.Stderr == "" {
				resp.Stderr = runErr.Error()
			}
		}
	}

	if resp.Status == api.StatusOK {
		var raw json.RawMessage
		if json.Unmarshal(stdout.Bytes(), &raw) == nil {
			resp.Output = raw
		}
	}

	return resp
}

// buildArgs translates req.Args (light bindings, D17a: "ordinary CLI
// flags") and req.DataFiles (heavy bindings, D17/D17a's mandated
// "--data-file <path> --state-id <key>" shape) into a flat argv slice,
// rejecting any flag name that doesn't match flagNamePattern.
func buildArgs(req api.InvokeRequest) ([]string, error) {
	args := make([]string, 0, len(req.Args)*2+len(req.DataFiles)*4)

	for flagName, value := range req.Args {
		if !flagNamePattern.MatchString(flagName) {
			return nil, fmt.Errorf("execrunner: invalid arg flag name %q", flagName)
		}
		args = append(args, "--"+flagName, value)
	}

	for _, df := range req.DataFiles {
		flag := df.Flag
		if flag == "" {
			flag = "--data-file"
		}
		name, ok := stripFlagPrefix(flag)
		if !ok || !flagNamePattern.MatchString(name) {
			return nil, fmt.Errorf("execrunner: invalid dataFile flag %q", flag)
		}
		args = append(args, "--"+name, df.Path, "--state-id", df.StateID)
	}

	return args, nil
}

// stripFlagPrefix requires and removes a leading "--", returning ok=false
// for anything else (a bare value, a single "-", "-x" short flags, etc.) -
// this package only ever emits/accepts the long-flag shape D17 specifies.
func stripFlagPrefix(flag string) (name string, ok bool) {
	const prefix = "--"
	if len(flag) <= len(prefix) || flag[:len(prefix)] != prefix {
		return "", false
	}
	return flag[len(prefix):], true
}

// buildEnv delivers each secret as a subprocess-scoped environment
// variable (docs/impl-plans/0010-exec-agent.md's "Open questions" #2) -
// never via os.Setenv on the agent's own process, and never for the
// container's whole lifetime (D7 rule 2), only for this one exec.Cmd. The
// agent's own inherited environment (PATH, etc.) is preserved so the
// subprocess still resolves normally; only the secret entries are added,
// scoped to this one command.
func buildEnv(secrets []api.Secret) []string {
	if len(secrets) == 0 {
		return nil // nil means exec.Cmd falls back to os.Environ() itself
	}
	env := append([]string{}, os.Environ()...)
	for _, s := range secrets {
		env = append(env, s.Name+"="+s.Value)
	}
	return env
}

// limitedBuffer is an io.Writer that caps how many bytes it retains,
// silently dropping (not erroring on, since that would break the
// subprocess's pipe) anything past the cap.
type limitedBuffer struct {
	buf bytes.Buffer
	max int
}

func newLimitedBuffer(max int) *limitedBuffer {
	return &limitedBuffer{max: max}
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	remaining := l.max - l.buf.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		l.buf.Write(p[:remaining])
		return len(p), nil
	}
	return l.buf.Write(p)
}

func (l *limitedBuffer) String() string { return l.buf.String() }
func (l *limitedBuffer) Bytes() []byte  { return l.buf.Bytes() }
