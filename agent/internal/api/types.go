// Package api defines the wire-level request/response shapes for the
// exec-agent's Invoke/Evict contract (docs/adr/0008-in-pod-exec-agent.md).
//
// Wire format: HTTP/1.1 + JSON (see docs/impl-plans/0010-exec-agent.md's
// "Open questions" #1) - the TypeScript side validates the same shapes with
// zod (docs/adr/0009), so these types are the Go-side counterpart of that
// contract, not an independent invention.
package api

import "encoding/json"

// DataFile is one heavy/dataset-scoped binding, translated by the agent
// into the "<flag> <path> --state-id <stateId>" CLI shape mandated by
// design.md D17/D17a.
type DataFile struct {
	Flag    string `json:"flag"`
	Path    string `json:"path"`
	StateID string `json:"stateId"`
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
	DataFiles   []DataFile        `json:"dataFiles,omitempty"`
	Secrets     []Secret          `json:"secrets,omitempty"`
	Stdin       []byte            `json:"stdin,omitempty"`
	TimeoutMs   int64             `json:"timeoutMs"`
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
