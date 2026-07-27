// Package execrunner translates an api.InvokeRequest into a real fork/exec
// of the wrapped CLI entrypoint, per docs/adr/0008-in-pod-exec-agent.md and
// design.md D17b's per-function-declared binding-injection shape
// (supersedes D17/D17a's single universal shape).
package execrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
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

	stdin, closeStdin, err := stdinSource(req)
	if err != nil {
		return api.InvokeResponse{Status: api.StatusError, ExitCode: -1, Stderr: err.Error()}
	}
	defer closeStdin()

	// req.TimeoutMs is validated as strictly positive before this function
	// is ever called (server/invoke.go) - no "unbounded when zero" case
	// remains here.
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, cfg.ExecPath, args...) //nolint:gosec // ExecPath is platform-controlled, not user input; args are validated above
	cmd.Env = buildEnv(req.Secrets)

	if stdin != nil {
		cmd.Stdin = stdin
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

// buildArgs translates req.Args (light bindings) and req.DataFiles/
// req.PositionalArgs (heavy bindings, design.md D17b: rendered per the
// TARGET FUNCTION'S OWN declared invocation style, never a platform-
// mandated shape) into a flat argv slice, rejecting any flag name that
// doesn't match flagNamePattern. A DataFile entry with StdinFromPath set
// contributes nothing to argv at all - see stdinSource. StateID is never
// rendered into argv (D17b: purely platform-internal bookkeeping, never
// exposed to the invoked subprocess - unlike D17/D17a's old contract).
func buildArgs(req api.InvokeRequest) ([]string, error) {
	args := make([]string, 0, len(req.Args)*2+len(req.DataFiles)*2+len(req.PositionalArgs))

	for flagName, value := range req.Args {
		if !flagNamePattern.MatchString(flagName) {
			return nil, fmt.Errorf("execrunner: invalid arg flag name %q", flagName)
		}
		args = append(args, "--"+flagName, value)
	}

	for _, df := range req.DataFiles {
		if df.StdinFromPath {
			continue
		}
		name, ok := stripFlagPrefix(df.Flag)
		if !ok || !flagNamePattern.MatchString(name) {
			return nil, fmt.Errorf("execrunner: invalid dataFile flag %q", df.Flag)
		}
		if err := assertSafeArgvValue(df.Path); err != nil {
			return nil, fmt.Errorf("execrunner: dataFile path for flag %q: %w", df.Flag, err)
		}
		args = append(args, "--"+name, df.Path)
	}

	// Local-review fix: PositionalArgs entries were appended to argv with
	// NO validation at all - unlike every flag VALUE above (which, prior
	// to this fix, was also unchecked; see assertSafeArgvValue), a bare
	// positional token starting with "-" is trivially reparsed by the
	// wrapped CLI as an unrelated flag. apps/worker's own dispatch.ts
	// now rejects this before ever sending the request; this is
	// defense-in-depth on the agent's own side, matching the posture
	// already applied to Args/DataFile flag names.
	for _, positional := range req.PositionalArgs {
		if err := assertSafeArgvValue(positional); err != nil {
			return nil, fmt.Errorf("execrunner: positional arg: %w", err)
		}
	}
	args = append(args, req.PositionalArgs...)

	return args, nil
}

// assertSafeArgvValue rejects an argv VALUE token (never a flag name,
// which flagNamePattern already governs) that could itself be
// reinterpreted as a flag by the wrapped CLI, or that looks like a path-
// traversal attempt. This is defense-in-depth, not the primary guard -
// apps/worker's dispatch.ts already rejects the same shapes before ever
// calling this agent (see its own assertSafeArgValue/
// assertHeavyBindingIsPath); duplicated here because this agent must
// never trust a caller's own validation as its only line of defense.
func assertSafeArgvValue(value string) error {
	if strings.HasPrefix(value, "-") {
		return fmt.Errorf("value %q looks like a flag (starts with '-')", value)
	}
	for _, segment := range strings.FieldsFunc(value, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == ".." {
			return fmt.Errorf("value %q contains a path-traversal segment", value)
		}
	}
	return nil
}

// stdinSource picks what the invoked subprocess's stdin should be, per
// design.md D17b: a DataFile with StdinFromPath set takes priority (the
// agent streams the file's CONTENTS directly from the local path it was
// materialized at - never carrying those bytes over the Invoke RPC
// itself, design.md D6/R3); otherwise it falls back to req.Stdin
// (arbitrary bytes, unrelated to heavy-binding transport - e.g. a
// function invoked with ad hoc stdin data). Returns a nil reader (and a
// no-op closer) when neither is present, leaving cmd.Stdin unset. At most
// one DataFile is expected to declare StdinFromPath for a given call; if
// more than one does, the first wins - a real registry-side inconsistency
// (validate.ts) that should never reach this package in a correctly
// registered function.
func stdinSource(req api.InvokeRequest) (io.Reader, func(), error) {
	for _, df := range req.DataFiles {
		if !df.StdinFromPath {
			continue
		}
		// Local-review fix: df.Path was passed straight to os.Open with
		// only a comment ("platform-materialized, not user input")
		// asserting its safety, with nothing enforcing it. This is
		// NOT a full containment check - this agent has no configured
		// materialization root to validate df.Path against (Layer 1's
		// actual mechanism remains unspecified, design.md D17/D6) - but
		// requiring an absolute path and rejecting ".." segments closes
		// the cheapest, highest-value share of the arbitrary-local-file-
		// read risk (e.g. a relative path escaping into another
		// directory) without inventing a containment root this package
		// was never scoped to design.
		if !strings.HasPrefix(df.Path, "/") {
			return nil, func() {}, fmt.Errorf("execrunner: stdin-from-path %q must be an absolute path", df.Path)
		}
		for _, segment := range strings.Split(df.Path, "/") {
			if segment == ".." {
				return nil, func() {}, fmt.Errorf("execrunner: stdin-from-path %q contains a path-traversal segment", df.Path)
			}
		}
		f, err := os.Open(df.Path) //nolint:gosec // df.Path is validated immediately above (absolute, no ".." segments)
		if err != nil {
			return nil, func() {}, fmt.Errorf("execrunner: opening stdin-from-path %q: %w", df.Path, err)
		}
		return f, func() { _ = f.Close() }, nil
	}
	if len(req.Stdin) > 0 {
		return bytes.NewReader(req.Stdin), func() {}, nil
	}
	return nil, func() {}, nil
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
