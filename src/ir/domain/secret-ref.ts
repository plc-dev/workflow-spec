// design.md D8c/D7/D10: a secret reference is a SEPARATE category from a
// Binding, living in a step's own `secrets` block - never a Binding kind
// (that's what excludes it from a `compute` binding's `using` map by
// construction, not by a runtime check).

export interface SecretRef {
  scope: "writer" | "user";
  name: string;
}
