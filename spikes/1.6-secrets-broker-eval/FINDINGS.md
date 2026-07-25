# Task 1.6 — LIGHTWEIGHT EVALUATION: secrets-broker product (Infisical vs. OpenBao)

**Task**: tasks.md 1.6. Select a secrets-broker product against the
broker-agnostic model in design.md D7 (open question). Desk research only,
same posture as the 1.2a/1.2d lightweight evaluations - D7's Open Questions
note had already narrowed the field to two live contenders (Infisical,
OpenBao); this closes out the final pick between them, not a from-scratch
survey of the whole secrets-manager market.

## What was done

Architecture/licensing research against Infisical's and OpenBao's own docs
and current (2026) third-party comparisons (dynamic-secrets/lease
mechanics, TTL semantics, ACL/namespace models, pricing tiers) - no
build-out, per the task's lightweight scoping. Evaluated strictly against
D7's actual stated requirements, not general feature-completeness:

1. Push-by-value (D7 rule 3) - worker resolves via an API call, no
   pull-from-broker-by-the-container model needed.
2. Session-TTL-bound user secrets (D7 rule 5) - a user-scoped secret must
   be revocable/expirable on a timer tied to session lifetime, and this
   must be a property the broker enforces, not an app-level sweep job.
3. Writer/session namespace isolation *enforced by the broker itself, not
   just application convention* (D7's scope table + the Open Questions
   note's explicit wording).
4. Operational fit with the rest of D6's stack (self-hosted, Postgres-
   native, deliberately light operational footprint - see D6/1.2e).

## Findings

### 1. Session-TTL-bound revocation (requirement 2) is the decisive axis

This is a **native, first-class mechanism in OpenBao, and a paid-tier-only
capability in Infisical**:

- **OpenBao**: every dynamic secret and every `service`-type token carries
  a **lease** (TTL + optional `max_ttl` + renewable flag) that the
  server's own expiration manager revokes automatically on expiry, no
  external caller involvement required - this is core, free (Linux
  Foundation governed, no Enterprise tier at all). A session-scoped user
  secret maps directly onto this: mint it under a per-session token/lease
  with `ttl` = the session's TTL; when the lease expires, OpenBao itself
  revokes it. Revocation also cascades (revoking a parent token revokes
  every lease minted under it), which maps cleanly onto "collected with
  the session" (D7 rule 5) as a single call, not a per-secret sweep.
- **Infisical**: the equivalent capability (leased **Dynamic Secrets**
  with TTL, auto-revocation via a queued job on expiry) exists and is
  well documented (CLI `dynamic-secrets lease create/renew/revoke`,
  Kubernetes CRD with `leaseTTL`) - but dynamic secrets are gated to
  Infisical's **Enterprise tier**, even self-hosted. Infisical's free/Pro
  core is a static KV secrets manager (projects/environments/folders);
  its plain KV secrets carry no server-enforced TTL/expiry at all - an
  expiring session secret on the MIT-licensed core would have to be
  implemented as an application-level sweep (delete-if-past-timestamp),
  which is exactly the "not just application convention" case D7's own
  wording flags as insufficient.

This one finding is close to dispositive: D7 rule 5 is not a nice-to-have,
it is a stated rule, and only OpenBao satisfies it with a broker-native
mechanism at zero licensing cost.

### 2. Writer/session namespace isolation (requirement 3)

- **OpenBao**: path-based ACL policies (glob-capable) are core-product and
  have been the primary access-control primitive since the Vault lineage
  began; multi-tenant **Namespaces** (hard isolation domains) have been
  free in OpenBao's core since 2.3 (a HashiCorp-Vault-Enterprise-only
  feature in the proprietary lineage this project forked from). Mapping
  writer-scoped vs. session-scoped secrets onto distinct path prefixes
  with distinct policies is the mechanism this product is built around.
- **Infisical**: project/environment/folder scoping plus RBAC covers the
  same shape at moderate scale, but the stronger multi-tenant isolation
  primitive (sub-organizations) is Enterprise-gated; core-tier isolation
  is closer to "convention enforced by policy configuration" than a
  structurally separate tenancy boundary.

Both *can* express the isolation D7 needs at our current scale (two scopes:
writer, session), but OpenBao's version costs nothing and scales to a
stronger boundary later without a licensing conversation.

### 3. Push-by-value fit (requirement 1) and operational cost (requirement 4)

Both products expose a plain read-secret API a worker can call synchronously
inside step execution and push the value into the request payload - neither
requires the heavier pull-from-broker-by-the-container model D7 explicitly
declines to need, so this requirement doesn't discriminate between them.

Operationally, OpenBao is the heavier of the two to run (its own storage
backend, unseal/init lifecycle, HA topology if ever needed) versus
Infisical's simpler deployment story. This is a real, accepted cost, not a
wash - see Verdict.

### 4. Licensing/governance posture

Infisical is **open-core**: MIT except the `ee/` directory, which is where
dynamic secrets, secret rotation, SAML SSO, SCIM, and HSM support all live,
even self-hosted. OpenBao has **no paid tier** - it is a Linux Foundation
project (the community fork of HashiCorp Vault after Vault's BUSL
relicensing), and the specific capability D7 rule 5 needs (leases/TTL) sits
in the free core, not behind a wall. For a platform whose secrets-broker
requirements are dictated by D7's specific rules rather than by wanting a
polished dashboard, this matters more than general product breadth.

## Verdict

**DECIDED: OpenBao.** It is the only one of the two live contenders whose
free/core tier satisfies D7 rule 5 (session-TTL-bound, broker-enforced
revocation) natively; Infisical's equivalent mechanism is real but
Enterprise-gated, which would either mean paying for a capability D7
treats as a base requirement or falling back to an application-level sweep
D7's own wording explicitly distinguishes from broker-enforced. OpenBao's
path-based ACL policies and free Namespaces also give writer/session
isolation (requirement 3) a more structural home than Infisical's core
tier. The accepted cost is operational: OpenBao is the heavier of the two
to stand up and run (storage backend, unseal/init, no built-in dashboard
polish) - accepted because D6/1.2e already committed this platform to
self-operating its own Postgres-native durability layer, so operating one
more self-hosted, well-documented open-source service is consistent with
the existing operational posture, not a new category of cost.

**Practical mapping onto D7's model** (for 9.2's integration, not decided
further here): writer-scoped secrets (D7's main case, indefinite lifetime)
live as plain KV entries under a writer-scoped path with an ACL policy
restricting access to that path; user-scoped secrets (D7's secondary case)
are minted as a token-scoped lease with `ttl` matching the session, under a
session-scoped path - both cases map onto native OpenBao primitives, no
custom TTL/expiry logic needed on the platform side.

**Alternatives considered**: A cloud secrets manager (e.g. AWS/GCP Secrets
Manager) - not evaluated in depth; D7's Open Questions note already scoped
the live contenders to Infisical/OpenBao based on a prior comparison
against D7's requirements, and nothing in this task's remit reopens that
narrowing. An encrypted-at-rest store decrypted worker-side (D7's third
named option) - rejected for the same reason the Open Questions note
already narrowed away from it: it would mean hand-building the lease/ACL
machinery both real contenders already ship, for no offsetting benefit.
