# 0003: Session log - `session_log`/`session_pointer` tables + `session/` module (append, rewind, replay)

## Status

`plan-agreed`

## Scope

This package covers tasks **3.1** and **3.10** - the first two, and the
only two, of section 3 ("Session & state layer") that don't depend on
materialization/COW/dataset-catalog machinery that doesn't exist yet:

- **3.1:** Implement durable session input-history log (append-only, per
  session) - evaluate whether this can be built directly on the selected
  engine's own durable execution history (design.md D3 note) rather than
  as separate infrastructure.
- **3.10:** Implement session rewind (pointer movement) with
  truncation-on-new-mutation (design.md D3a).

**Explicitly NOT in scope** (left for future `session/` packages, once
their own prerequisites exist):

- **3.2-3.9** (content-addressed snapshot store, snapshot chain
  construction, COW/full-copy materialization, snapshot GC, rebuild-from-
  history, memoization cache, change-detection wiring) - all of these are
  about the **derived, GC-able snapshot cache** half of D3's diagram, which
  needs `dataset-catalog/` (URN/object-storage, 5.6d) and real service
  dispatch (6.3/6.4, which need the exec-agent, `docs/adr/0008`) to be
  meaningful. This package builds only the **durable source-of-truth**
  half (the log itself), exactly mirroring 0001/0002's own restraint (not
  building `session`/`placement` repos before a consumer existed).
- **3.11** (configurable checkpoint interval for intermediate snapshot
  retention) - this is a snapshot-retention knob (the derived-cache half),
  not a log-retention knob; it has no meaning until 3.2's snapshot chain
  exists.
- Any wiring into `engine/`'s claim/complete/wait dispatch loop, a real
  `apps/worker`, or a DSL-level construct that calls `appendEntry`/
  `rewindSession` - this package is the `core/`+`session/` primitive only,
  the same layer 0001/0002 were built at. `session/` gains its first files
  in this package; nothing yet calls into it.

## Sources

- **design.md D3** ("Sessions are event-sourced; snapshots are a derived,
  GC-able cache"): the durable source of truth for a session is its user
  input history, stored outside the execution/state-cache scope; snapshots
  are a replay-able cache over that history. This package builds exactly
  the source-of-truth half - the log - not the cache half.
- **design.md D3, "Note"**: explicitly asks whether the log can be built
  directly on the selected engine's own durable execution history rather
  than as separate infrastructure, "depending on the execution engine
  eventually selected." Resolved here (see "Open questions" below):
  **no** - `executions`/`checkpoints` are per-step-invocation rows scoped
  to one execution's lifecycle (lease/retry/attempts), not a per-session,
  arbitrary-cardinality sequence of user actions that outlives any single
  execution. A dedicated `session_log` table is needed, consistent with
  ADR-0002's own schema diagram, which already lists `session_log`/
  `session_pointer` as members of the consolidated repo set separate from
  `executions`/`checkpoints`/`waits`.
- **design.md D3a** ("Undo/time-travel is a UX surface over the existing
  log, not a new capability"): decision 1 (linear undo-with-truncation) is
  this package's task 3.10 in full - "a rewind moves the current pointer
  backward; a subsequent new mutation abandons the truncated-off forward
  tail and starts fresh from the rewind point." Decision 2 (checkpoint
  interval as a retention knob) is task 3.11, out of scope here (see
  Scope).
- **ADR-0002**: names `session_log`/`session_pointer` explicitly as two of
  the named members of `core/`'s consolidated `withTransaction(tx) -> {
  ..., sessionLog, ... }` repo set (its own diagram lists them). This
  package is the first to actually build those members, following 0001's
  own precedent (build repos incrementally as a real consumer appears -
  this package IS that consumer, per task 3.1/3.10's own text).
- **ADR-0007**: `session/` is a named top-level module - "snapshot chains,
  COW/full-copy materialization, memoization lookups, rewind (D3/D3a);
  operates over `core/`'s `session_log`/placement/memoization repos." This
  package creates `session/` for the first time, populating only the
  rewind/append/replay slice of that module's eventual scope (the
  snapshot-chain slice is 3.2-3.9, out of scope here) - mirroring how
  `engine/` currently only holds `claim-complete.ts`/`wait.ts`, not yet
  `map`/`retry`/etc.
- **ADR-0009/ADR-0012**: same `core/database/`+`repositories/`+
  `repositories/queries/`+`domain/` shape as `executions`/`checkpoints`/
  `waits`; `session/` gets the same barrel-only, no-abbreviation,
  kebab-case treatment as `engine/`. Real-Postgres-semantics tests (row
  locking, `UNIQUE` constraints) via testcontainers-node, not mocked `pg`.

**Open questions these sources leave unresolved, resolved here as a call
this package makes:**

- **Is `session_log` a genuinely separate table from `executions`/
  `checkpoints`, or should 3.1 reuse them (per D3's own "evaluate"
  clause)?** Resolved: **separate table.** A session (identified by the
  same opaque `session_id` string `executions.session_id` already uses,
  minted elsewhere per D14 - no platform-owned `sessions` table, matching
  the writer-identity precedent of "opaque scoping key, no owned profile
  table") outlives any single execution and accumulates an
  arbitrary-cardinality sequence of user actions, each of which may
  trigger zero, one, or many executions. Folding that sequence into
  `executions` (scoped to one step invocation's lease/retry lifecycle)
  would conflate two different entities with two different lifecycles.
  This is not a new judgment call so much as a confirmation of what
  ADR-0002's own schema diagram, and 0001/0002's own `schema.sql` header
  comments ("`session_log`/`session_pointer` (D3) - belongs to a future
  `session/` package"), already assumed.
- **What does `session_pointer.current_sequence = 0` (no entries yet)
  mean, and how is a session's pointer row created?** Not specified
  anywhere - resolved: a session has no `session_pointer` row until its
  first `appendEntry` call, which creates one (via `INSERT ... ON CONFLICT
  DO NOTHING`) before locking it, exactly mirroring `waitFor`'s "acts, no
  pre-existing setup required" posture. `current_sequence = 0` means "no
  entries appended yet" (sequence numbers start at 1), so a freshly
  created pointer and a pointer for a session with zero entries are
  indistinguishable - which is correct, since there is nothing to
  distinguish them by.
- **Does rewind delete the abandoned forward tail immediately, or defer
  deletion to the next append?** D3a's own text says "a subsequent new
  mutation abandons the truncated-off forward tail" - the abandonment is
  described as happening on the *next mutation*, not at rewind time.
  Resolved: **deferred to the next append**, taken literally from D3a's
  own wording, not as an optimization choice made independently here. A
  `rewindSession` call only moves `session_pointer.current_sequence`
  backward; the rows past that point remain in `session_log`, inert,
  until either (a) a new `appendEntry` call deletes them as its first
  step, or (b) nothing ever appends again and they simply sit unused. This
  also means a rewind is trivially reversible (rewind forward again,
  before any new append) with no data loss - a UX property D3a doesn't
  require but doesn't forbid either, and falls out for free from taking
  D3a's wording literally rather than deleting eagerly.
- **Locking discipline for `appendEntry`/`rewindSession`.** Neither
  operation has the "broadcast to many" shape `signal_wait()` has - each
  operates on exactly one session's `session_pointer` row. Resolved:
  ordinary blocking `SELECT ... FOR UPDATE` on that one row (not `SKIP
  LOCKED` - a second concurrent mutation for the SAME session must wait
  its turn and apply on top of the first, never skip/silently drop a
  user's action; this is D3's own "linear-per-session-mutation" guarantee,
  the same property spike 1.2 already validated for `executions` at a
  different layer). Concurrent mutations for *different* sessions lock
  different rows and proceed independently - no cross-session contention
  introduced by this design.

## Plan

### File/module layout

```
src/core/
  database/
    schema.sql                      (extended) - session_log, session_pointer
                                     tables
  domain/
    session-log-entry.ts             (new) SessionLogEntry type
    session-pointer.ts               (new) SessionPointer type
    rows.ts                          (extended) + SessionLogEntryRow, SessionPointerRow
    mappers.ts                       (extended) + mapSessionLogEntryRow, mapSessionPointerRow
    index.ts                         (extended) barrel
  repositories/
    session-log.repository.ts        (new) SessionLogRepo: append(), deleteAfter(),
                                      listBySession()
    session-pointer.repository.ts    (new) SessionPointerRepo: lock(), setSequence()
    queries/
      session-log.queries.ts          (new) SQL_INSERT_SESSION_LOG_ENTRY,
                                       SQL_DELETE_SESSION_LOG_ENTRIES_AFTER_SEQUENCE,
                                       SQL_FIND_SESSION_LOG_ENTRIES_BY_SESSION
      session-pointer.queries.ts       (new) SQL_ENSURE_SESSION_POINTER,
                                       SQL_LOCK_SESSION_POINTER,
                                       SQL_SET_SESSION_POINTER_SEQUENCE
    database/transactions.ts          (extended) CoreRepos gains
                                       `sessionLog: SessionLogRepo`,
                                       `sessionPointer: SessionPointerRepo`
  index.ts                            (extended) barrel - export SessionLogEntry,
                                       SessionPointer, SessionLogRepo, SessionPointerRepo

src/session/                          (NEW top-level module - ADR-0007 - first content)
  index.ts                            (new) barrel
  session-log.ts                      (new) appendEntry(), rewindSession(), replaySession()

src/shared/errors.ts                  (extended) + new ERROR_IDS/DEFAULT_ERROR_MESSAGES
                                       entries (session-log-no-row-returned,
                                       session-pointer-no-row-returned,
                                       session-rewind-target-out-of-range)

test/
  core/database/schema.test.ts                          (extended) - session_log/
                                                          session_pointer table+constraint
                                                          assertions
  core/repositories/session-log.repository.test.ts       (new)
  core/repositories/session-pointer.repository.test.ts   (new)
  session/session-log.test.ts                            (new) - appendEntry/
                                                          rewindSession/replaySession
                                                          composed together; concurrency
                                                          and crash tests
```

### Interfaces (signatures)

```ts
// src/core/domain/session-log-entry.ts
export interface SessionLogEntry {
  id: number;
  sessionId: string;
  sequence: number;
  input: unknown;
  createdAt: Date;
}

// src/core/domain/session-pointer.ts
export interface SessionPointer {
  sessionId: string;
  currentSequence: number;
  updatedAt: Date;
}

// src/core/repositories/session-log.repository.ts
export interface SessionLogRepo {
  append(input: { sessionId: string; sequence: number; input: unknown }): Promise<SessionLogEntry>;
  // Deletes every session_log row for sessionId with sequence > afterSequence
  // (the abandoned forward tail left by a prior rewind). A no-op if nothing
  // is past afterSequence.
  deleteAfter(sessionId: string, afterSequence: number): Promise<void>;
  // Ordered by sequence ascending - the replay order.
  listBySession(sessionId: string): Promise<SessionLogEntry[]>;
}

// src/core/repositories/session-pointer.repository.ts
export interface SessionPointerRepo {
  // Ensures a pointer row exists for sessionId (current_sequence = 0 if
  // newly created), then locks and returns it via SELECT ... FOR UPDATE -
  // the caller holds this lock for the rest of its transaction, serializing
  // every mutation/rewind for this one session (design.md D3).
  lock(sessionId: string): Promise<SessionPointer>;
  setSequence(sessionId: string, sequence: number): Promise<SessionPointer>;
}

// src/core/database/transactions.ts (extended)
export interface CoreRepos {
  executions: ExecutionsRepo;
  checkpoints: CheckpointsRepo;
  waits: WaitsRepo;
  sessionLog: SessionLogRepo;
  sessionPointer: SessionPointerRepo;
  client: PoolClient;
}

// src/session/session-log.ts
// Appends one user-input entry to sessionId's durable log. If the session
// was previously rewound (its pointer's current_sequence is behind the
// log's own max sequence), the abandoned forward tail is deleted FIRST, in
// the SAME transaction as the new insert and pointer advance (design.md
// D3a: "a subsequent new mutation abandons the truncated-off forward
// tail").
export function appendEntry(
  repos: CoreRepos,
  sessionId: string,
  input: unknown,
): Promise<SessionLogEntry>;

// Moves sessionId's pointer backward to targetSequence (0 <= targetSequence
// <= current). Does NOT delete any session_log rows - deletion is deferred
// to the next appendEntry call, per D3a's own wording. Throws FatalError
// (SESSION_REWIND_TARGET_OUT_OF_RANGE) if targetSequence is negative or
// ahead of the current pointer.
export function rewindSession(
  repos: CoreRepos,
  sessionId: string,
  targetSequence: number,
): Promise<SessionPointer>;

// Returns every entry currently reachable from sessionId's pointer (i.e.
// listBySession's full result - nothing beyond current_sequence is ever
// returned as "current" once a future package's snapshot-rebuild path
// (3.7) needs to distinguish live from abandoned-but-not-yet-deleted rows;
// this package has no abandoned rows to hide since deleteAfter always runs
// before this could observe one).
export function replaySession(
  repos: CoreRepos,
  sessionId: string,
): Promise<SessionLogEntry[]>;
```

### Data flow

```ts
// A new user action arrives for a session:
await withTransaction(pool, async (repos) => {
  const entry = await appendEntry(repos, sessionId, { type: "run-query", sql: "..." });
  // entry.sequence is 1 for a brand-new session, or currentSequence+1
  // otherwise. If this session had been rewound earlier, any log rows past
  // the old currentSequence are gone before this entry is inserted.
});

// A rewind (undo) request:
await withTransaction(pool, async (repos) => {
  const pointer = await rewindSession(repos, sessionId, targetSequence);
  // pointer.currentSequence === targetSequence. session_log rows past this
  // point still physically exist - inert until the next appendEntry (or
  // forever, if none ever comes).
});

// Rebuilding a session's current state (future 3.7 will drive this; this
// package only proves replaySession itself is correct):
const history = await withTransaction(pool, (repos) => replaySession(repos, sessionId));
// history.length === pointer.currentSequence, ordered by sequence ascending.
```

`session_pointer`'s row lock is the sole serialization point - two
concurrent `appendEntry`/`rewindSession` calls for the SAME `sessionId`
queue behind each other (one succeeds, commits, releases the lock; the
next proceeds against the now-current state), exactly mirroring
`claim_execution()`'s existing "some other worker already has it, wait or
move on" discipline, but with blocking `FOR UPDATE` (matching
`signal_wait()`'s choice, not `claim_execution()`'s `SKIP LOCKED` - a
second mutation for this session must apply, never silently no-op).

### Sequencing rationale

- **Why now:** 3.1/3.10 are the only two of section 3's eleven tasks that
  don't depend on materialization/COW/dataset-catalog machinery which
  doesn't exist yet (3.2-3.9) or on a snapshot chain that doesn't exist yet
  (3.11). They depend on nothing beyond what 0001/0002 already landed
  (`core/database/{connection-pool,transactions}.ts`, the
  `withTransaction`/`CoreRepos` pattern), making this the natural next
  slice of `core/`'s schema evolution - the third package to extend
  `schema.sql` incrementally (0001: `executions`/`checkpoints`; 0002:
  `waits`; this package: `session_log`/`session_pointer`) rather than a
  detour into an unrelated area.
- **What it depends on:** 0001's `core/database/{connection-pool,
  transactions}.ts` and the `withTransaction(pool, fn) -> CoreRepos`
  pattern; no dependency on `engine/`'s `claimExecution`/`completeExecution`/
  `waitFor`/`signalWait` - this package's primitives are independent of the
  execution-dispatch primitives, composed only via sharing the same
  `CoreRepos`/transaction shape.
- **What it unblocks:** the eventual snapshot chain (3.2-3.9), which needs
  a durable, replayable input history to rebuild a GC'd snapshot from
  (design.md D3's own "derived cache over the log" framing;
  `replaySession` is this package's concrete answer to "how does a future
  rebuild-from-history path get the history"); task 6.5
  (session-as-long-running-execution) and end-to-end tests 8.2/8.10, which
  need a real session log/pointer to assert isolation and rewind-then-
  truncate behavior against.
- **What it deliberately does NOT unblock yet:** 3.2 (content-addressed
  snapshot store) is not started by this package - it needs
  `dataset-catalog/`'s URN/object-storage machinery (5.6d), which doesn't
  exist. This package is additive groundwork for 3.2, not a hard
  prerequisite that blocks 3.2 from being scoped independently later.

## Test design

Not collapsed with Phase 1 - this package extends `core/schema.sql` (a
foundational file shared by every future consumer) and introduces a
genuinely new concurrency/correctness shape (per-session serialization via
a dedicated pointer-row lock, and deferred-truncation-on-rewind) that
neither 0001 nor 0002 tested. Same posture as both of those packages' own
test-design sections.

### Setup: default Vitest + testcontainers-node is sufficient

Every test below depends on real transaction/locking/constraint semantics
(`SELECT ... FOR UPDATE`, a `UNIQUE (session_id, sequence)` constraint
racing against concurrent inserts, multi-statement atomicity across a
`DELETE`+`INSERT`+`UPDATE` sequence) that ADR-0009 already names as
requiring a real Postgres instance, not a mock. No new stakes beyond that:

- **No dedicated load/scale test.** This package doesn't reopen 1.2e's
  scale claim. `appendEntry`/`rewindSession` each lock exactly one
  `session_pointer` row (one session at a time) - there is no
  broadcast-to-many shape like `signal_wait()`'s, and no claim-loop hot
  path like `claim_execution()`'s. TC-4/TC-5 below exercise concurrency at
  small cardinality purely to prove the *correctness* properties (no lost
  writes within a session, no cross-session contention), not to measure
  throughput.
- **testcontainers-node** for every test case - real lock/constraint/
  multi-statement-atomicity semantics throughout, including the two crash
  tests (TC-10/TC-11), which need `pg_terminate_backend` against a real
  backend, exactly as 0001/0002 already did.

### Test cases

| # | Test | Scope item | Correctness property verified |
|---|---|---|---|
| TC-1 | Apply extended `schema.sql`; assert `session_log` exists with its columns, `UNIQUE (session_id, sequence)`, and its index, and `session_pointer` exists with its `PRIMARY KEY (session_id)` and `CHECK (current_sequence >= 0)` | `core/schema.sql` | ADR-0002 (core owns the schema) - structural precondition for every test below |
| TC-2 | `appendEntry` on a session with no prior `session_pointer` row; assert a pointer row is created, the first entry gets `sequence = 1`, and `pointer.currentSequence === 1` | `session.appendEntry`, `SessionPointerRepo.lock` (create-if-missing) | this package's resolved open question ("how a session's pointer row is lazily created") - design.md D3's log must be usable from a session's very first action with no separate provisioning step |
| TC-3 | `appendEntry` called N times sequentially for one session; assert sequences are exactly `1..N` with no gaps, and `replaySession` returns them ordered ascending by sequence | `session.appendEntry`, `session.replaySession`, `SessionLogRepo.listBySession` | design.md D3 - the log is an ordered, append-only sequence of user actions, replayable in original order |
| TC-4 | `appendEntry` M times concurrently for the SAME `sessionId` (separate transactions/connections); assert the M resulting entries have exactly the sequences `1..M`, no duplicates, no gaps, and no entry is lost | `session.appendEntry`, `SessionPointerRepo.lock`'s `FOR UPDATE` | design.md D3 "linear-per-session-mutation" guarantee under concurrency - the same property spike 1.2 validated for `executions`, now proven at this new `session_log`/`session_pointer` layer |
| TC-5 | `appendEntry` concurrently for TWO DIFFERENT `sessionId`s, interleaved; assert each session's own sequence is exactly `1..N` for that session with correct per-session content, and neither session's writes observe or block on the other's lock | `session.appendEntry` | design.md D3's diagram - session chains "diverge from shared immutable roots and never need to merge"; concurrency across sessions must not serialize through a shared lock |
| TC-6 | `rewindSession` to an earlier sequence; assert `pointer.currentSequence` updates to the target, and every `session_log` row past that point still physically exists, unmodified, immediately after the rewind call returns | `session.rewindSession` | design.md D3a decision 1, taken literally - rewind is pointer movement only; deletion is deferred to the next mutation, not performed at rewind time |
| TC-7 | Append 3 entries (sequences 1-3), `rewindSession` to sequence 1, then `appendEntry` again; assert the new entry gets `sequence = 2` (reusing the abandoned number), the old sequence-2 and sequence-3 rows are gone, and no `UNIQUE (session_id, sequence)` violation occurs | `session.appendEntry`'s truncate-then-insert step, `SessionLogRepo.deleteAfter` | design.md D3a decision 1 in full - "a subsequent new mutation abandons the truncated-off forward tail and starts fresh from the rewind point" |
| TC-8 | `rewindSession` with `targetSequence` negative, and separately with `targetSequence` greater than the current pointer; assert both throw `FatalError` (`SESSION_REWIND_TARGET_OUT_OF_RANGE`) and the pointer is left completely unchanged in both cases | `session.rewindSession`'s validation | this package's own resolved validation rule - a rewind is bounded to `[0, currentSequence]`; D3a's "moves the current pointer backward" is meaningless without this bound enforced |
| TC-9 | `rewindSession` with `targetSequence` equal to the CURRENT sequence (a no-op rewind); assert the pointer's `currentSequence`/`updatedAt` are unchanged and no `session_log` rows are affected | `session.rewindSession` | edge case of D3a decision 1 - rewinding to "now" must be a safe no-op, not an error and not a spurious truncation |
| TC-10 | Inside `withTransaction`, call `appendEntry` for a session with no prior entries, then `pg_terminate_backend` the connection before COMMIT; assert no `session_log` row and no `session_pointer` row exist afterward (both roll back together) | `session.appendEntry` | design.md D6/R6 (DEEP atomicity) applied to this new primitive - a mid-transaction crash rolls back the insert AND the pointer creation/advance as one unit, not a partial write |
| TC-11 | Append 2 entries, `rewindSession` to sequence 1 (leaving sequence 2 abandoned-but-present per TC-6), then inside a new transaction call `appendEntry` and `pg_terminate_backend` the connection after its internal `deleteAfter` step but before COMMIT; assert the old sequence-2 row STILL exists afterward (the delete rolled back) and the pointer is still at sequence 1 | `session.appendEntry`'s truncate-then-insert step | design.md D6/R6 (DEEP atomicity) applied to the truncate+insert+advance sequence specifically - a crash mid-truncation must not leave the log in a state with a deleted tail but no replacement entry, or vice versa |

`SessionPointerRepo.setSequence` and `SessionLogRepo.deleteAfter`'s
no-op-when-nothing-to-delete case have no dedicated test case each - both
are exercised as direct consequences of TC-2/TC-3/TC-6/TC-7/TC-9's own
assertions (checking `session_pointer`/`session_log` state directly),
sufficient given neither has branching logic of its own beyond what those
cases already drive.

## Implementation notes

_To be completed in Phase 3._

## Review notes

_To be completed in Phase 4._
