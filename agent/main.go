// Command agent is the in-pod exec-agent (docs/adr/0008-in-pod-exec-agent.md):
// the container's entrypoint (PID 1, not a sidecar), fork/exec'ing the
// service author's original CLI entrypoint on request over an internal
// HTTP/JSON Invoke/Evict RPC surface. See
// docs/impl-plans/0010-exec-agent.md for the full design.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agent/internal/config"
	"agent/internal/dedup"
	"agent/internal/server"
)

func main() {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		log.Fatalf("agent: %v", err)
	}

	store := dedup.NewStore(cfg.DedupTTL)
	defer store.Close()
	handler := server.New(cfg, store)

	// shutdownGraceBuffer is headroom on top of MaxInvokeTimeout for the
	// response to actually flush after the subprocess finishes.
	const shutdownGraceBuffer = 5 * time.Second

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// WriteTimeout must exceed the longest Invoke this agent will
		// accept (cfg.MaxInvokeTimeout, enforced in invoke.go) - otherwise
		// a legitimately long-running, in-progress Invoke would have its
		// own response cut off by the server itself.
		WriteTimeout: cfg.MaxInvokeTimeout + shutdownGraceBuffer,
		IdleTimeout:  60 * time.Second,
	}

	// The agent is PID 1 in a real pod - it must handle SIGTERM itself
	// (there is no init system underneath it to forward/reap signals) and
	// shut down gracefully rather than dropping in-flight Invoke calls.
	//
	// Known, deliberately deferred gap: this process does NOT reap
	// orphaned grandchildren reparented to it as PID 1. A naive
	// wait4(-1, ...)-based reaper races with os/exec's own internal Wait()
	// for children execrunner is actively waiting on (the same hazard
	// dedicated init shims like tini exist to solve correctly) - a
	// homegrown version risks introducing ECHILD races into the Invoke
	// hot path, which is worse than the zombie-accumulation gap itself.
	// Tracked as a real, named follow-up rather than silently assumed
	// solved; see docs/impl-plans/0010-exec-agent.md's Implementation
	// notes.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("agent: listening on %s, exec=%s", cfg.Listen, cfg.ExecPath)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("agent: ListenAndServe: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("agent: received shutdown signal, draining")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.MaxInvokeTimeout+shutdownGraceBuffer)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("agent: graceful shutdown failed: %v", err)
	}
}
