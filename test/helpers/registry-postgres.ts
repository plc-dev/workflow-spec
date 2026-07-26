import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { FunctionCapabilityInput } from "../../src/registry/index.js";
import { createFunctionCapabilitiesRepo } from "../../src/registry/repositories/function-capabilities.repository.js";
import { createServiceImagesRepo } from "../../src/registry/repositories/service-images.repository.js";
import { type TestPostgres, startTestPostgres } from "./postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_SCHEMA_PATH = path.join(__dirname, "../../src/registry/database/schema.sql");

// registry/ owns its OWN database, entirely separate from core/'s
// (ADR-0006) - startRegistryPostgres fixes registry/'s schema path once,
// here, rather than each registry test file independently computing
// __dirname + a relative path to the same schema.sql (a local code
// review flagged this repeated-path-computation, plus the repeated
// TRUNCATE/seed blocks below, as duplication/drift risk - see
// docs/impl-plans/0008-shared-database-consolidation.md).
export function startRegistryPostgres(): Promise<TestPostgres> {
  return startTestPostgres({ schemaPath: REGISTRY_SCHEMA_PATH });
}

export async function resetRegistryTables(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE function_capabilities, service_images RESTART IDENTITY CASCADE");
}

export interface SeedRegisteredImageInput {
  digest: string;
  ociRef: string;
  openapiSpec: Record<string, unknown>;
  hardwareRequirements: Record<string, unknown>;
}

// Registers just the per-image entry, no capability rows - matches what
// test/registry/repositories/function-capabilities.repository.test.ts's
// own beforeEach needs (it exercises replaceForDigest/listByDigest
// itself, so seeding capability rows ahead of time would be redundant).
export async function seedRegisteredImage(
  pool: Pool,
  input: SeedRegisteredImageInput,
): Promise<void> {
  await createServiceImagesRepo(pool).upsert(input);
}

export interface SeedFixtureImageInput extends SeedRegisteredImageInput {
  capabilityMetadata: Record<string, FunctionCapabilityInput>;
}

// Registers the per-image entry AND its per-function capability rows -
// matches what test/registry/get-placement-facts.test.ts and
// test/registry/conformance.test.ts's own beforeEach need.
export async function seedFixtureImage(pool: Pool, input: SeedFixtureImageInput): Promise<void> {
  await seedRegisteredImage(pool, input);
  await createFunctionCapabilitiesRepo(pool).replaceForDigest(
    input.digest,
    input.capabilityMetadata,
  );
}
