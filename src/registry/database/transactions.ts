import type { Pool, PoolClient } from "pg";
import { withTransaction as withSharedTransaction } from "../../shared/index.js";
import {
  type FunctionCapabilitiesRepo,
  createFunctionCapabilitiesRepo,
} from "../repositories/function-capabilities.repository.js";
import {
  type ServiceImagesRepo,
  createServiceImagesRepo,
} from "../repositories/service-images.repository.js";

// registerImage (admin.ts) is the ONLY write path in this package that
// touches two tables and needs them to commit-or-rollback together
// (service_images + function_capabilities). Unlike core/'s
// withTransaction/CoreRepos (ADR-0002's DEEP-consolidation primitive,
// composed by many future callers across module boundaries), this is a
// small, internal-only helper - not exported from registry/index.ts, and
// registry/ has no cross-module composability requirement to satisfy
// (ADR-0006: registry reads/writes never join core/'s step-completion
// transaction).
//
// **Revision (docs/impl-plans/0008-shared-database-consolidation.md):**
// `client` was removed by 0007's own local review as dead code (nothing
// used it), then reintroduced here once this revision's own crash test
// (test/registry/database/transactions.test.ts) needed exactly the same
// escape hatch core/'s CoreRepos already exposes, for exactly the same
// reason: fetching the in-transaction connection's own backend pid so a
// test can `pg_terminate_backend` it and prove the tolerant-rollback/
// error-listener fix actually holds under a real mid-transaction crash,
// not just a thrown-error rollback.
export interface RegistryRepos {
  serviceImages: ServiceImagesRepo;
  functionCapabilities: FunctionCapabilitiesRepo;
  client: PoolClient;
}

// Thin wrapper over shared/database/'s generic withTransaction (ADR-0012's
// `shared/database/` revision, docs/impl-plans/0008-shared-database-
// consolidation.md) - this module keeps its own public signature and
// `RegistryRepos` shape. This ALSO fixes a real gap this package's own
// first version had: the tolerant rollback (a dead connection's ROLLBACK
// failing must not mask the original error) and the `'error'`-listener
// handling for a forcibly terminated backend now come from the same
// shared mechanism `core/`'s equivalent wrapper already had, rather than
// this module's own independently-written, less complete copy.
export function withRegistryTransaction<T>(
  pool: Pool,
  fn: (repos: RegistryRepos) => Promise<T>,
): Promise<T> {
  return withSharedTransaction<RegistryRepos, T>(
    pool,
    (client): RegistryRepos => ({
      serviceImages: createServiceImagesRepo(client),
      functionCapabilities: createFunctionCapabilitiesRepo(client),
      client,
    }),
    fn,
  );
}
