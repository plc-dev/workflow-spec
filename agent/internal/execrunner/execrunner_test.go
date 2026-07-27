package execrunner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"agent/internal/api"
	"agent/internal/config"
)

func fakeCLIPath(t *testing.T) string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not determine test file path")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "testdata", "fake-cli.sh")
}

func testConfig(t *testing.T) config.Config {
	return config.Config{ExecPath: fakeCLIPath(t)}
}

// T1/T6: happy path returns ok + correct exitCode + parsed output.
func TestRun_happyPath(t *testing.T) {
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		TimeoutMs: 5000,
	}
	resp := Run(context.Background(), testConfig(t), req)

	if resp.Status != api.StatusOK {
		t.Fatalf("Status = %q, want %q (stderr=%q)", resp.Status, api.StatusOK, resp.Stderr)
	}
	if resp.ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0", resp.ExitCode)
	}
	if resp.Output == nil {
		t.Fatal("expected Output to be populated from valid JSON stdout")
	}
}

// T2: light Args are translated into --flagName value pairs the CLI
// receives verbatim.
func TestRun_argsTranslatedToFlags(t *testing.T) {
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		Args:      map[string]string{"foo": "bar"},
		TimeoutMs: 5000,
	}
	resp := Run(context.Background(), testConfig(t), req)

	var parsed struct {
		Args []string `json:"args"`
	}
	if err := json.Unmarshal([]byte(resp.Stdout), &parsed); err != nil {
		t.Fatalf("could not parse fake-cli stdout: %v (stdout=%q)", err, resp.Stdout)
	}
	if !containsPair(parsed.Args, "--foo", "bar") {
		t.Errorf("args = %v, want to contain [--foo bar]", parsed.Args)
	}
}

// T3: DataFiles are translated into "<flag> <path> --state-id <stateId>".
func TestRun_dataFilesTranslatedToShape(t *testing.T) {
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		DataFiles: []api.DataFile{{Flag: "--data-file", Path: "/mnt/x", StateID: "hash123"}},
		TimeoutMs: 5000,
	}
	resp := Run(context.Background(), testConfig(t), req)

	var parsed struct {
		Args []string `json:"args"`
	}
	if err := json.Unmarshal([]byte(resp.Stdout), &parsed); err != nil {
		t.Fatalf("could not parse fake-cli stdout: %v", err)
	}
	want := []string{"--data-file", "/mnt/x", "--state-id", "hash123"}
	got := parsed.Args
	if len(got) < len(want) {
		t.Fatalf("args = %v, want to contain %v", got, want)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("args[%d] = %q, want %q (full: %v)", i, got[i], w, got)
		}
	}
}

// T4: secrets are visible to the subprocess but not to the agent's own
// process environment, and are scoped to this one exec.Cmd only.
func TestRun_secretsScopedToSubprocessOnly(t *testing.T) {
	const secretName = "MY_TEST_SECRET"
	if v := os.Getenv(secretName); v != "" {
		t.Fatalf("test precondition violated: %s already set in agent's own env", secretName)
	}

	// A tiny inline shell "CLI" that echoes the secret env var so the test
	// can assert the subprocess actually received it.
	envEchoScript := writeTempScript(t, `#!/bin/sh
printf '{"secret":"%s"}\n' "$MY_TEST_SECRET"
`)

	cfg := config.Config{ExecPath: envEchoScript}
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		Secrets:   []api.Secret{{Name: secretName, Value: "top-secret-value"}},
		TimeoutMs: 5000,
	}
	resp := Run(context.Background(), cfg, req)

	if !strings.Contains(resp.Stdout, "top-secret-value") {
		t.Errorf("subprocess did not observe the secret; stdout=%q", resp.Stdout)
	}
	if v := os.Getenv(secretName); v != "" {
		t.Errorf("agent's own process environment was mutated: %s=%q", secretName, v)
	}
}

// T5: a call exceeding TimeoutMs is reported as status "timeout".
func TestRun_timeout(t *testing.T) {
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		Args:      map[string]string{"sleep-ms": "500"},
		TimeoutMs: 50,
	}
	resp := Run(context.Background(), testConfig(t), req)

	if resp.Status != api.StatusTimeout {
		t.Fatalf("Status = %q, want %q", resp.Status, api.StatusTimeout)
	}
}

// T6: a nonzero exit is reported as status "error" with the real exit code.
func TestRun_nonZeroExit(t *testing.T) {
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		Args:      map[string]string{"exit-code": "7"},
		TimeoutMs: 5000,
	}
	resp := Run(context.Background(), testConfig(t), req)

	if resp.Status != api.StatusError {
		t.Fatalf("Status = %q, want %q", resp.Status, api.StatusError)
	}
	if resp.ExitCode != 7 {
		t.Errorf("ExitCode = %d, want 7", resp.ExitCode)
	}
}

// Stdin is piped through to the subprocess.
func TestRun_stdinPassthrough(t *testing.T) {
	req := api.InvokeRequest{
		ExecutionID: "e1", StepID: "s1", Function: "f",
		Stdin:     []byte("hello-stdin"),
		TimeoutMs: 5000,
	}
	resp := Run(context.Background(), testConfig(t), req)

	if !strings.Contains(resp.Stdout, "hello-stdin") {
		t.Errorf("stdin was not passed through; stdout=%q", resp.Stdout)
	}
}

func containsPair(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

func writeTempScript(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "script.sh")
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("could not write temp script: %v", err)
	}
	return path
}
