import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestPostgres, startTestPostgres } from "../../helpers/postgres.js";

// TC-1 (docs/impl-plans/0001-durable-core.md): applying schema.sql fresh
// produces the tables/constraints/function ADR-0002's consolidated-schema
// contract depends on - a structural precondition for every other test.
describe("core/schema.sql", () => {
  let tp: TestPostgres;

  beforeAll(async () => {
    tp = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await tp.stop();
  });

  it("creates executions, checkpoints, waits, session_log, and session_pointer tables", async () => {
    const result = await tp.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
         ('executions', 'checkpoints', 'waits', 'session_log', 'session_pointer')
       ORDER BY table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      "checkpoints",
      "executions",
      "session_log",
      "session_pointer",
      "waits",
    ]);
  });

  it("enforces the executions.status CHECK constraint", async () => {
    await expect(
      tp.pool.query(
        `INSERT INTO executions (session_id, step, status) VALUES ('s', 'step', 'bogus')`,
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  // TC-1 (docs/impl-plans/0002-durable-sleep.md): the status CHECK now
  // accepts 'waiting', task 6.1b's new execution status.
  it("accepts 'waiting' as an executions.status value", async () => {
    await expect(
      tp.pool.query(
        `INSERT INTO executions (session_id, step, status) VALUES ('s', 'step', 'waiting')`,
      ),
    ).resolves.not.toThrow();
  });

  // TC-1: at least one of wait_key/wake_at is required on a waits row.
  it("enforces the waits CHECK(wait_key IS NOT NULL OR wake_at IS NOT NULL) constraint", async () => {
    const {
      rows: [exec],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step) VALUES ('s', 'step') RETURNING id`,
    );
    await expect(
      tp.pool.query("INSERT INTO waits (execution_id) VALUES ($1)", [exec?.id]),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("exposes signal_wait() as a callable function", async () => {
    const result = await tp.pool.query(`SELECT proname FROM pg_proc WHERE proname = 'signal_wait'`);
    expect(result.rows).toHaveLength(1);
  });

  it("enforces UNIQUE(execution_id, step_id) on checkpoints", async () => {
    const {
      rows: [exec],
    } = await tp.pool.query<{ id: string }>(
      `INSERT INTO executions (session_id, step) VALUES ('s', 'step') RETURNING id`,
    );
    await tp.pool.query(
      `INSERT INTO checkpoints (execution_id, step_id, output) VALUES ($1, 'step-a', '{}')`,
      [exec?.id],
    );
    await expect(
      tp.pool.query(
        `INSERT INTO checkpoints (execution_id, step_id, output) VALUES ($1, 'step-a', '{}')`,
        [exec?.id],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("exposes claim_execution() as a callable function", async () => {
    const result = await tp.pool.query(
      `SELECT proname FROM pg_proc WHERE proname = 'claim_execution'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  // TC-1 (docs/impl-plans/0003-session-log.md): enforces UNIQUE(session_id,
  // sequence) on session_log.
  it("enforces UNIQUE(session_id, sequence) on session_log", async () => {
    await tp.pool.query(
      `INSERT INTO session_log (session_id, sequence, input) VALUES ('s1', 1, '{}')`,
    );
    await expect(
      tp.pool.query(`INSERT INTO session_log (session_id, sequence, input) VALUES ('s1', 1, '{}')`),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  // TC-1: session_pointer.current_sequence can never go negative.
  it("enforces the session_pointer CHECK(current_sequence >= 0) constraint", async () => {
    await expect(
      tp.pool.query(`INSERT INTO session_pointer (session_id, current_sequence) VALUES ('s2', -1)`),
    ).rejects.toThrow(/violates check constraint/);
  });

  // TC-1: session_pointer.session_id is the primary key - one pointer row
  // per session.
  it("enforces session_pointer's PRIMARY KEY(session_id)", async () => {
    await tp.pool.query(`INSERT INTO session_pointer (session_id) VALUES ('s3')`);
    await expect(
      tp.pool.query(`INSERT INTO session_pointer (session_id) VALUES ('s3')`),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
