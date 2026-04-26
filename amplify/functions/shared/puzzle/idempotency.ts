/**
 * Idempotent puzzle writes: handlers use `DailyTrendPuzzle` create-then-update by `id`.
 * The scheduled job (`daily-trends`) skips generation when tomorrow’s row is already
 * `computeState=ready` and `status=next`.
 *
 * For a future async design (SQS + worker + DLQ), reuse the same `id` as the
 * idempotency key and write the final row only once from the consumer.
 */
export const PUZZLE_IDEMPOTENCY_KEY_FIELD = "id";
