# Spike 1.2a — LIGHTWEIGHT EVALUATION: Restate

**Task**: tasks.md 1.2a (re-scoped from a narrow build-out spike to a
desk-research evaluation, same posture as 1.2-hatchet/1.2d - see design.md
D6's "Recommended next step"). The specific technical question this task
was originally scoped to check - whether the Postgres-native path can match
Restate's "per-key serialized access for free" via ordinary `SELECT ... FOR
UPDATE` discipline without surprises - was already answered empirically by
spike 1.2's own contention test (confirmed: yes, no surprises). This
evaluation instead checks whether Restate's own architecture surfaces any
*other* differentiator design.md D6 hasn't already accounted for.

## What was done

Architecture research against Restate's own documentation
(docs.restate.dev: architecture reference, foundations/services,
foundations/actions, guides/databases, server/deploy/kubernetes,
server/metadata, server/clusters, server/snapshots) and its "Building a
modern Durable Execution Engine from First Principles" engineering blog
post - no build-out, per the lightweight-evaluation scoping.

## Findings

**1. Confirms, rather than overturns, design.md D6's existing finding: Virtual Objects cannot host the heavyweight SQL service itself.**

Restate's Virtual Object state is an embedded K/V store, materialized in
RocksDB per-partition and journaled through Restate's own replicated log
(Bifrost). Restate's own docs are explicit about the shape of state this is
for: "isolated per object key," "K/V interface with single-key
transactions," attached to the request on invocation for fast local access.
This is designed for session/entity-shaped state (shopping carts, agent
context, small documents), not for hosting a multi-GB materialized SQL dump
as the actual engine process. Design.md D6's original correction - "neither
[Restate nor Dapr] makes our existing heavyweight services 'become'
addressable actors for free" - holds up under closer reading of Restate's
own architecture docs, not just the prior round's high-level assessment.

**2. Per-key serialized access is real and is exactly what design.md described - "for free" in the sense of being architecture-level, not a claim that needs walking back.**

Restate's docs confirm the mechanism directly: a Virtual Object's exclusive
handlers get "at most one handler with write access... at a time per
object key," enforced by the partition processor's log-ordered, single-
leader-per-partition design (every operation for a key is sequenced through
one partition's log). This is the same guarantee spike 1.2 achieved via
`SELECT ... FOR UPDATE` on a session-scoped row - Restate gets it as an
architectural property of the whole system rather than a query discipline
applied per-call. Neither is "free" in the sense of zero engineering cost
(Restate's is free to the *application developer*, paid for by Restate's
own partition/log/RocksDB machinery; the Postgres-native path's is paid for
directly, in a `WHERE session_id = $1 FOR UPDATE` clause) - but spike 1.2
already confirmed empirically that the Postgres-native path's version has
no observed correctness gap versus this description, which is what this
task existed to check.

**3. A genuine, previously under-weighted finding: Restate's "Light" operational-weight rating in design.md's evaluation table undersells what a *production* deployment actually requires.**

Restate's own deployment docs describe a materially heavier production
footprint than "Light" suggests for anything beyond a single-node
development instance:

- A distributed **replicated log** (Bifrost) with quorum-based writes,
  requiring careful `default-replication` configuration for fault
  tolerance.
- A **Raft-based metadata store** (or an external etcd cluster, or
  AWS-S3-only object-store metadata - explicitly "Only Amazon S3 is
  currently tested and supported" for that mode, not MinIO or other
  S3-compatible stores).
- **RocksDB** per partition processor, with its own memory-tuning guidance
  (`rocksdb-total-memory-size` set to ~75% of pod memory).
- A **snapshot repository** (S3/GCS/Azure Blob) required for any
  multi-node cluster to bound recovery time and allow safe log trimming -
  without one, a lost cluster has no recovery path for trimmed log data.
- A recommended **Kubernetes Operator** (custom CRDs: `RestateCluster`,
  `RestateDeployment`, `RestateCloudEnvironment`) to manage all of the
  above, or a "more bare-bone" Helm chart requiring manual
  registration/versioning operations.

This is a real, multi-component distributed system to run in production -
closer in kind to Temporal's operational profile than to a single
Postgres-schema addition, even though it ships as a single binary for
development convenience. Design.md's evaluation table row ("Operational
weight... Restate: Light") should be read with this qualification: light to
*start* (single binary, embedded storage), but not obviously light to *run
correctly at production scale* (distributed log + Raft metadata + RocksDB +
object-store snapshots + an operator). This is consistent with, not
contradicting, D6's own "newer, less proven at scale than Temporal" note on
Restate elsewhere in the same document.

**4. No native secrets-broker differentiator was found for Restate** (unlike Dapr's native Secrets API, called out elsewhere in design.md D7/D6). Restate's only credential-shaped feature found is request-signing key management for outbound calls (via Kubernetes Secrets or a CSI secret store) - an operator/infra concern, not a workflow-writer-facing secrets-broker capability comparable to what D7 needs. This matches design.md's existing table (Restate: "Good" on R9, no "plus native X" annotation, unlike Dapr) - no correction needed here.

## Verdict

**No new differentiator found beyond what design.md D6 already established.** The specific technical unknown this task was originally scoped to check is closed (by spike 1.2, empirically). The one adjustment worth carrying back into design.md is a **downward correction to Restate's operational-weight rating** for production topologies - from "Light" to something like "Light to start, Moderate-to-heavy to run as a proper multi-node cluster" - which, if anything, *strengthens* the case for the Postgres-native path's "lightest operational footprint" claim (design.md D6) rather than weakening it, since it narrows the operational-weight gap between Restate and Temporal while widening it between Restate and the Postgres-native path.

This closes out 1.2a without further spike effort, per its re-scoped, lightweight posture.
