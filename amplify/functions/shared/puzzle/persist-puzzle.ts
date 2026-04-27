/** Items shape stored in DailyTrendPuzzle.items JSON. */
export function getPuzzleItemCount(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.length;
}

export function isPuzzleReadyForPlay(row: { computeState?: string | null; items?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.computeState === "ready" && getPuzzleItemCount(row.items) >= 5;
}
