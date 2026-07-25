# ADR-0010: CI, repository hygiene, and local development environment

## Status

Proposed

## Context

ADR-0009 fixes the language/build/test/quality toolchain used to write and
verify code in this single package. This ADR fixes the operational half:
how that toolchain runs in CI, how dependencies and secrets are governed at
the repository level, and how a developer actually runs the system
locally - superseding `archive/scripts/with-postgres.sh`'s one-off,
single-suite pattern with something that covers the whole stack.

## Decision

**CI: GitHub Actions, one pipeline.** Lint (Biome) -> typecheck
(`tsc --noEmit`) -> unit tests (Vitest) -> integration tests (Vitest +
testcontainers-node, per ADR-0009) -> esbuild app builds -> per-app Docker
image build. One pipeline, not one per module, since there is one package
(ADR-0001).

**No pre-commit hooks.** No husky, no `simple-git-hooks`, no `lint-staged`.
CI plus editor-integrated Biome is the enforcement point. Consistent with
the minimalism already applied to the rest of the toolchain this session
(no Turborepo, no workspaces, no dependency-cruiser) - a git hook is one
more thing to install and maintain for marginal benefit once CI feedback is
already fast (Biome is fast specifically because it is one tool doing both
lint and format).

**Dependency updates: Renovate.** More configurable grouping/scheduling
than Dependabot, which matters once real runtime dependencies (`pg`,
`pino`, `zod`, the OpenTelemetry SDK, an OpenBao client, a MinIO/S3 client)
accumulate and need coordinated, not one-PR-per-package, updates.

**Secret scanning: gitleaks, in CI only.** Given how central "a secret must
never touch git history" is to D7 and ADR-0008's secrets-delivery model,
this is worth enforcing mechanically rather than trusting review alone -
but as a CI job, not a git hook, consistent with the no-pre-commit-hooks
decision above; the enforcement point stays singular.

**Commit convention: a loose prefix convention, not an enforced one.** No
commitlint. The existing git history already reads roughly as
`prefix: message` (`spec: ...`, `spikes: ...`); continuing that informally
is enough. Enforcing commit-message shape mechanically is exactly the kind
of tooling this session has been declining to add without a concrete need.

**Local development environment: `docker-compose.yml`.** Distinct in
purpose from testcontainers (ADR-0009), which is test-scoped and ephemeral
per test run: this is a **persistent** stack for interactive local
development. Services:

```
postgres    - ONE container, multiple logical databases inside it
              (core, registry, workflow_store) - satisfies ADR-0006's
              "separate databases" requirement without needing separate
              CONTAINERS in dev; each store's schema.sql (ADR-0009) is
              applied to its own database on stack startup
openbao     - dev-mode (auto-unsealed, ephemeral) - task 1.6's chosen
              secrets broker
minio       - D8b's dedicated object storage for dataset bytes

DEFERRED: a fake Item Pool stub - nothing currently under active
development needs it; add when item-pool/ work actually starts.
```

This supersedes `archive/scripts/with-postgres.sh` entirely - that script's
own stated purpose (make `npm test` self-contained rather than depending on
an undocumented manual `docker run`) is now served by testcontainers for
tests and this compose file for interactive dev, rather than one bespoke
script trying to serve both.

**Docker build for apps: multi-stage, `alpine` runtime.** A build stage
(full Node, `tsc --noEmit` + esbuild bundle per ADR-0009) produces one
bundled JS file per app; the runtime stage copies just that bundle into
`node:<lts>-alpine`. Alpine, not distroless, for now - it keeps a shell
available for debugging a new deployment; distroless is a reasonable later
hardening step once the platform is closer to production, not a day-one
requirement.

## Consequences

- The operational tooling stays as minimal as the code-authoring tooling
  (ADR-0009) - no tool is adopted here without a concrete, current need.
- Local dev and CI both rely on schema.sql being idempotent (ADR-0009's
  deferred-migrations decision) - if that decision is later revisited (a
  real migration tool adopted), this ADR's `docker-compose.yml` startup
  step and CI's integration-test setup both need a corresponding update.
- gitleaks is the one governance control introduced without a "wait until
  needed" caveat - the cost of a leaked secret is asymmetric enough
  (D7's entire threat model exists to prevent exactly this) to justify
  turning it on immediately rather than deferring.

## Alternatives considered

- **Dependabot instead of Renovate.** Rejected - less configurable grouping
  once dependency count grows past a handful of packages.
- **husky + lint-staged for pre-commit enforcement.** Rejected per the
  no-pre-commit-hooks decision above.
- **Distroless runtime images now.** Not rejected outright, deferred - a
  reasonable hardening step, just not justified before there's a real
  deployment to harden.
- **gitleaks as a pre-commit hook rather than CI-only.** Considered, given
  secret-leak asymmetry might seem to justify the earliest possible check -
  rejected anyway, to keep exactly one enforcement point (CI) rather than
  making a single exception to the no-hooks rule for one tool.
