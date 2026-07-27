package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"agent/internal/api"
	"agent/internal/config"
	"agent/internal/dedup"
)

func fakeCLIPath(t *testing.T) string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not determine test file path")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "testdata", "fake-cli.sh")
}

func newTestServer(t *testing.T, cfg config.Config) *httptest.Server {
	if cfg.ExecPath == "" {
		cfg.ExecPath = fakeCLIPath(t)
	}
	if cfg.StateDir == "" {
		cfg.StateDir = t.TempDir()
	}
	if cfg.DedupTTL == 0 {
		cfg.DedupTTL = time.Minute
	}
	store := dedup.NewStore(cfg.DedupTTL)
	t.Cleanup(store.Close)
	return httptest.NewServer(New(cfg, store))
}

// readInvocationCount reads a fake-cli invocations file (one "1" line per
// real subprocess invocation, per testdata/fake-cli.sh) and returns how
// many invocations were recorded, treating an empty/absent file as 0.
// Shared by TestInvoke_concurrentSameKeyDedup and
// TestInvoke_newInvocationAfterDedupWindow so the two never diverge on
// this parsing again (a local review found they already had).
func readInvocationCount(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("could not read invocations file: %v", err)
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return 0
	}
	return len(bytes.Split(trimmed, []byte("\n")))
}

func doInvoke(t *testing.T, srv *httptest.Server, req api.InvokeRequest) api.InvokeResponse {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	resp, err := http.Post(srv.URL+"/invoke", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /invoke: %v", err)
	}
	defer resp.Body.Close()
	var out api.InvokeResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return out
}

// T1: happy path through the real HTTP server.
func TestInvoke_happyPath(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	resp := doInvoke(t, srv, api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 5000,
	})
	if resp.Status != api.StatusOK {
		t.Fatalf("Status = %q, want %q", resp.Status, api.StatusOK)
	}
}

// T7: concurrent Invoke calls with the identical (executionId, stepId)
// against a slow fake CLI result in exactly ONE subprocess spawn, and both
// callers receive the same response.
func TestInvoke_concurrentSameKeyDedup(t *testing.T) {
	invocationsFile := filepath.Join(t.TempDir(), "invocations.txt")
	t.Setenv("FAKE_CLI_INVOCATIONS_FILE", invocationsFile)
	if err := os.WriteFile(invocationsFile, nil, 0o644); err != nil {
		t.Fatalf("could not seed invocations file: %v", err)
	}

	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	const n = 5
	var wg sync.WaitGroup
	responses := make([]api.InvokeResponse, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			responses[i] = doInvoke(t, srv, api.InvokeRequest{
				ExecutionID: "e1", StepID: "s1", Function: "f",
				Args:      map[string]string{"sleep-ms": "300"},
				TimeoutMs: 5000,
			})
		}(i)
	}
	wg.Wait()

	for i, r := range responses {
		if r.Status != api.StatusOK {
			t.Errorf("response %d: Status = %q, want %q", i, r.Status, api.StatusOK)
		}
	}
	// All responses must be identical (same subprocess result, not five
	// independent runs).
	for i := 1; i < n; i++ {
		if responses[i].Stdout != responses[0].Stdout {
			t.Errorf("response %d stdout differs from response 0: %q vs %q", i, responses[i].Stdout, responses[0].Stdout)
		}
	}

	count := readInvocationCount(t, invocationsFile)
	if count != 1 {
		t.Fatalf("fake-cli was invoked %d times for %d concurrent identical-key requests, want exactly 1", count, n)
	}
}

// T8: a request for the same key issued AFTER the first has already
// completed and its dedup TTL expired spawns a fresh subprocess.
func TestInvoke_newInvocationAfterDedupWindow(t *testing.T) {
	invocationsFile := filepath.Join(t.TempDir(), "invocations.txt")
	t.Setenv("FAKE_CLI_INVOCATIONS_FILE", invocationsFile)
	if err := os.WriteFile(invocationsFile, nil, 0o644); err != nil {
		t.Fatalf("could not seed invocations file: %v", err)
	}

	srv := newTestServer(t, config.Config{DedupTTL: 20 * time.Millisecond})
	defer srv.Close()

	doInvoke(t, srv, api.InvokeRequest{ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 5000})
	time.Sleep(60 * time.Millisecond)
	doInvoke(t, srv, api.InvokeRequest{ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 5000})

	count := readInvocationCount(t, invocationsFile)
	if count != 2 {
		t.Fatalf("fake-cli was invoked %d times across two non-overlapping requests for the same key, want 2", count)
	}
}

// T10: Evict removes an existing state directory.
func TestEvict_removesExistingState(t *testing.T) {
	stateDir := t.TempDir()
	target := filepath.Join(stateDir, "hash123")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("could not seed state dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(target, "data.bin"), []byte("x"), 0o644); err != nil {
		t.Fatalf("could not seed state file: %v", err)
	}

	srv := newTestServer(t, config.Config{StateDir: stateDir})
	defer srv.Close()

	body, _ := json.Marshal(api.EvictRequest{StateID: "hash123"})
	resp, err := http.Post(srv.URL+"/evict", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /evict: %v", err)
	}
	defer resp.Body.Close()

	var out api.EvictResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.Ack {
		t.Error("Ack = false, want true")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Errorf("state dir %q still exists after Evict", target)
	}
}

// T11: Evict for a nonexistent stateId is still acked (idempotent no-op).
func TestEvict_nonexistentStateIsStillAcked(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	body, _ := json.Marshal(api.EvictRequest{StateID: "does-not-exist"})
	resp, err := http.Post(srv.URL+"/evict", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /evict: %v", err)
	}
	defer resp.Body.Close()

	var out api.EvictResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.Ack {
		t.Error("Ack = false, want true")
	}
}

// T12: malformed JSON / missing required field returns 400.
func TestInvoke_malformedBody(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/invoke", "application/json", bytes.NewReader([]byte("not json")))
	if err != nil {
		t.Fatalf("POST /invoke: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("StatusCode = %d, want %d", resp.StatusCode, http.StatusBadRequest)
	}
}

func TestInvoke_missingRequiredField(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	body, _ := json.Marshal(api.InvokeRequest{Function: "f"}) // missing executionId/stepId
	resp, err := http.Post(srv.URL+"/invoke", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /invoke: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("StatusCode = %d, want %d", resp.StatusCode, http.StatusBadRequest)
	}
}

// Post-review addition: timeoutMs <= 0 must be rejected, not silently run
// unbounded.
func TestInvoke_rejectsNonPositiveTimeout(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	body, _ := json.Marshal(api.InvokeRequest{ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 0})
	resp, err := http.Post(srv.URL+"/invoke", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /invoke: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("StatusCode = %d, want %d", resp.StatusCode, http.StatusBadRequest)
	}
}

// Post-review addition: a timeoutMs above the agent's configured
// max-invoke-timeout is rejected rather than accepted unbounded.
func TestInvoke_rejectsTimeoutExceedingMax(t *testing.T) {
	srv := newTestServer(t, config.Config{MaxInvokeTimeout: 100 * time.Millisecond})
	defer srv.Close()

	body, _ := json.Marshal(api.InvokeRequest{ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 5000})
	resp, err := http.Post(srv.URL+"/invoke", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /invoke: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("StatusCode = %d, want %d", resp.StatusCode, http.StatusBadRequest)
	}
}

// Post-review addition: unvalidated Args flag names must be rejected, not
// forwarded verbatim into the wrapped CLI's argv (argument injection).
func TestInvoke_rejectsInvalidArgFlagName(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	resp := doInvoke(t, srv, api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		Args:      map[string]string{"-e": "malicious"},
		TimeoutMs: 5000,
	})
	if resp.Status != api.StatusError {
		t.Fatalf("Status = %q, want %q for an invalid flag name", resp.Status, api.StatusError)
	}
}

// Post-review addition: /evict must reject a stateId that would escape
// --state-dir once joined (path traversal).
func TestEvict_rejectsPathTraversal(t *testing.T) {
	stateDir := t.TempDir()
	srv := newTestServer(t, config.Config{StateDir: stateDir})
	defer srv.Close()

	for _, stateID := range []string{"../escaped", "..", ".", "a/../../b", "/etc"} {
		body, _ := json.Marshal(api.EvictRequest{StateID: stateID})
		resp, err := http.Post(srv.URL+"/evict", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST /evict(%q): %v", stateID, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("stateId %q: StatusCode = %d, want %d", stateID, resp.StatusCode, http.StatusBadRequest)
		}
	}
}

// Post-review addition: when AuthToken is configured, requests without a
// matching bearer token are rejected, and requests with the correct token
// succeed.
func TestInvoke_authEnforcedWhenTokenConfigured(t *testing.T) {
	srv := newTestServer(t, config.Config{AuthToken: "sekret"})
	defer srv.Close()

	body, _ := json.Marshal(api.InvokeRequest{ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 5000})

	// No Authorization header at all.
	resp, err := http.Post(srv.URL+"/invoke", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /invoke: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: StatusCode = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}

	// Wrong token.
	reqWrong, _ := http.NewRequest(http.MethodPost, srv.URL+"/invoke", bytes.NewReader(body))
	reqWrong.Header.Set("Authorization", "Bearer wrong")
	respWrong, err := http.DefaultClient.Do(reqWrong)
	if err != nil {
		t.Fatalf("POST /invoke (wrong token): %v", err)
	}
	respWrong.Body.Close()
	if respWrong.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong token: StatusCode = %d, want %d", respWrong.StatusCode, http.StatusUnauthorized)
	}

	// Correct token.
	reqRight, _ := http.NewRequest(http.MethodPost, srv.URL+"/invoke", bytes.NewReader(body))
	reqRight.Header.Set("Authorization", "Bearer sekret")
	respRight, err := http.DefaultClient.Do(reqRight)
	if err != nil {
		t.Fatalf("POST /invoke (correct token): %v", err)
	}
	defer respRight.Body.Close()
	if respRight.StatusCode != http.StatusOK {
		t.Errorf("correct token: StatusCode = %d, want %d", respRight.StatusCode, http.StatusOK)
	}
}

// Post-review addition: when AuthToken is empty (unconfigured), requests
// proceed without any Authorization header - preserving today's default
// (auth is opt-in, matching a real deployment that always sets it).
func TestInvoke_noAuthRequiredWhenTokenUnset(t *testing.T) {
	srv := newTestServer(t, config.Config{})
	defer srv.Close()

	resp := doInvoke(t, srv, api.InvokeRequest{ExecutionID: "e1", StepID: "s1", Function: "f", TimeoutMs: 5000})
	if resp.Status != api.StatusOK {
		t.Fatalf("Status = %q, want %q", resp.Status, api.StatusOK)
	}
}
