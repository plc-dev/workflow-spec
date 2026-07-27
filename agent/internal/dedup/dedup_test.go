package dedup

import (
	"sync"
	"testing"
	"time"
)

func TestAttach_singleLeaderNoFollowers(t *testing.T) {
	s := NewStore(time.Minute)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	_, isLeader := s.Attach(k)
	if !isLeader {
		t.Fatal("first Attach for a fresh key should be the leader")
	}
}

func TestAttach_leaderChannelIsNil(t *testing.T) {
	s := NewStore(time.Minute)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	ch, isLeader := s.Attach(k)
	if !isLeader {
		t.Fatal("expected leader")
	}
	if ch != nil {
		t.Error("leader's channel should be nil - the leader must call Resolve directly, never read it")
	}
}

func TestAttach_followerReceivesLeaderResult(t *testing.T) {
	s := NewStore(time.Minute)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	_, isLeader := s.Attach(k)
	if !isLeader {
		t.Fatal("expected leader")
	}

	followerCh, isLeader2 := s.Attach(k)
	if isLeader2 {
		t.Fatal("second Attach for the same in-flight key should be a follower")
	}

	want := Result{Response: "done"}
	s.Resolve(k, want)

	got := <-followerCh
	if got.Response != want.Response {
		t.Errorf("follower got %v, want %v", got.Response, want.Response)
	}
}

// TestAttach_concurrentSameKey is the T7-shaped correctness property: many
// concurrent Attach calls for the identical key produce exactly ONE leader.
func TestAttach_concurrentSameKey(t *testing.T) {
	s := NewStore(time.Minute)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	const n = 50
	var wg sync.WaitGroup
	leaderCount := 0
	var mu sync.Mutex
	followerChans := make([]<-chan Result, 0, n)

	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ch, isLeader := s.Attach(k)
			mu.Lock()
			if isLeader {
				leaderCount++
			} else {
				followerChans = append(followerChans, ch)
			}
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()

	if leaderCount != 1 {
		t.Fatalf("leaderCount = %d, want exactly 1", leaderCount)
	}

	want := Result{Response: "leader-result"}
	s.Resolve(k, want)

	for _, ch := range followerChans {
		got := <-ch
		if got.Response != want.Response {
			t.Errorf("follower got %v, want %v", got.Response, want.Response)
		}
	}
}

func TestAttach_afterResolveWithinTTL_servesFromCache(t *testing.T) {
	s := NewStore(time.Minute)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	_, isLeader := s.Attach(k)
	if !isLeader {
		t.Fatal("expected leader")
	}
	want := Result{Response: "cached"}
	s.Resolve(k, want)

	ch, isLeader2 := s.Attach(k)
	if isLeader2 {
		t.Fatal("Attach shortly after resolve (within TTL) should be a follower served from cache")
	}
	got := <-ch
	if got.Response != want.Response {
		t.Errorf("got %v, want %v", got.Response, want.Response)
	}
}

// TestAttach_afterResolveAndFreshInvocation is T8's shaped property: a new
// Attach for the same key AFTER the previous entry's TTL has expired
// becomes a fresh leader, not a follower stuck on stale cache.
func TestAttach_newLeaderAfterTTLExpiry(t *testing.T) {
	s := NewStore(10 * time.Millisecond)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	_, isLeader := s.Attach(k)
	if !isLeader {
		t.Fatal("expected leader")
	}
	s.Resolve(k, Result{Response: "first"})

	time.Sleep(30 * time.Millisecond)

	_, isLeader2 := s.Attach(k)
	if !isLeader2 {
		t.Fatal("Attach after TTL expiry should be a fresh leader, not a follower")
	}
}

// TestAttach_deadLeaderForceExpiredByMaxLease is the review-driven
// correctness property: if a leader never calls Resolve (crashed goroutine,
// unrecovered panic), followers must NOT block forever - the sweeper force-
// resolves the entry with an error once maxLease elapses, and a subsequent
// Attach becomes a fresh leader rather than staying stuck.
func TestAttach_deadLeaderForceExpiredByMaxLease(t *testing.T) {
	orig := defaultMaxLease
	defaultMaxLease = 20 * time.Millisecond
	defer func() { defaultMaxLease = orig }()

	s := NewStore(time.Minute)
	defer s.Close()
	k := Key{ExecutionID: "e1", StepID: "s1"}

	_, isLeader := s.Attach(k)
	if !isLeader {
		t.Fatal("expected leader")
	}
	// Leader never calls Resolve - simulating a crashed leader goroutine.

	followerCh, isLeader2 := s.Attach(k)
	if isLeader2 {
		t.Fatal("expected follower while the (dead) leader's entry is still fresh")
	}

	select {
	case got := <-followerCh:
		if got.Err == nil {
			t.Error("expected an Err result once maxLease elapsed for a dead leader, got nil Err")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("follower was never unblocked after the dead leader's maxLease elapsed")
	}

	// A fresh Attach should be a new leader immediately - the dead entry
	// was freed, not retained under TTL.
	_, isLeader3 := s.Attach(k)
	if !isLeader3 {
		t.Fatal("expected a fresh leader after the dead entry was force-expired")
	}
}
