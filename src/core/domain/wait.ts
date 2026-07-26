// Durable sleep (design.md D6 "THE PATTERN", task 6.1b): a `waitKey`
// (signal-based wakeup), a `wakeAt` (timer-based wakeup), or both (a
// hybrid wait, woken by whichever fires first) - see core/database/
// schema.sql's CHECK constraint for the "at least one" invariant.
export interface Wait {
  id: number;
  executionId: number;
  waitKey: string | null;
  wakeAt: Date | null;
  satisfiedAt: Date | null;
  createdAt: Date;
}
