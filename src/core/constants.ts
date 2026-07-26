// Shared, named constants for `core/` - avoids the same magic number/string
// being repeated (and risking drift) across repositories/callers.

// Mirrors `core/schema.sql`'s `claim_execution(p_worker_id, p_lease_seconds
// INT DEFAULT 30)` SQL-level default. The two can't literally share a
// single source (one lives in SQL, one in TypeScript) - keep them in sync
// by hand if either changes; this constant is the TypeScript-side default
// so ExecutionsRepo.claim's own default isn't a bare `30` with no name.
export const DEFAULT_LEASE_SECONDS = 30;

// Mirrors `core/schema.sql`'s `signal_wait()` function, which
// `PERFORM pg_notify('execution_ready', p_wait_key)`s on every call - the
// two must be kept in sync by hand, same posture as DEFAULT_LEASE_SECONDS
// above. No `wfx`/app-name prefix (docs/impl-plans/0002-durable-sleep.md):
// every other schema object (`executions`, `claim_execution()`) is already
// unprefixed, and there is exactly one Postgres database/schema in play
// here (ADR-0002), so no object needs an application-name prefix to
// disambiguate it from anyone else's.
export const EXECUTION_READY_CHANNEL = "execution_ready";

// Mirrors `core/schema.sql`'s `waits` table CHECK(wait_key IS NULL OR
// length(wait_key) <= 256) - kept in sync by hand, same posture as
// DEFAULT_LEASE_SECONDS above. signal_wait() passes wait_key straight
// into pg_notify(), whose payload is hard-capped at 8000 bytes by
// Postgres itself; this limit is set well under that ceiling so
// WaitsRepo.create can reject an oversized key up front with a clear,
// structured error, rather than letting an eventual signal_wait() call
// abort entirely (rolling back every other wait it was about to satisfy)
// the first time someone tries to signal it.
export const WAIT_KEY_MAX_LENGTH = 256;
