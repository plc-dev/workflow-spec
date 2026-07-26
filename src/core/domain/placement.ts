// Placement (design.md D4/D4a, task 4.1a, docs/impl-plans/0005-placement.md)
// - the bespoke-resolver option's formalized table (task 1.10), promoted
// here per ADR-0002. `replicaId`/`sessionId` are nullable: a hash can be
// tracked for admission before/without a bound replica, and a
// demoted/evicted entry retains its fact with no live replica - a
// resolver "miss" is `replicaId === null` or no row at all, never an
// error (D4: affinity is always an optimization).
export interface Placement {
  contentHash: string;
  replicaId: string | null;
  sessionId: string | null;
  pinned: boolean;
  pinnedAt: Date | null;
  interactivity: "interactive" | "batch";
  accessCount: number;
  firstAccessedAt: Date | null;
  lastAccessedAt: Date | null;
  declaredCostClass: "trivial" | "cheap" | "moderate" | "expensive" | null;
  observedRehydrationMs: number | null;
  observedSampleCount: number;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}
