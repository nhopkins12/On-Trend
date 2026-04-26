import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicPickFiveFromPool, generateTrendPuzzle, isPuzzleAcceptableLoose, isPuzzleFriendlyTerm, mergeOrderedUnique, MIN_PUZZLE_FRIENDLY_POOL, pickFiveStratified, pickQuintileIndices, puzzleDateId, sanitizeTerm, } from "./trends";
describe("mergeOrderedUnique", () => {
    it("keeps legacy order and appends RSS-only terms", () => {
        const merged = mergeOrderedUnique(["A", "B", "C"], ["B", "D", "E"]);
        expect(merged).toEqual(["A", "B", "C", "D", "E"]);
    });
});
describe("pickQuintileIndices", () => {
    it("returns 5 indices in range for W >= 5", () => {
        const idx = pickQuintileIndices(20, "pid", 0);
        expect(idx).toHaveLength(5);
        for (const j of idx) {
            expect(j).toBeGreaterThanOrEqual(0);
            expect(j).toBeLessThan(20);
        }
    });
    it("is deterministic for the same inputs", () => {
        const a = pickQuintileIndices(30, "x", 1);
        const b = pickQuintileIndices(30, "x", 1);
        expect(a).toEqual(b);
    });
    it("varies with attempt", () => {
        const a = pickQuintileIndices(30, "pid", 0);
        const b = pickQuintileIndices(30, "pid", 1);
        expect(a).not.toEqual(b);
    });
});
describe("pickFiveStratified", () => {
    const makeOrdered = (n) => Array.from({ length: n }, (_, i) => {
        if (i % 3 === 0) {
            return `Event News ${i}`;
        }
        return `Story Topic ${i}`;
    });
    it("returns 5 terms", () => {
        const ordered = makeOrdered(15);
        const out = pickFiveStratified(ordered, "2026-04-30", 0);
        expect(out).toHaveLength(5);
    });
    it("is stable for a fixed puzzleId and attempt", () => {
        const ordered = makeOrdered(20);
        const a = pickFiveStratified(ordered, "puzzle-1", 0);
        const b = pickFiveStratified(ordered, "puzzle-1", 0);
        expect(a).toEqual(b);
    });
});
describe("two-tier acceptability", () => {
    it("rejects more than loose when isPuzzleFriendly is false", () => {
        const t = "is running late";
        expect(isPuzzleFriendlyTerm(t)).toBe(false);
        expect(isPuzzleAcceptableLoose("running late event")).toBe(true);
    });
});
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
    const prevStrategy = process.env.PUZZLE_PICK_STRATEGY;
    afterEach(() => {
        globalThis.fetch = prevFetch;
        delete process.env.TRENDS_FETCH_MODE;
        delete process.env.SERPAPI_KEY;
        if (prevStrategy === undefined) {
            delete process.env.PUZZLE_PICK_STRATEGY;
        }
        else {
            process.env.PUZZLE_PICK_STRATEGY = prevStrategy;
        }
    });
    it("throws when multiline returns no timeline (strict)", async () => {
        process.env.TRENDS_FETCH_MODE = "direct";
        if (process.env.PUZZLE_PICK_STRATEGY === undefined) {
            // default is stratified
        }
        globalThis.fetch = vi.fn(async (url) => {
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
        });
        await expect(generateTrendPuzzle({ puzzleId: "2026-04-24", sourceDate: "2026-04-24" })).rejects.toThrow(/Incomplete Google Trends interest data/);
    });
});
