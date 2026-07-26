import type { Queryable } from "../../shared/index.js";
import {
  type FunctionCapability,
  type FunctionCapabilityInput,
  type FunctionCapabilityRow,
  mapFunctionCapabilityRow,
} from "../domain/index.js";
import {
  SQL_DELETE_FUNCTION_CAPABILITIES_FOR_DIGEST,
  SQL_INSERT_FUNCTION_CAPABILITY,
  SQL_LIST_FUNCTION_CAPABILITIES_BY_DIGEST,
} from "./queries/function-capabilities.queries.js";

export interface FunctionCapabilitiesRepo {
  /** DELETE-then-INSERT: entirely replaces this digest's function rows. */
  replaceForDigest(
    digest: string,
    capabilityMetadata: Record<string, FunctionCapabilityInput>,
  ): Promise<FunctionCapability[]>;
  listByDigest(digest: string): Promise<FunctionCapability[]>;
}

export function createFunctionCapabilitiesRepo(client: Queryable): FunctionCapabilitiesRepo {
  return {
    async replaceForDigest(digest, capabilityMetadata) {
      await client.query(SQL_DELETE_FUNCTION_CAPABILITIES_FOR_DIGEST, [digest]);

      const inserted: FunctionCapability[] = [];
      for (const [functionName, cap] of Object.entries(capabilityMetadata)) {
        const result = await client.query<FunctionCapabilityRow>(SQL_INSERT_FUNCTION_CAPABILITY, [
          digest,
          functionName,
          cap.mutates,
          cap.materializationCostClass,
          cap.cowSupport,
          cap.changeDetectionSupport,
          cap.nestingDeclaration === null ? null : JSON.stringify(cap.nestingDeclaration),
        ]);
        const row = result.rows[0];
        if (row) inserted.push(mapFunctionCapabilityRow(row));
      }
      return inserted;
    },

    async listByDigest(digest) {
      const result = await client.query<FunctionCapabilityRow>(
        SQL_LIST_FUNCTION_CAPABILITIES_BY_DIGEST,
        [digest],
      );
      return result.rows.map(mapFunctionCapabilityRow);
    },
  };
}
