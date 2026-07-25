// placement-resolver: the bespoke Postgres-resident placement resolver
// (task 1.10, formalizing spike 1.2's minimal `placement` table).
//
// Design stance, straight from design.md D4/D4a/D5a:
//
//   * Affinity is ALWAYS an optimization. A resolver miss is NEVER an error -
//     it just means "no warm replica, rehydrate anywhere" (D4). resolvePlacement
//     therefore returns a found:false fact, it does not throw.
//
//   * Promotion/demotion thresholds are a cache-admission model with TUNABLE
//     parameters (D4a), not hardcoded constants. Every function that needs a
//     threshold takes a `config` object (see DEFAULT_CONFIG / loadConfig).
//
//   * DECISION and ACTION are separated. evaluatePromotion/evaluateDemotion are
//     PURE-ish reads that return a decision object; they never mutate residency
//     state. promote()/demote() are the explicit state-mutating actions.
//
//   * TRUST is not enforced here. This module returns placement FACTS. It is the
//     CALLER's job (design.md D5a / task 4.7) to gate any actual sharing/pooling/
//     COW-reuse on trust tier. isTrustEligibleForOptimization() is provided so
//     that gate is easy and obvious to wire in, and hard to skip by accident.
//
// Transaction discipline: every write function accepts an `exec` (a pg Client
// or Pool - anything with .query) so the CALLER controls the transaction
// boundary. recordAccess is specifically designed to be called INSIDE the same
// transaction as a session-log / durability-core write, mirroring spike 1.2.

// --------------------------------------------------------------------------
// Trust tiers (design.md D5a). The registry component (task 2.x, 2.8) owns the
// authoritative source via getPlacementFacts(digest, functionName). This module
// only needs the resulting tier string.
// --------------------------------------------------------------------------

export const TRUST_TIERS = Object.freeze({
  UNVERIFIED: "unverified",
  CONFORMANCE_PASSED: "conformance-passed",
  PRODUCTION_PROVEN: "production-proven",
});

/**
 * The single gate that decides whether the scheduler may LEAN ON a capability
 * declaration (share / pool / COW-reuse). Per D5a the scheduler must never do
 * so below `production-proven`.
 *
 * This resolver does not call it internally - it returns facts. The caller
 * (task 4.7) must call this before treating a resolved warm replica as safe to
 * actually share/pool/reuse. It lives here so the correct wiring is one obvious
 * import away.
 */
export function isTrustEligibleForOptimization(trustTier) {
  return trustTier === TRUST_TIERS.PRODUCTION_PROVEN;
}

/**
 * STUB for the registry's atomic placement-facts read (task 2.8,
 * `getPlacementFacts(digest, function)` returning capability metadata, trust
 * tier, and hardware requirements together).
 *
 * If registry/ exists by build time, replace this with a real import of the
 * registry's getPlacementFacts. Until then this stub keeps the resolver
 * usable/testable standalone. It is intentionally NOT called by any function in
 * this module - the trust tier is an INPUT the caller supplies.
 */
export async function getPlacementFactsStub(/* digest, functionName */) {
  throw new Error(
    "getPlacementFactsStub: not implemented - back this with the registry's " +
      "getPlacementFacts(digest, function) (task 2.8). The resolver expects the " +
      "trust tier to be supplied by the caller, not fetched here."
  );
}

// --------------------------------------------------------------------------
// Config (D4a tunable parameters).
// --------------------------------------------------------------------------

// In-code mirror of the seeded `placement.placement_config` 'default' row.
// Kept here only as a fallback / documentation; the authoritative defaults
// live in schema.sql as DATA. Callers may pass any subset-overridden object.
export const DEFAULT_CONFIG = Object.freeze({
  promotion: {
    frequencyThreshold: 3, // >= N accesses ...
    frequencyWindowMs: 7 * 60 * 1000, // ... within this rolling window (5-10 min)
    rehydrationCostThresholdMs: 250, // cost must exceed this to be worth pinning
  },
  demotion: {
    // DELIBERATELY higher than promotion.frequencyWindowMs -> hysteresis.
    idleThresholdMs: 20 * 60 * 1000,
  },
  capacity: {
    pinnedBudgetBytes: 1024 * 1024 * 1024, // 1 GiB pinned-pool budget
  },
  cost: {
    observedMinSamples: 5, // switch to observed avg once this many samples seen
    classPriorsMs: {
      trivial: 10,
      cheap: 50,
      moderate: 300,
      expensive: 2000,
    },
  },
});

/**
 * Load a named tunable-parameter profile from the placement_config table.
 * Returns a plain config object. Falls back to DEFAULT_CONFIG if absent.
 */
export async function loadConfig(exec, name = "default") {
  const { rows } = await exec.query(
    `SELECT config FROM placement.placement_config WHERE name = $1`,
    [name]
  );
  if (rows.length === 0) return DEFAULT_CONFIG;
  return rows[0].config;
}

// --------------------------------------------------------------------------
// Cost model (D4a: declared prior -> observed average).
// --------------------------------------------------------------------------

/**
 * Resolve the effective rehydration cost (ms) for a placement row, applying
 * D4a's authority rule:
 *   - if we have >= cost.observedMinSamples real timings, the observed rolling
 *     average is AUTHORITATIVE;
 *   - otherwise fall back to the declared materialization-cost-class PRIOR;
 *   - if neither is available, cost is unknown (returns { costMs: null }).
 */
export function effectiveRehydrationCostMs(row, config) {
  const cost = config.cost ?? DEFAULT_CONFIG.cost;
  const haveEnoughSamples =
    row.observed_rehydration_ms != null &&
    Number(row.observed_sample_count) >= cost.observedMinSamples;

  if (haveEnoughSamples) {
    return { costMs: Number(row.observed_rehydration_ms), source: "observed" };
  }
  if (row.declared_cost_class && cost.classPriorsMs[row.declared_cost_class] != null) {
    return { costMs: cost.classPriorsMs[row.declared_cost_class], source: "declared-prior" };
  }
  return { costMs: null, source: "unknown" };
}

// --------------------------------------------------------------------------
// Read path.
// --------------------------------------------------------------------------

/**
 * resolvePlacement - the read path (D4). Given a content hash, return the
 * current placement fact. A miss is NOT an error: callers use `found`/`warm`
 * to decide whether to prefer a warm replica or fall back to rehydrate-anywhere.
 *
 * `exec` may be a Pool or a Client.
 */
export async function resolvePlacement(exec, contentHash) {
  const { rows } = await exec.query(
    `SELECT * FROM placement.placement WHERE content_hash = $1`,
    [contentHash]
  );

  if (rows.length === 0) {
    return {
      found: false,
      warm: false,
      contentHash,
      replicaId: null,
      reason: "no-placement",
    };
  }

  const r = rows[0];
  return {
    found: true,
    // "warm" == there is a live replica we could prefer. A row with a null
    // replica_id is a tracked-but-cold fact (e.g. demoted/evicted): still a
    // miss for affinity purposes.
    warm: r.replica_id != null,
    contentHash: r.content_hash,
    replicaId: r.replica_id,
    sessionId: r.session_id,
    pinned: r.pinned,
    interactivity: r.interactivity,
    accessCount: Number(r.access_count),
    lastAccessedAt: r.last_accessed_at,
    sizeBytes: Number(r.size_bytes),
    declaredCostClass: r.declared_cost_class,
    observedRehydrationMs:
      r.observed_rehydration_ms == null ? null : Number(r.observed_rehydration_ms),
    observedSampleCount: Number(r.observed_sample_count),
    reason: r.replica_id != null ? "warm-replica" : "cold-fact",
  };
}

// --------------------------------------------------------------------------
// Write path.
// --------------------------------------------------------------------------

/**
 * recordAccess - upsert a placement row and record one access against it.
 *
 * MUST be called with a caller-owned `exec` (Client) so it can share the SAME
 * transaction as a session-log / durability-core write (spike 1.2's DEEP
 * consolidation pattern). It does not BEGIN/COMMIT.
 *
 * opts:
 *   replicaId            - warm replica for this hash (optional)
 *   sessionId            - session scope, null for static/shared (optional)
 *   interactivity        - 'interactive' | 'batch' (declared intent)
 *   sizeBytes            - observed snapshot size (optional)
 *   declaredCostClass    - D5 materialization-cost class prior (optional)
 *   observedRehydrationMs- one real rehydration timing to fold into the
 *                          rolling average (optional)
 *   at                   - access timestamp (optional; defaults to now()).
 *                          Exposed mainly so tests can simulate elapsed time.
 *   config               - used only to bound access-log pruning (optional)
 */
export async function recordAccess(exec, contentHash, opts = {}) {
  const {
    replicaId = null,
    sessionId = null,
    interactivity = null,
    sizeBytes = null,
    declaredCostClass = null,
    observedRehydrationMs = null,
    at = null,
    config = DEFAULT_CONFIG,
  } = opts;

  const ts = at ? new Date(at).toISOString() : null; // null -> SQL now()

  // Upsert the placement row. COALESCE lets a first-seen insert set fields
  // while subsequent accesses only override the fields the caller supplies
  // (passing null leaves the existing value intact) - except access bookkeeping,
  // which always advances.
  await exec.query(
    `
    INSERT INTO placement.placement (
      content_hash, replica_id, session_id, interactivity,
      access_count, first_accessed_at, last_accessed_at,
      declared_cost_class, size_bytes,
      observed_rehydration_ms, observed_sample_count,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, COALESCE($4, 'batch'),
      1, COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()),
      $5, COALESCE($6, 0),
      $8::double precision, CASE WHEN $8::double precision IS NULL THEN 0 ELSE 1 END,
      now(), now()
    )
    ON CONFLICT (content_hash) DO UPDATE SET
      replica_id        = COALESCE($2, placement.placement.replica_id),
      session_id        = COALESCE($3, placement.placement.session_id),
      interactivity     = COALESCE($4, placement.placement.interactivity),
      access_count      = placement.placement.access_count + 1,
      last_accessed_at  = COALESCE($7::timestamptz, now()),
      declared_cost_class = COALESCE($5, placement.placement.declared_cost_class),
      size_bytes        = COALESCE($6, placement.placement.size_bytes),
      -- Incremental rolling mean of observed rehydration timings:
      --   new_avg = (old_avg*n + sample) / (n+1)
      -- Only advances when a new sample ($8::double precision) is supplied.
      observed_rehydration_ms = CASE
        WHEN $8::double precision IS NULL THEN placement.placement.observed_rehydration_ms
        WHEN placement.placement.observed_rehydration_ms IS NULL THEN $8::double precision
        ELSE (placement.placement.observed_rehydration_ms
                * placement.placement.observed_sample_count + $8::double precision)
             / (placement.placement.observed_sample_count + 1)
      END,
      observed_sample_count = placement.placement.observed_sample_count
        + CASE WHEN $8::double precision IS NULL THEN 0 ELSE 1 END,
      updated_at        = now()
    `,
    [
      contentHash,
      replicaId,
      sessionId,
      interactivity,
      declaredCostClass,
      sizeBytes,
      ts,
      observedRehydrationMs,
    ]
  );

  // Append the rolling-window access event.
  await exec.query(
    `INSERT INTO placement.placement_access (content_hash, accessed_at)
     VALUES ($1, COALESCE($2::timestamptz, now()))`,
    [contentHash, ts]
  );

  // Prune access events older than the widest window we could ever ask about,
  // to keep the log bounded. Uses the promotion window as the horizon.
  const windowMs = config?.promotion?.frequencyWindowMs ?? DEFAULT_CONFIG.promotion.frequencyWindowMs;
  await exec.query(
    `DELETE FROM placement.placement_access
     WHERE content_hash = $1
       AND accessed_at < now() - ($2::double precision / 1000 * interval '1 second')`,
    [contentHash, windowMs]
  );
}

/** Count accesses for a hash within the promotion window. */
export async function windowedAccessCount(exec, contentHash, config) {
  const windowMs = config.promotion.frequencyWindowMs;
  const { rows } = await exec.query(
    `SELECT count(*)::int AS n
     FROM placement.placement_access
     WHERE content_hash = $1
       AND accessed_at >= now() - ($2::double precision / 1000 * interval '1 second')`,
    [contentHash, windowMs]
  );
  return rows[0].n;
}

// --------------------------------------------------------------------------
// Decision functions (PURE reads - never mutate residency state).
// --------------------------------------------------------------------------

/**
 * evaluatePromotion - D4a promotion decision (unpinned -> pinned). Returns a
 * decision object; DOES NOT mutate. Promote requires ALL of:
 *   - interactivity == 'interactive'         (never auto-promote batch)
 *   - effective rehydration cost > threshold (not worth pinning if cheap)
 *   - windowed access frequency >= threshold (recently hot)
 */
export async function evaluatePromotion(exec, contentHash, config = DEFAULT_CONFIG) {
  const { rows } = await exec.query(
    `SELECT * FROM placement.placement WHERE content_hash = $1`,
    [contentHash]
  );
  if (rows.length === 0) {
    return { promote: false, reason: "no-placement" };
  }
  const row = rows[0];

  if (row.pinned) {
    return { promote: false, reason: "already-pinned" };
  }

  const interactiveOk = row.interactivity === "interactive";
  const { costMs, source: costSource } = effectiveRehydrationCostMs(row, config);
  const costOk = costMs != null && costMs > config.promotion.rehydrationCostThresholdMs;
  const freq = await windowedAccessCount(exec, contentHash, config);
  const freqOk = freq >= config.promotion.frequencyThreshold;

  const promote = interactiveOk && costOk && freqOk;

  return {
    promote,
    reason: promote
      ? "qualifies"
      : !interactiveOk
        ? "not-interactive"
        : !costOk
          ? "cost-below-threshold"
          : "frequency-below-threshold",
    detail: {
      interactivity: row.interactivity,
      interactiveOk,
      costMs,
      costSource,
      costThresholdMs: config.promotion.rehydrationCostThresholdMs,
      costOk,
      windowedAccessCount: freq,
      frequencyThreshold: config.promotion.frequencyThreshold,
      freqOk,
    },
  };
}

/**
 * evaluateDemotion - D4a idle-timeout demotion decision (pinned -> unpinned),
 * using a HIGHER idle threshold than promotion requires (hysteresis). Returns a
 * decision object; DOES NOT mutate.
 */
export async function evaluateDemotion(exec, contentHash, config = DEFAULT_CONFIG) {
  const { rows } = await exec.query(
    `SELECT *, EXTRACT(EPOCH FROM (now() - last_accessed_at)) * 1000 AS idle_ms
     FROM placement.placement WHERE content_hash = $1`,
    [contentHash]
  );
  if (rows.length === 0) {
    return { demote: false, reason: "no-placement" };
  }
  const row = rows[0];
  if (!row.pinned) {
    return { demote: false, reason: "not-pinned" };
  }

  const idleMs = row.idle_ms == null ? Infinity : Number(row.idle_ms);
  const demote = idleMs > config.demotion.idleThresholdMs;
  return {
    demote,
    reason: demote ? "idle-past-threshold" : "still-within-idle-threshold",
    detail: {
      idleMs,
      idleThresholdMs: config.demotion.idleThresholdMs,
    },
  };
}

// --------------------------------------------------------------------------
// Action functions (explicit state mutation).
// --------------------------------------------------------------------------

/** Promote a hash to pinned residency. Explicit action, separate from decision. */
export async function promote(exec, contentHash) {
  await exec.query(
    `UPDATE placement.placement
     SET pinned = true, pinned_at = now(), updated_at = now()
     WHERE content_hash = $1`,
    [contentHash]
  );
}

/** Demote a hash to unpinned. Keeps the row/fact; only clears residency. */
export async function demote(exec, contentHash) {
  await exec.query(
    `UPDATE placement.placement
     SET pinned = false, pinned_at = NULL, updated_at = now()
     WHERE content_hash = $1`,
    [contentHash]
  );
}

/**
 * evictLRUIfOverCapacity - capacity-aware LRU eviction (D4a). If the total
 * size of the PINNED set exceeds the configured budget, unpin least-recently-
 * used PINNED entries until the pinned total is back within budget.
 *
 * Eviction is scoped to the PINNED set ONLY: unpinned rows are never touched,
 * even if larger/older. Design choice: eviction sets pinned=false (demote)
 * rather than DELETEing the row, so the placement FACT (and its access history)
 * survives - a subsequent access can re-promote it, and resolvePlacement can
 * still report a (now-cold) fact. Documented in FINDINGS.md.
 *
 * Note: eviction is capacity management of the already-pinned pool and is
 * INDEPENDENT of trust tier. Trust gating (D5a/4.7) governs whether a warm
 * replica may be SHARED/reused, not whether the pool may reclaim its own memory.
 *
 * Returns the list of evicted content hashes (LRU-first order).
 */
export async function evictLRUIfOverCapacity(exec, config = DEFAULT_CONFIG) {
  const budget = config.capacity.pinnedBudgetBytes;

  const { rows } = await exec.query(
    `SELECT content_hash, size_bytes, last_accessed_at
     FROM placement.placement
     WHERE pinned = true
     ORDER BY last_accessed_at ASC NULLS FIRST`
  );

  let total = rows.reduce((sum, r) => sum + Number(r.size_bytes), 0);
  if (total <= budget) return [];

  const evicted = [];
  for (const r of rows) {
    if (total <= budget) break;
    await demote(exec, r.content_hash);
    total -= Number(r.size_bytes);
    evicted.push(r.content_hash);
  }
  return evicted;
}
