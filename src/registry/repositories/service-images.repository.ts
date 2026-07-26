import { ERROR_IDS, FatalError } from "../../shared/index.js";
import type { Queryable } from "../../shared/index.js";
import type { TrustTier } from "../constants.js";
import { type ServiceImage, type ServiceImageRow, mapServiceImageRow } from "../domain/index.js";
import {
  SQL_FIND_SERVICE_IMAGE_BY_DIGEST,
  SQL_UPDATE_SERVICE_IMAGE_TRUST_TIER,
  SQL_UPSERT_SERVICE_IMAGE,
} from "./queries/service-images.queries.js";

export interface UpsertServiceImageInput {
  digest: string;
  ociRef: string;
  openapiSpec: Record<string, unknown>;
  hardwareRequirements: Record<string, unknown>;
}

export interface ServiceImagesRepo {
  upsert(input: UpsertServiceImageInput): Promise<ServiceImage>;
  findByDigest(digest: string): Promise<ServiceImage | null>;
  /** Returns null if no image is registered under this digest. */
  updateTrustTier(digest: string, tier: TrustTier): Promise<ServiceImage | null>;
}

export function createServiceImagesRepo(client: Queryable): ServiceImagesRepo {
  return {
    async upsert(input) {
      const result = await client.query<ServiceImageRow>(SQL_UPSERT_SERVICE_IMAGE, [
        input.digest,
        input.ociRef,
        JSON.stringify(input.openapiSpec),
        JSON.stringify(input.hardwareRequirements),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new FatalError(ERROR_IDS.REGISTRY_SERVICE_IMAGE_UPSERT_NO_ROW_RETURNED, {
          context: { digest: input.digest },
        });
      }
      return mapServiceImageRow(row);
    },

    async findByDigest(digest) {
      const result = await client.query<ServiceImageRow>(SQL_FIND_SERVICE_IMAGE_BY_DIGEST, [
        digest,
      ]);
      const row = result.rows[0];
      return row ? mapServiceImageRow(row) : null;
    },

    async updateTrustTier(digest, tier) {
      const result = await client.query<ServiceImageRow>(SQL_UPDATE_SERVICE_IMAGE_TRUST_TIER, [
        digest,
        tier,
      ]);
      const row = result.rows[0];
      return row ? mapServiceImageRow(row) : null;
    },
  };
}
