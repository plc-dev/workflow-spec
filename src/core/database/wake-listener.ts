import { Client, type ClientConfig } from "pg";
import { logger } from "../../shared/index.js";
import { EXECUTION_READY_CHANNEL } from "../constants.js";

const LOG_EVENT_WAKE_LISTENER_CONNECTION_ERROR = "core.wakeListener.connection_error";

// Design.md D6 "THE PATTERN": LISTEN/NOTIFY as a low-latency wakeup
// optimization - "the rows ARE the queue, not NOTIFY." A subscriber MUST
// still re-check claimable rows itself; this is a nudge to check sooner,
// never a substitute for the poll loop, and losing a notification (a
// dropped connection, a subscriber that wasn't listening yet) is not a
// correctness bug - the next ordinary poll still finds the row.
//
// `LISTEN` requires one dedicated, long-lived connection - it cannot be a
// transactional `PoolClient` borrowed from `core/database/connection-
// pool.ts`'s pool (that pool's connections are recycled per-transaction).
// This module therefore opens its OWN `pg.Client`, entirely separate from
// `withTransaction`'s pool - the one place other than connection-pool.ts
// this codebase opens a raw connection itself.
export interface WakeListener {
  /** Registers `callback` for every notification on EXECUTION_READY_CHANNEL. Returns an unsubscribe function. */
  onNotify(callback: (payload: string) => void): () => void;
  close(): Promise<void>;
}

export async function createWakeListener(config: ClientConfig = {}): Promise<WakeListener> {
  const client = new Client(config);
  await client.connect();
  await client.query(`LISTEN ${EXECUTION_READY_CHANNEL}`);

  const callbacks = new Set<(payload: string) => void>();
  const handleNotification = (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== EXECUTION_READY_CHANNEL) return;
    for (const callback of callbacks) callback(msg.payload ?? "");
  };
  client.on("notification", handleNotification);

  // A dropped/terminated connection emits an 'error' event on the raw
  // `pg.Client`; Node's default EventEmitter behavior for an 'error'
  // event with zero listeners is to throw, crashing the process. Mirrors
  // `core/database/transactions.ts`'s own swallow-error listener for the
  // same reason, but logged here (not swallowed silently) since this
  // connection is meant to live for the whole process, not one
  // transaction - a subscriber has no other way to learn its
  // notifications have stopped arriving.
  const handleError = (err: Error) => {
    logger.warn({ err }, LOG_EVENT_WAKE_LISTENER_CONNECTION_ERROR);
  };
  client.on("error", handleError);

  return {
    onNotify(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    async close() {
      callbacks.clear();
      client.off("notification", handleNotification);
      client.off("error", handleError);
      await client.end();
    },
  };
}
