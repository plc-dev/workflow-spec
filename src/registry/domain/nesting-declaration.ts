import type { NestingTransport } from "../constants.js";

// D9b/D12: records only the POSSIBILITY of nesting a service author
// declared for one function - transport plus target shape. Never the
// concrete bound target (a DSL-level binding decision, out of scope here).
export interface NestingDeclaration {
  via: NestingTransport;
  targets: string[] | "open";
}
