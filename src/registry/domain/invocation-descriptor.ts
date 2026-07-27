import type { InvocationStyle } from "../constants.js";

// design.md D17b, Layer 2 - "naive service" CLI signature declaration.
// Derived from the function's OWN native CLI surface (analogous to how
// the OpenAPI spec is the sole stored contract for REST/CLI/MCP
// projection, D12) - NOT a platform-mandated shape the service must
// implement. One entry per heavy (dataset-scoped) parameter the function
// accepts; a light-only function has an empty array.
//
// - "flag":       the materialized local path is passed as
//                 `<flagName> <path>` (two separate argv tokens).
//                 `flagName` is the FULL, "--"-prefixed token as the
//                 service's own CLI expects it (e.g. "--dump-file", NOT
//                 the bare "dump-file") - rendered verbatim, never
//                 reconstructed from a bare name. Must match
//                 `INVOCATION_FLAG_NAME_PATTERN` (registry/constants.ts),
//                 the exact shape `agent/internal/execrunner/
//                 execrunner.go`'s `stripFlagPrefix` + `flagNamePattern`
//                 require.
// - "positional": the materialized local path is passed as a bare
//                 positional argument at `positionIndex` (0-based, among
//                 the OTHER positional arguments only - flag-style
//                 bindings never consume a positional slot). Every
//                 `positionIndex` across one function's entries must be
//                 unique (validate.ts rejects a duplicate).
// - "stdin":       the materialized file's CONTENTS (never its path, and
//                 never carried as bytes over the agent's own RPC -
//                 design.md D6/R3) are piped to the subprocess's stdin
//                 by the exec-agent, reading directly from the local
//                 path it already resolved. At most ONE "stdin" entry
//                 per function (validate.ts rejects more than one - the
//                 agent only ever delivers the first).
export interface InvocationDescriptorEntry {
  param: string;
  style: InvocationStyle;
  flagName?: string;
  positionIndex?: number;
}
