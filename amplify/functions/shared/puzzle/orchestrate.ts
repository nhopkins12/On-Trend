import type { GeneratedPuzzle, TrendItem } from "../trends";
import {
  deterministicPickFiveFromPool,
  FIXED_TIMEFRAME,
  GENERATION_MAX_ATTEMPTS,
  getPuzzlePickStrategy,
  isPuzzleFriendlyTerm,
  MIN_ORDERED_CANDIDATES,
  MIN_SCORE_SPREAD,
  pickFiveStratified,
  puzzleDateId,
  sanitizeTerm,
  TREND_ITEMS_PER_PUZZLE,
} from "../trends";
import {
  bqRegionKeyLabel,
  listBqTopTermsForDate,
  rankTermsFromBigQuery,
  resolveBqRefreshDate,
} from "./bigquery-rank";
import { fetchDailyCandidates } from "./candidates";

function logPuzzleStage(payload: Record<string, unknown>) {
  console.log(JSON.stringify({ source: "trends.puzzle.orchestrate", ...payload }));
}

function scoreSpreadFromScores(scores: Map<string, number>): number {
  const vals = [...scores.values()];
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

function rankSpreadFromRanks(terms: string[], byTerm: Map<string, { rank: number; score: number }>): number {
  const r = terms.map((t) => byTerm.get(t)?.rank).filter((n): n is number => n != null && Number.isFinite(n));
  if (r.length < 2) return 0;
  return Math.max(...r) - Math.min(...r);
}

function bqMinRankSpread(): number {
  const n = Number(process.env.PUZZLE_BQ_MIN_RANK_SPREAD);
  if (Number.isFinite(n) && n >= 0) return n;
  return 2;
}

type PickStrategy = "stratified" | "legacy";

function pickFive(
  strategy: PickStrategy,
  candidates: string[],
  puzzleId: string,
  attempt: number,
  forcedSeed: string | undefined,
): string[] {
  if (strategy === "legacy") {
    const puzzleFriendlyCandidates = candidates.filter((x) => isPuzzleFriendlyTerm(x));
    return deterministicPickFiveFromPool(
      puzzleFriendlyCandidates,
      `${puzzleId}:lowSpreadRetry:${attempt}`,
      forcedSeed,
    );
  }
  return pickFiveStratified(candidates, puzzleId, attempt, forcedSeed);
}

export async function runBigQueryPuzzle(options: {
  puzzleId: string;
  sourceDate?: string;
  forcedSeed?: string;
}): Promise<GeneratedPuzzle> {
  const sourceDate = options.sourceDate || puzzleDateId(0);
  const bqpRefreshDate = resolveBqRefreshDate(sourceDate);
  const strategy = getPuzzlePickStrategy();
  const t0 = Date.now();

  const fromFeeds = await fetchDailyCandidates();
  const bqTopOrdered = await listBqTopTermsForDate(bqpRefreshDate);
  if (bqTopOrdered.length < TREND_ITEMS_PER_PUZZLE) {
    throw new Error(
      `BigQuery has fewer than ${TREND_ITEMS_PER_PUZZLE} distinct top terms for refresh_date=${bqpRefreshDate}. Check data lag, PUZZLE_BQ_*, and PUZZLE_BQ_REFRESH_OFFSET_DAYS.`,
    );
  }
  const bqSet = new Set(bqTopOrdered.map((t) => t.toLowerCase()));
  const intersection = fromFeeds.filter((c) => bqSet.has(c.toLowerCase()));
  const candidates =
    intersection.length >= MIN_ORDERED_CANDIDATES
      ? intersection
      : bqTopOrdered;
  const feedOverlap = intersection.length;
  logPuzzleStage({
    stage: "candidates_fetched",
    puzzleId: options.puzzleId,
    strategy,
    bqpRefreshDate,
    rawCount: fromFeeds.length,
    bqTopCount: bqTopOrdered.length,
    feedBqIntersection: feedOverlap,
    pickPoolSize: candidates.length,
    usingBqTopOnly: feedOverlap < MIN_ORDERED_CANDIDATES,
  });

  const regionKey = bqRegionKeyLabel();
  const topicSeed = options.forcedSeed?.trim() ? String(sanitizeTerm(options.forcedSeed.trim()) || "") : "";
  const rankSource = "bigquery:international_top_terms";

  const forced = options.forcedSeed?.trim() ? sanitizeTerm(options.forcedSeed.trim()) : null;
  if (forced) {
    if (!candidates.some((c) => c.toLowerCase() === forced.toLowerCase())) {
      throw new Error(
        `forcedSeed "${forced}" is not in the BigQuery pick pool for this date. Choose a term from that day's public top set (or clear topicSeed).`,
      );
    }
  }

  for (let attempt = 0; attempt < GENERATION_MAX_ATTEMPTS; attempt++) {
    let pickedTerms: string[];
    try {
      pickedTerms = pickFive(strategy, candidates, options.puzzleId, attempt, options.forcedSeed);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logPuzzleStage({ stage: "pick_failed", puzzleId: options.puzzleId, attempt, error: err.message });
      throw err;
    }

    let byTerm: Map<string, { rank: number; score: number }>;
    try {
      byTerm = await rankTermsFromBigQuery(pickedTerms, bqpRefreshDate);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const canRetry = attempt < GENERATION_MAX_ATTEMPTS - 1;
      logPuzzleStage({
        stage: "bq_rank_failed",
        puzzleId: options.puzzleId,
        attempt,
        error: err.message,
        willRetry: canRetry,
      });
      if (canRetry) continue;
      throw err;
    }

    if (byTerm.size !== TREND_ITEMS_PER_PUZZLE) {
      if (attempt < GENERATION_MAX_ATTEMPTS - 1) {
        logPuzzleStage({ stage: "bq_incomplete", puzzleId: options.puzzleId, attempt, size: byTerm.size });
        continue;
      }
      throw new Error("BigQuery returned unexpected term count after rank.");
    }

    const scoreMap = new Map<string, number>();
    for (const t of pickedTerms) {
      const v = byTerm.get(t);
      if (!v) continue;
      scoreMap.set(t, v.score);
    }

    const spread = scoreSpreadFromScores(scoreMap);
    const sorted = [...pickedTerms].sort((a, b) => {
      const ra = byTerm.get(a)?.rank ?? 99;
      const rb = byTerm.get(b)?.rank ?? 99;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
    const items: TrendItem[] = sorted.map((term, idx) => ({
      term,
      rank: idx + 1,
      score: byTerm.get(term)?.score ?? null,
    }));

    const rSpread = rankSpreadFromRanks(pickedTerms, byTerm);
    logPuzzleStage({
      stage: "bq_rank_ok",
      puzzleId: options.puzzleId,
      attempt,
      pickedTerms,
      scoreSpread: spread,
      rankSpread: rSpread,
      ms: Date.now() - t0,
    });
    const spreadOk = spread >= MIN_SCORE_SPREAD || rSpread >= bqMinRankSpread();

    if (spreadOk || attempt === GENERATION_MAX_ATTEMPTS - 1) {
      if (!spreadOk) {
        logPuzzleStage({
          stage: "low_spread_accepted",
          puzzleId: options.puzzleId,
          attempt,
          scoreSpread: spread,
          rankSpread: rSpread,
        });
      }
      return {
        topicSeed,
        sourceDate,
        timeframe: FIXED_TIMEFRAME,
        items,
        rankSource,
        bqpRefreshDate,
        regionKey,
      };
    }
    logPuzzleStage({
      stage: "low_spread_retry",
      puzzleId: options.puzzleId,
      attempt,
      scoreSpread: spread,
      rankSpread: rSpread,
      needScore: MIN_SCORE_SPREAD,
      needRank: bqMinRankSpread(),
    });
  }

  throw new Error("runBigQueryPuzzle: exhausted pick attempts");
}
