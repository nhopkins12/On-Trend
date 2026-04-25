import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deterministicPickFiveFromPool,
  generateTrendPuzzle,
  MIN_PUZZLE_FRIENDLY_POOL,
  puzzleDateId,
  sanitizeTerm,
} from "./trends";

describe("deterministicPickFiveFromPool", () => {
  const pool = Array.from({ length: MIN_PUZZLE_FRIENDLY_POOL + 2 }, (_, i) => `StableWord${i}`);

  it("returns five terms", () => {
    const out = deterministicPickFiveFromPool(pool, "puzzle-2026-04-24");
    expect(out).toHaveLength(5);
  });

  it("is reproducible for the same seed key", () => {
    const a = deterministicPickFiveFromPool(pool, "same-seed");
    const b = deterministicPickFiveFromPool(pool, "same-seed");
    expect(a).toEqual(b);
  });

  it("varies with seed key", () => {
    const a = deterministicPickFiveFromPool(pool, "seed-a");
    const b = deterministicPickFiveFromPool(pool, "seed-b");
    expect(a).not.toEqual(b);
  });

  it("places forcedSeed first when valid", () => {
    const small = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda"];
    const out = deterministicPickFiveFromPool(small, "x", "Gamma");
    expect(out[0]).toBe("Gamma");
    expect(out).toHaveLength(5);
  });

  it("throws when pool too small", () => {
    const tiny = ["a", "b", "c"];
    expect(() => deterministicPickFiveFromPool(tiny, "k")).toThrow(/Need at least/);
  });
});

describe("sanitizeTerm", () => {
  it("normalizes whitespace", () => {
    expect(sanitizeTerm("  foo  bar  ")).toBe("foo bar");
  });
});

describe("puzzleDateId", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns YYYY-MM-DD for a fixed instant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00Z"));
    const id = puzzleDateId(0);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(id)).toBe(true);
  });

  it("offsetDays advances the puzzle clock by one civil day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00Z"));
    const today = puzzleDateId(0);
    const next = puzzleDateId(1);
    expect(next).not.toBe(today);
    expect(next > today).toBe(true);
  });
});

describe("rankFiveTermsStrict via generateTrendPuzzle", () => {
  const prevFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = prevFetch as typeof fetch;
    delete process.env.TRENDS_FETCH_MODE;
    delete process.env.SERPAPI_KEY;
  });

  it("throws when multiline returns no timeline (strict)", async () => {
    process.env.TRENDS_FETCH_MODE = "direct";
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/trends/api/dailytrends")) {
        const body = {
          default: {
            trendingSearchesDays: [
              {
                trendingSearches: Array.from({ length: 12 }, (_, i) => ({
                  title: { query: `Word${i}` },
                })),
              },
            ],
          },
        };
        return new Response(`)]}',\n${JSON.stringify(body)}`, { status: 200 });
      }
      if (u.includes("/trends/api/explore")) {
        const body = {
          widgets: [{ id: "TIMESERIES", token: "t", request: { foo: 1 } }],
        };
        return new Response(`)]}',\n${JSON.stringify(body)}`, { status: 200 });
      }
      if (u.includes("/trends/api/widgetdata/multiline")) {
        const body = { default: { timelineData: [] } };
        return new Response(`)]}',\n${JSON.stringify(body)}`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(
      generateTrendPuzzle({ puzzleId: "2026-04-24", sourceDate: "2026-04-24" }),
    ).rejects.toThrow(/Incomplete Google Trends interest data/);
  });
});
