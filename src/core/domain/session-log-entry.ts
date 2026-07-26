export interface SessionLogEntry {
  id: number;
  sessionId: string;
  sequence: number;
  input: unknown;
  createdAt: Date;
}
