// design.md D8c: a step's write target - a session key its output may be
// committed to. Gating (D4's change-detection signal) is automatic
// runtime behavior, never an authored flag.

export interface SessionWriteTarget {
  to: "session";
  key: string;
}
