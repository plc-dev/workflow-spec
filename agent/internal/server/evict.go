package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"

	"agent/internal/api"
	"agent/internal/config"
)

// stateIDPattern restricts stateId to a safe path-component shape - no
// path separators, no "..", nothing that could escape cfg.StateDir once
// joined. Content hashes (the only real stateIds D17 mints) already fit
// this shape; this is a defense-in-depth input check, not a format this
// package invents meaning for.
var stateIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,255}$`)

func isValidStateID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return stateIDPattern.MatchString(id)
}

// evictHandler implements POST /evict: removes <state-dir>/<stateId> if
// present. Always responds {ack: true} when the removal itself succeeded
// or the target never existed - Evict is idempotent by construction
// (ADR-0008: "only needed... on demote", never an error merely because
// nothing was there). A genuine removal failure (permissions, busy mount,
// partial tree) is reported as a 500, not silently acked, so a caller
// never mistakes a failed cleanup for a successful one.
func evictHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		var req api.EvictRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "malformed request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if !isValidStateID(req.StateID) {
			http.Error(w, "stateId must be a non-empty path-safe token (no '/', no '..')", http.StatusBadRequest)
			return
		}

		// filepath.Join + Clean, then a belt-and-suspenders check that the
		// result is still a direct child of cfg.StateDir - isValidStateID
		// above already rejects '/'/'..', but this keeps the two checks
		// independently correct rather than relying on regex alone.
		stateDir := filepath.Clean(cfg.StateDir)
		target := filepath.Join(stateDir, req.StateID)
		if filepath.Dir(target) != stateDir {
			http.Error(w, "stateId resolved outside state-dir", http.StatusBadRequest)
			return
		}

		if err := os.RemoveAll(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "evict failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.EvictResponse{Ack: true})
	}
}
