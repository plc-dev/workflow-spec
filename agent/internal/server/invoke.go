package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"agent/internal/api"
	"agent/internal/config"
	"agent/internal/dedup"
	"agent/internal/execrunner"
)

// invokeHandler implements POST /invoke: decode -> dedup.Attach -> (leader:
// execrunner.Run + Resolve | follower: await the shared channel) -> encode.
// See docs/impl-plans/0010-exec-agent.md's "Data flow inside POST /invoke".
func invokeHandler(cfg config.Config, store *dedup.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		var req api.InvokeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "malformed request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.ExecutionID == "" || req.StepID == "" || req.Function == "" {
			http.Error(w, "executionId, stepId, and function are required", http.StatusBadRequest)
			return
		}
		if req.TimeoutMs <= 0 {
			http.Error(w, "timeoutMs must be a positive number of milliseconds", http.StatusBadRequest)
			return
		}
		if maxMs := cfg.MaxInvokeTimeout.Milliseconds(); maxMs > 0 && req.TimeoutMs > maxMs {
			http.Error(w, fmt.Sprintf("timeoutMs %d exceeds this agent's max-invoke-timeout (%dms)", req.TimeoutMs, maxMs), http.StatusBadRequest)
			return
		}

		key := dedup.Key{ExecutionID: req.ExecutionID, StepID: req.StepID}
		resultCh, isLeader := store.Attach(key)

		var resp api.InvokeResponse
		if isLeader {
			// The subprocess's lifetime is intentionally detached from this
			// HTTP request's own context (docs/impl-plans/0010-exec-agent.md's
			// post-review addition): a caller disconnecting must NOT kill an
			// in-flight, possibly-still-useful subprocess or poison the dedup
			// cache with a fabricated error for every follower/retry within
			// DedupTTL. req.TimeoutMs (applied inside execrunner.Run) remains
			// the only cancellation source.
			resp = execrunner.Run(context.WithoutCancel(r.Context()), cfg, req)
			store.Resolve(key, dedup.Result{Response: resp})
		} else {
			select {
			case result := <-resultCh:
				if result.Err != nil {
					http.Error(w, result.Err.Error(), http.StatusInternalServerError)
					return
				}
				var ok bool
				resp, ok = result.Response.(api.InvokeResponse)
				if !ok {
					http.Error(w, "internal dedup error: unexpected result type", http.StatusInternalServerError)
					return
				}
			case <-r.Context().Done():
				http.Error(w, "client disconnected while awaiting an in-flight invocation for this key", http.StatusServiceUnavailable)
				return
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}
