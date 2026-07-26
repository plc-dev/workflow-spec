// Named SQL query constants (`SQL_` prefix, ADR-0012/best-practices §2).

// Upsert never touches trust_tier beyond its column DEFAULT ('unverified'
// on first insert) - D5a: "register never touches trust... a regression
// in a new build does not inherit an older build's earned trust." The
// same rule, the other direction: re-registering the SAME digest (a
// degenerate case, since digests are content-addressed) does not reset an
// already-earned tier either.
export const SQL_UPSERT_SERVICE_IMAGE = `
  INSERT INTO service_images (digest, oci_ref, openapi_spec, hardware_requirements)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (digest) DO UPDATE
    SET oci_ref = EXCLUDED.oci_ref,
        openapi_spec = EXCLUDED.openapi_spec,
        hardware_requirements = EXCLUDED.hardware_requirements,
        updated_at = now()
  RETURNING *
`;

export const SQL_FIND_SERVICE_IMAGE_BY_DIGEST = "SELECT * FROM service_images WHERE digest = $1";

// recordTrustTier (task 2.5/D5a) - the runtime's ONLY write path against
// service_images. Fails to match any row for an unregistered digest; the
// caller (conformance.ts) treats a zero-row result as "the runtime cannot
// conjure an entry - only annotate an existing one" (D12).
export const SQL_UPDATE_SERVICE_IMAGE_TRUST_TIER = `
  UPDATE service_images
     SET trust_tier = $2,
         updated_at = now()
   WHERE digest = $1
   RETURNING *
`;
