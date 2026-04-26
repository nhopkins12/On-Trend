import { describe, expect, it } from "vitest";
import { resolveBqRefreshDate } from "./bigquery-rank";

describe("resolveBqRefreshDate", () => {
  it("applies default offset of -1 day in UTC for source date", () => {
    const prev = process.env.PUZZLE_BQ_REFRESH_OFFSET_DAYS;
    delete process.env.PUZZLE_BQ_REFRESH_OFFSET_DAYS;
    expect(resolveBqRefreshDate("2026-04-15")).toBe("2026-04-14");
    if (prev === undefined) delete process.env.PUZZLE_BQ_REFRESH_OFFSET_DAYS;
    else process.env.PUZZLE_BQ_REFRESH_OFFSET_DAYS = prev;
  });
});
