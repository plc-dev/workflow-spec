import type { Pool } from "pg";
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
// transaction). No raw `client` escape hatch is exposed here (unlike
// core/'s CoreRepos) - nothing in this package needs one, and an unused
// one is dead weight, not a deliberate affordance.
export interface RegistryRepos {
  serviceImages: ServiceImagesRepo;
  functionCapabilities: FunctionCapabilitiesRepo;
}

export async function withRegistryTransaction<T>(
  pool: Pool,
  fn: (repos: RegistryRepos) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repos: RegistryRepos = {
      serviceImages: createServiceImagesRepo(client),
      functionCapabilities: createFunctionCapabilitiesRepo(client),
    };
    const result = await fn(repos);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
