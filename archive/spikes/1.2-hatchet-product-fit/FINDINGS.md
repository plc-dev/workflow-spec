# Spike 1.2-hatchet — SHALLOW, PRODUCT-FIT EVALUATION: Hatchet

**Task**: tasks.md 1.2-hatchet. Scoped to exactly one decisive question,
per design.md D6's re-scoping of Hatchet to a lightweight evaluation rather
than a full parallel spike:

> does its worker/step-completion model expose a shared-transaction boundary
> (letting a step-completion and a placement/session-log write commit
> atomically), or is completion reported via an out-of-process API callback
> (two commits, not one)?

This was answered by architecture research against Hatchet's own
documentation and public engineering writeups, not by standing up a full
Hatchet deployment - matching the "lightweight-evaluation posture" design.md
gives this task (same posture as 1.2d/Conductor), not the deep-spike posture
given to 1.2/resonate-pg.

## Architecture, as documented by Hatchet

Hatchet v1's control plane is composed of three separate processes/services:

- **API server** — HTTP surface for triggering workflows / querying state / UI
- **Engine** — schedules/dispatches work, enforces policies, records state
  transitions durably in its own PostgreSQL database
- **Workers** — *your* processes, running your task code, connected to the
  Engine over a **persistent bidirectional gRPC stream**

Source: Hatchet's own "Architecture & Guarantees" doc
(docs.hatchet.run/v1/architecture-and-guarantees) states workers "connect to
the engine over bidirectional gRPC, which allows low-latency dispatch and
frequent status updates," and separately that they "receive tasks, run your
code, and report progress/results back to Hatchet" over that same gRPC
channel. Hatchet's own engineering blog (multi-tenant-queues post) confirms
the underlying queue mechanics mirror THE PATTERN in design.md D6 (`FOR
UPDATE SKIP LOCKED` claiming), and the HN "Hatchet v1" launch thread
confirms explicitly: *"we use gRPC on our workers... it will make it more
difficult to call the APIs directly"* — i.e. the worker process is a
separate deployable, communicating with the Engine over the network, not a
library sharing the caller's database connection/transaction.

## Answer to the decisive question

**Out-of-process API callback — two commits, not one.**

A worker's step-completion is reported by sending a message over the gRPC
stream to the Hatchet Engine process; the Engine then writes the durable
state transition into *its own* PostgreSQL database, in the Engine's own
transaction. The worker process (where our step's own side effects - a
placement write, a session-log append - would need to happen) has no shared
transaction boundary with that write: it is a distinct process, over a
network call, into state the worker does not directly transact against.

This holds even in the *most* favorable deployment shape (worker code
co-located with, or even sharing, the same physical Postgres instance the
Engine uses for its own state): Hatchet's own step-completion commit and any
step-local write our worker code makes (e.g. to a `session_log` /
`placement` table) are still two separate client connections issuing two
separate `COMMIT`s - there is no API by which a Hatchet worker's own
Postgres transaction and the Engine's step-completion write are the same
transaction. This is a structural property of the gRPC-worker/Engine split,
not a configuration or deployment-topology choice we could work around.

Contrast with what DEEP consolidation actually requires (per design.md D6
and confirmed by spike 1.2): the code that decides "this step is done" and
the code that mutates the session log / placement table must be able to sit
in the *same* transaction, so they commit together or not at all. Hatchet's
architecture puts a network hop and a process boundary exactly at that seam.

## Verdict

Per design.md D6's own framing: this caps Hatchet at **SHALLOW
consolidation** (Hatchet's Engine, our own session-log/placement tables, and
our own application code could all point at the same physical Postgres
instance/cluster - a real ops win, one thing to run/patch/back up - but each
commits independently; no cross-concern atomicity).

This reframes Hatchet against 1.2/resonate-pg as design.md predicted: an
explicit **build (own the durability core, via a resonate-pg-shaped fork) vs.
buy (depend on Hatchet's Engine, get DEEP-consolidation only for whatever
Hatchet itself durably tracks, SHALLOW for everything else)** trade, not a
technical unknown further spiking would resolve. Hatchet remains a strong,
mature, Postgres-backed, YC-backed-and-growing engine on every other axis
(R1-R10 in design.md D6's table already scored it "Good"/"Strong" broadly) -
this finding narrows specifically the DEEP-consolidation column, nothing
else in its evaluation changes.

## Recommendation

Do not spike Hatchet further for the consolidation question - it's settled
by the architecture, not by empirical testing. If Hatchet is otherwise
attractive (managed dashboard, mature SDKs, gRPC push model, proven at
1B+/month per its own case studies), evaluate it purely on the SHALLOW/buy
side of the trade above: same-instance ops convenience, someone else
maintaining the durability core, at the cost of D3/D4's atomicity guarantee
degrading to eventual consistency between Hatchet's own completion record
and our session-log/placement writes.

## Sources consulted

- https://docs.hatchet.run/v1/architecture-and-guarantees
- https://docs.hatchet.run/llms/v1/workers.md
- https://kupczynski.info/posts/pattern-spotting-hatchet/ ("Pattern
  Spotting: Hatchet")
- https://hatchet.run/blog/multi-tenant-queues
- https://news.ycombinator.com/item?id=43572733 (Hatchet v1 launch thread,
  team comments on gRPC worker architecture)
