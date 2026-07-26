export interface Checkpoint {
  executionId: number;
  stepId: string;
  output: unknown;
  committedAt: Date;
}
