import { describe, expect, it } from "vitest";
import { getPuzzleItemCount, isPuzzleReadyForPlay } from "./persist-puzzle";

describe("persist-puzzle", () => {
  it("detects ready row with five items", () => {
    expect(
      isPuzzleReadyForPlay({
        computeState: "ready",
        items: [{}, {}, {}, {}, {}],
      }),
    ).toBe(true);
  });

  it("rejects failed or short items", () => {
    expect(isPuzzleReadyForPlay({ computeState: "failed", items: [] })).toBe(false);
    expect(isPuzzleReadyForPlay({ computeState: "ready", items: [{}, {}] })).toBe(false);
  });

  it("counts items", () => {
    expect(getPuzzleItemCount(null)).toBe(0);
    expect(getPuzzleItemCount([1, 2, 3])).toBe(3);
  });
});
