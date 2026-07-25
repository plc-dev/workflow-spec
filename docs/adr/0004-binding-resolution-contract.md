# ADR-0004: Binding resolution - resolver-per-kind, handles not values

## Status

Proposed

## Context

D8's `Binding` is a discriminated union (`static | session | request | step |
item | literal | compute | itemResource`), and each variant resolves at a
different locus with different costs and different stores behind it:

- `literal`, `item` (D8a), `compute` (D10) resolve **in-interpreter**, for
  free - no step/activity scheduling, no registry lookup, no placement
  decision. `compute` additionally structurally excludes secret inputs
  (D10) and is disambiguated from the DSL-level `map`/`forEach` construct,
  which fans out to services (D9), not in-memory computation (D10).
- `session` resolves against the D3 session snapshot chain and the D2/D3
  memoization cache, both living in `@wfx/core` (ADR-0002).
- `static` resolves against the D8b dataset catalog (URN -> digest ->
  object key; the index lives in `@wfx/core`, the bytes live in dedicated
  object storage - see ADR-0006).
- `itemResource` (D16) resolves against D15's per-instance flattened Item
  Pool cache, itself a further application of the same derived-cache-over-
  durable-source pattern as D2/D3, now over an external source; it
  addresses into an externally-sourced document via a locator syntax
  (JSON Pointer, RFC 6901), not the in-memory `var` extraction `item`/
  `request` bindings use.
- `step` resolves against a prior step's (or a `branch`/`map`'s own
  `yields`) already-produced output within the same execution.

D6's R3 requires that large state move **by handle** (a content hash / URN),
never by value, for anything crossing the "heavy" threshold - and D16 names
this explicitly as a correctness property (misclassifying a heavy leaf as a
light value could mean literally inlining a multi-GB blob into a request).

## Decision

A single resolution interface, implemented once per `Binding` kind:

```
resolve(binding: Binding, ctx: ResolutionContext) -> Value | Handle
```

where `Handle` is a content-addressed reference (a hash or URN) and `Value`
is an ordinary in-memory JSON value. Each binding kind's resolver decides,
based on what it actually resolves to, whether the result is a `Handle`
(dataset-scoped/heavy - session snapshots, static datasets, heavy
`itemResource` leaves) or a `Value` (request parameters, `item`, `literal`,
`compute` results, light `itemResource` leaves, ordinary step outputs). This
decision is made by D15/D16's flattening classification for `itemResource`,
and by D1's scope x setup-cost classification everywhere else - never by the
binding's syntax alone.

`compute` and `literal` resolvers are implemented directly inside
`@wfx/engine`'s interpreter loop (they need no I/O and no store); `session`,
`static`, and `itemResource` resolvers call out to `@wfx/session`,
`@wfx/dataset-catalog`, and `@wfx/item-pool` respectively; `step` resolvers
read from the current execution's already-recorded outputs/`yields`.

## Consequences

- R3 (handles, not values, for large state) is enforced structurally at one
  seam - the resolver's return type - rather than as a convention each
  binding-kind implementation has to remember independently.
- Secrets remain categorically excluded from this interface (D7, D10):
  there is no `secret` binding kind, and `compute`'s `using` inputs are
  rejected at validation time (`@wfx/ir`) if they reference one.
- Adding a new binding kind later (the IR already anticipates this
  possibility structurally, per D8) means adding one resolver, not touching
  every consumer of `Binding`.

## Alternatives considered

- **A single generic resolver dispatching on a `kind` string with inline
  branching.** Rejected: the per-kind loci differ enough (in-interpreter vs.
  three different external stores) that a single function would need to
  import every store package regardless of which kinds a given workflow
  actually uses, defeating the modularity ADR-0007 establishes.
