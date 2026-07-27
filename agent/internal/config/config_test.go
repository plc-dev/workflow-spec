package config

import (
	"testing"
	"time"
)

func TestParse_defaults(t *testing.T) {
	cfg, err := Parse([]string{"--exec", "/bin/true"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Listen != ":9464" {
		t.Errorf("Listen = %q, want %q", cfg.Listen, ":9464")
	}
	if cfg.ExecPath != "/bin/true" {
		t.Errorf("ExecPath = %q, want %q", cfg.ExecPath, "/bin/true")
	}
	if cfg.StateDir != "/var/run/agent-state" {
		t.Errorf("StateDir = %q, want default", cfg.StateDir)
	}
	if cfg.DedupTTL != 30*time.Second {
		t.Errorf("DedupTTL = %v, want 30s", cfg.DedupTTL)
	}
}

func TestParse_overrides(t *testing.T) {
	cfg, err := Parse([]string{
		"--listen", ":8080",
		"--exec", "/usr/local/bin/fake-cli.sh",
		"--state-dir", "/tmp/state",
		"--dedup-ttl", "5s",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Listen != ":8080" {
		t.Errorf("Listen = %q, want %q", cfg.Listen, ":8080")
	}
	if cfg.StateDir != "/tmp/state" {
		t.Errorf("StateDir = %q, want %q", cfg.StateDir, "/tmp/state")
	}
	if cfg.DedupTTL != 5*time.Second {
		t.Errorf("DedupTTL = %v, want 5s", cfg.DedupTTL)
	}
}

func TestParse_missingExec(t *testing.T) {
	_, err := Parse([]string{})
	if err == nil {
		t.Fatal("expected an error for missing --exec, got nil")
	}
}
