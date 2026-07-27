// Package dedup implements the exec-agent's local, in-process, in-flight
// deduplication keyed on (executionId, stepId) - the same tuple as core/'s
// checkpoints table UNIQUE(execution_id, step_id) constraint, per
// docs/adr/0008-in-pod-exec-agent.md.
//
// This covers exactly the narrow in-pod race ADR-0008 names as Window B
// ("worker crashes WHILE the agent is still mid-exec... a new worker sends
// a fresh Invoke for the SAME (executionId, stepId)") and, via a bounded
// TTL, Window C (a lost response served from a short-lived local cache).
// It is NOT the durable idempotency gate - the interpreter's
// checkpoint-check before calling Invoke at all is (ADR-0008) - so losing
// this state on agent restart is an accepted gap, not a correctness bug.
package dedup

import (
	"fmt"
	"sync"
	"time"
)

// defaultMaxLease bounds how long an entry may sit unresolved before the
// sweeper assumes its leader is dead (crashed goroutine, unrecovered
// panic) and force-resolves it with an error, freeing every follower
// blocked on it and letting a fresh Attach become a new leader
// immediately (docs/impl-plans/0010-exec-agent.md's post-review
// addition - a local review found unresolved entries had no expiry at
// all). Overridable only for tests, within this package.
var defaultMaxLease = 5 * time.Minute

// sweepInterval is how often the background sweeper runs independently of
// any Attach call, so entries are reclaimed even when no new traffic
// arrives for the affected key.
const sweepInterval = time.Second

// Key identifies one Invoke call for dedup purposes.
type Key struct {
	ExecutionID string
	StepID      string
}

// Result is what every caller sharing a Key eventually receives. Err is
// set instead of Response when the leader never resolved within
// defaultMaxLease (assumed dead) - callers must check Err before using
// Response.
type Result struct {
	Response any
	Err      error
}

type entry struct {
	done      chan struct{}
	result    Result
	resolved  bool
	createdAt time.Time
	expiresAt time.Time
}

// Store is the agent's local dedup table. Safe for concurrent use.
type Store struct {
	mu       sync.Mutex
	entries  map[Key]*entry
	ttl      time.Duration
	maxLease time.Duration
	now      func() time.Time
	stopCh   chan struct{}
	stopOnce sync.Once
}

// NewStore builds a Store whose completed entries are evicted ttl after
// they resolve, and starts a background sweeper (stopped via Close).
func NewStore(ttl time.Duration) *Store {
	s := &Store{
		entries:  make(map[Key]*entry),
		ttl:      ttl,
		maxLease: defaultMaxLease,
		now:      time.Now,
		stopCh:   make(chan struct{}),
	}
	go s.sweepLoop()
	return s
}

// Close stops the background sweeper. Safe to call multiple times.
func (s *Store) Close() {
	s.stopOnce.Do(func() { close(s.stopCh) })
}

func (s *Store) sweepLoop() {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.mu.Lock()
			s.sweepLocked()
			s.mu.Unlock()
		}
	}
}

// Attach registers interest in k. The first caller for a given k (while no
// unexpired entry exists) becomes the leader (isLeader == true) and MUST
// call Resolve(k, ...) exactly once; its returned channel is nil and must
// not be read. Every other caller for the same k - while the leader's work
// is still in flight, or within ttl of its completion - is a follower: it
// receives the leader's Result over the returned channel without causing
// a second invocation.
func (s *Store) Attach(k Key) (resultCh <-chan Result, isLeader bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sweepLocked()

	if e, ok := s.entries[k]; ok {
		ch := make(chan Result, 1)
		if e.resolved {
			ch <- e.result
			close(ch)
		} else {
			go s.forward(e, ch)
		}
		return ch, false
	}

	e := &entry{done: make(chan struct{}), createdAt: s.now()}
	s.entries[k] = e
	return nil, true
}

// forward waits for e to resolve, then delivers its result to ch exactly
// once, without holding the Store's lock.
func (s *Store) forward(e *entry, ch chan Result) {
	<-e.done
	s.mu.Lock()
	res := e.result
	s.mu.Unlock()
	ch <- res
	close(ch)
}

// Resolve is called exactly once by the leader for k, unblocking every
// follower attached to it and starting k's TTL-bounded retention window.
func (s *Store) Resolve(k Key, r Result) {
	s.mu.Lock()
	e, ok := s.entries[k]
	if !ok {
		// Resolve without a prior Attach should not happen in practice;
		// create the entry so the result is still observable for ttl.
		e = &entry{done: make(chan struct{}), createdAt: s.now()}
		s.entries[k] = e
	}
	if e.resolved {
		// Already force-expired by the sweeper (Window: the leader was
		// assumed dead, then actually resolved late). The sweeper's
		// synthetic error result already shipped to every follower that
		// was waiting at that time; do not double-close done.
		s.mu.Unlock()
		return
	}
	e.result = r
	e.resolved = true
	e.expiresAt = s.now().Add(s.ttl)
	close(e.done)
	s.mu.Unlock()
}

// sweepLocked removes resolved entries past their TTL, and force-resolves
// (with an error) entries that have been unresolved for longer than
// maxLease - the leader-crashed case ADR-0008 itself does not cover, since
// its own durable idempotency gate (the interpreter's checkpoint-check)
// operates outside this in-pod store entirely. Must be called with s.mu
// held.
func (s *Store) sweepLocked() {
	now := s.now()
	for k, e := range s.entries {
		switch {
		case e.resolved && now.After(e.expiresAt):
			delete(s.entries, k)
		case !e.resolved && s.maxLease > 0 && now.Sub(e.createdAt) > s.maxLease:
			e.result = Result{Err: fmt.Errorf("dedup: leader for key %+v did not resolve within %s (assumed dead)", k, s.maxLease)}
			e.resolved = true
			close(e.done)
			// Free the key immediately (not TTL-retained) so a fresh
			// Attach can lead again right away rather than waiting out a
			// retention window for a result nobody should trust.
			delete(s.entries, k)
		}
	}
}
