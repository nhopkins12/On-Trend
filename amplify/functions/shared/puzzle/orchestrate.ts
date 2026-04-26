import type { GeneratedPuzzle, TrendItem } from "../trends";
import {
  deterministicPickFiveFromPool,
  FIXED_TIMEFRAME,
  GENERATION_MAX_ATTEMPTS,
  getPuzzlePickStrategy,
  isPuzzleFriendlyTerm,
  MIN_SCORE_SPREAD,
  pickFiveStratified,
  puzzleDateId,
  sanitizeTerm,
  TREND_ITEMS_PER_PUZZLE,
} from "../trends";
import { bqRegionKeyLabel, rankTermsFromBigQuery, resolveBqRefreshDate } from "./bigquery-rank";
import { fetchDailyCandidates } from "./candidates";

function logPuzzleStage(payload: Record<string, unknown>) {
  console.log(JSON.stringify({ source: "trends.puzzle.orchestrate", ...payload }));
}

function scoreSpreadFromScores(scores: Map<string, number>): number {
  const vals = [...scores.values()];
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
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

  const candidates = await fetchDailyCandidates();
  logPuzzleStage({
    stage: "candidates_fetched",
    puzzleId: options.puzzleId,
    strategy,
    bqpRefreshDate,
    rawCount: candidates.length,
  });

  const regionKey = bqRegionKeyLabel();
  const topicSeed = options.forcedSeed?.trim() ? String(sanitizeTerm(options.forcedSeed.trim()) || "") : "";
  const rankSource = "bigquery:international_top_terms";

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

    logPuzzleStage({
      stage: "bq_rank_ok",
      puzzleId: options.puzzleId,
      attempt,
      pickedTerms,
      scoreSpread: spread,
      ms: Date.now() - t0,
    });

    if (spread >= MIN_SCORE_SPREAD || attempt === GENERATION_MAX_ATTEMPTS - 1) {
      if (spread < MIN_SCORE_SPREAD) {
        logPuzzleStage({ stage: "low_spread_accepted", puzzleId: options.puzzleId, attempt, scoreSpread: spread });
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
    logPuzzleStage({ stage: "low_spread_retry", puzzleId: options.puzzleId, attempt, scoreSpread: spread });
  }

  throw new Error("runBigQueryPuzzle: exhausted pick attempts");
}
