// Lightweight polling monitor for the load/scale check (task 1.2e).
// Samples pg_stat_activity (connection count, lock waits) and
// pg_stat_user_tables (dead-tuple/update churn, autovacuum activity) on an
// interval, so test-load.js can report peak/aggregate numbers rather than
// just a single before/after snapshot.

export function startMonitor(pool, { intervalMs = 250 } = {}) {
  const samples = {
    maxConnections: 0,
    maxLockWaiters: 0,
    connectionSamples: [],
    lockWaiterSamples: [],
  };

  const timer = setInterval(async () => {
    try {
      const { rows } = await pool.query(`
        SELECT
          count(*)::int AS total_backends,
          count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiters
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);
      const { total_backends, lock_waiters } = rows[0];
      samples.connectionSamples.push(total_backends);
      samples.lockWaiterSamples.push(lock_waiters);
      samples.maxConnections = Math.max(samples.maxConnections, total_backends);
      samples.maxLockWaiters = Math.max(samples.maxLockWaiters, lock_waiters);
    } catch {
      /* pool may be draining at shutdown - ignore sampling errors */
    }
  }, intervalMs);

  return {
    samples,
    async stop() {
      clearInterval(timer);
    },
  };
}

export async function tableChurnStats(pool, schemaTable) {
  const [schema, table] = schemaTable.split(".");
  const { rows } = await pool.query(
    `SELECT n_tup_upd, n_tup_ins, n_dead_tup, n_live_tup, last_autovacuum, last_vacuum, autovacuum_count, vacuum_count
     FROM pg_stat_user_tables
     WHERE schemaname = $1 AND relname = $2`,
    [schema, table]
  );
  return rows[0] ?? null;
}
