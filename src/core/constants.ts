// Shared, named constants for `core/` - avoids the same magic number/string
// being repeated (and risking drift) across repositories/callers.

// Mirrors `core/schema.sql`'s `claim_execution(p_worker_id, p_lease_seconds
// INT DEFAULT 30)` SQL-level default. The two can't literally share a
// single source (one lives in SQL, one in TypeScript) - keep them in sync
// by hand if either changes; this constant is the TypeScript-side default
// so ExecutionsRepo.claim's own default isn't a bare `30` with no name.
export const DEFAULT_LEASE_SECONDS = 30;
