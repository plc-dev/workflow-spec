import type { Pool } from "pg";

// Named table-reset helpers for core/'s consolidated schema (ADR-0002) -
// extracted because the same exact TRUNCATE statement was independently
// hand-typed across 13 test files spanning core/, engine/, session/, and
// scheduler/ (a local code review flagged this as duplication/drift risk
// - see docs/impl-plans/0008-shared-database-consolidation.md). Each
// function below mirrors an EXACT pre-existing table list rather than
// widening it, so this is an extraction, not a behavior change - one
// container per test file (ADR-0009) means resetting a superset of
// tables a given file doesn't touch would be harmless anyway, but that
// was deliberately not done here to keep this change a pure dedup.

export async function resetExecutionTables(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE executions, checkpoints, waits RESTART IDENTITY");
}

// The plain-step interpreter's own tables ALONGSIDE executions/checkpoints
// (task 6.2a) - a superset of resetExecutionTables, kept as its own named
// function (not composed from it) since `run_node_outputs`/`workflow_runs`
// need `CASCADE` where `waits` does not.
export async function resetExecutionAndWorkflowRunTables(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE executions, checkpoints, run_node_outputs, workflow_runs RESTART IDENTITY CASCADE",
  );
}

export async function resetWorkflowRunTables(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE executions, run_node_outputs, workflow_runs RESTART IDENTITY CASCADE");
}

export async function resetSessionTables(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE session_log, session_pointer");
}

export async function resetPlacementTables(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE placement, placement_access RESTART IDENTITY");
}

export async function resetPlacementAccessTable(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE placement_access");
}
