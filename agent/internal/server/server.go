// Package server wires the exec-agent's HTTP handlers
// (docs/adr/0008-in-pod-exec-agent.md's Invoke/Evict contract) into an
// http.Handler suitable for http.ListenAndServe.
package server

import (
	"crypto/subtle"
	"net/http"

	"agent/internal/config"
	"agent/internal/dedup"
)

// maxRequestBodyBytes bounds /invoke and /evict request bodies so a
// single caller cannot force unbounded memory allocation via a large
// stdin/args payload. 16 MiB comfortably covers any light-binding request;
// heavy/dataset-scoped bindings travel via dataFiles' mounted paths, per
// D17/D17a, never inline in the request body.
const maxRequestBodyBytes = 16 << 20 // 16 MiB

// New builds the exec-agent's HTTP handler. If cfg.AuthToken is set, every
// request must carry a matching "Authorization: Bearer <token>" header
// (docs/impl-plans/0010-exec-agent.md's post-review addition, addressing
// the plain, unauthenticated RPC surface the local review found) - the
// worker is expected to source this from the same mounted secret the
// platform provisions the agent's own AuthTokenEnvVar from.
func New(cfg config.Config, dedupStore *dedup.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/invoke", invokeHandler(cfg, dedupStore))
	mux.HandleFunc("/evict", evictHandler(cfg))
	return authMiddleware(cfg.AuthToken, mux)
}

func authMiddleware(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	want := "Bearer " + token
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
