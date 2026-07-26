import type { CoreRepos, SessionLogEntry, SessionPointer } from "../core/index.js";
import { ERROR_IDS, FatalError, logger } from "../shared/index.js";

// ADR-0002/ADR-0007: mirrors engine/wait.ts's shape - these primitives
// operate on a `CoreRepos` already bound to an open transaction, never
// opening a connection of their own. `session/` is a new top-level module
// (this package is its first content) - only the append/rewind/replay
// slice of its eventual scope (docs/impl-plans/0003-session-log.md); the
// snapshot-chain slice (design.md D3's derived-cache half) is future work.

const LOG_EVENT_APPEND_ENTRY = "session.appendEntry";
const LOG_EVENT_REWIND_SESSION = "session.rewindSession";

// The durable source of truth for a session (design.md D3): appends one
// user-input entry, in the SAME transaction as (a) deleting any abandoned
// forward tail left by a prior rewind, and (b) advancing the pointer -
// design.md D3a: "a subsequent new mutation abandons the truncated-off
// forward tail and starts fresh from the rewind point." `lock()` also
// creates the pointer row on a session's very first call, and its
// FOR UPDATE hold serializes concurrent appends/rewinds for this one
// session (D3's linear-per-session-mutation guarantee).
export async function appendEntry(
  repos: CoreRepos,
  sessionId: string,
  input: unknown,
): Promise<SessionLogEntry> {
  const pointer = await repos.sessionPointer.lock(sessionId);
  await repos.sessionLog.deleteAfter(sessionId, pointer.currentSequence);
  const nextSequence = pointer.currentSequence + 1;
  const entry = await repos.sessionLog.append({ sessionId, sequence: nextSequence, input });
  await repos.sessionPointer.setSequence(sessionId, nextSequence);
  logger.debug({ sessionId, sequence: nextSequence }, LOG_EVENT_APPEND_ENTRY);
  return entry;
}

// design.md D3a decision 1: moves sessionId's pointer backward to
// targetSequence. Does NOT delete any session_log rows - deletion is
// deferred to the next appendEntry call, per D3a's own wording ("a
// subsequent new mutation abandons..."), not performed here.
export async function rewindSession(
  repos: CoreRepos,
  sessionId: string,
  targetSequence: number,
): Promise<SessionPointer> {
  const pointer = await repos.sessionPointer.lock(sessionId);
  if (targetSequence < 0 || targetSequence > pointer.currentSequence) {
    throw new FatalError(ERROR_IDS.SESSION_REWIND_TARGET_OUT_OF_RANGE, {
      context: { sessionId, targetSequence, currentSequence: pointer.currentSequence },
    });
  }
  if (targetSequence === pointer.currentSequence) {
    // Safe no-op - nothing to move, nothing to log as a state change.
    return pointer;
  }
  const updated = await repos.sessionPointer.setSequence(sessionId, targetSequence);
  logger.debug(
    { sessionId, fromSequence: pointer.currentSequence, toSequence: targetSequence },
    LOG_EVENT_REWIND_SESSION,
  );
  return updated;
}

// Every entry currently REACHABLE from sessionId's pointer, in replay
// order (design.md D3). Deliberately excludes any abandoned tail a prior
// rewind hasn't been truncated yet (design.md D3a - deletion is deferred
// to the next appendEntry, so those rows can still physically exist here)
// - see SessionLogRepo.listLive. A future rebuild-from-history path (task
// 3.7) is this function's eventual consumer - this package only proves it
// is correct standalone.
export function replaySession(repos: CoreRepos, sessionId: string): Promise<SessionLogEntry[]> {
  return repos.sessionLog.listLive(sessionId);
}
