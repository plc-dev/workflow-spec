// Package api defines the wire-level request/response shapes for the
// exec-agent's Invoke/Evict contract (docs/adr/0008-in-pod-exec-agent.md).
//
// Wire format: HTTP/1.1 + JSON (see docs/impl-plans/0010-exec-agent.md's
// "Open questions" #1) - the TypeScript side validates the same shapes with
// zod (docs/adr/0009), so these types are the Go-side counterpart of that
// contract, not an independent invention.
package api

import "encoding/json"

// DataFile is one heavy/dataset-scoped binding. design.md D17b supersedes
// D17/D17a's single universal "<flag> <path> --state-id <stateId>" CLI
// shape with a per-function DECLARED shape (registry/'s
// invocationDescriptor, Layer 2) - the agent renders whichever ONE of
// these three the caller (apps/worker) selected for this entry, never a
// platform-mandated default:
//   - Flag set, StdinFromPath false: "--<Flag> <Path>" (two argv tokens).
//   - Flag empty, StdinFromPath false: Path is a bare POSITIONAL argument
//     instead - see InvokeRequest.PositionalArgs, not this struct.
//   - StdinFromPath true: the FILE'S CONTENTS at Path (never Path itself,
//     and never carried as bytes over this RPC - design.md D6/R3) are
//     piped to the subprocess's stdin.
// StateID (Layer 3) is populated ONLY for a function declaring
// `stateReuse: "stateIdKeyed"` in the registry, and is informational to
// the agent only - the agent never renders it into argv (a naive service
// never sees a state-id at all; it is a purely platform-internal
// bookkeeping value, unlike D17/D17a's old contract which handed it to
// every service unconditionally).
type DataFile struct {
	Flag          string `json:"flag,omitempty"`
	Path          string `json:"path"`
	StateID       string `json:"stateId,omitempty"`
	StdinFromPath bool   `json:"stdinFromPath,omitempty"`
}

// Secret is pushed by value over the TLS-secured internal channel (ADR-0008
// "Secrets" section) and delivered to the invoked subprocess only, scoped
// to its own environment - never the agent's own process environment.
type Secret struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// InvokeRequest is the exec-agent's sole business-logic RPC input.
// ExecutionID/StepID together are the idempotency key - the same tuple as
// the core/ checkpoints table's UNIQUE(execution_id, step_id) constraint,
// never a separately invented invocation id (ADR-0008).
type InvokeRequest struct {
	ExecutionID string            `json:"executionId"`
	StepID      string            `json:"stepId"`
	Function    string            `json:"function"`
	Args        map[string]string `json:"args,omitempty"`
	// PositionalArgs (design.md D17b): heavy bindings whose function
	// declares invocationDescriptor style "positional" - ordered by the
	// caller (apps/worker, per the descriptor's positionIndex), appended
	// to argv after every flag.
	PositionalArgs []string   `json:"positionalArgs,omitempty"`
	DataFiles      []DataFile `json:"dataFiles,omitempty"`
	Secrets        []Secret   `json:"secrets,omitempty"`
	Stdin          []byte     `json:"stdin,omitempty"`
	TimeoutMs      int64      `json:"timeoutMs"`
}

// Status values for InvokeResponse.Status.
const (
	StatusOK      = "ok"
	StatusError   = "error"
	StatusTimeout = "timeout"
)

// InvokeResponse is the exec-agent's sole business-logic RPC output.
//
// Output is deliberately best-effort (docs/impl-plans/0010-exec-agent.md's
// "Open questions" #3): the agent has no registry access and cannot parse
// stdout per the invoked function's real OpenAPI response shape, so it
// only attempts a plain JSON unmarshal of stdout and includes it verbatim
// when that succeeds. Real OpenAPI-shaped parsing is apps/worker's job.
type InvokeResponse struct {
	Status   string          `json:"status"`
	Stdout   string          `json:"stdout"`
	Stderr   string          `json:"stderr"`
	ExitCode int             `json:"exitCode"`
	Output   json.RawMessage `json:"output,omitempty"`
}

// EvictRequest asks the agent to clean up locally-held state for a
// state-id on demote (design.md D4a) - only meaningful for the
// worker-written-local-scratch-file fallback path (D17); a per-hash CSI
// volume needs no Evict call at all (ADR-0008).
type EvictRequest struct {
	StateID string `json:"stateId"`
}

// EvictResponse is always {ack: true} - Evict is idempotent, and removing
// an already-absent state-id is not an error (ADR-0008).
type EvictResponse struct {
	Ack bool `json:"ack"`
}
