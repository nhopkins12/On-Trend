import type { Schema } from "../../data/resource";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/regenerate-daily-puzzle";
import { isPuzzleReadyForPlay } from "../shared/puzzle/persist-puzzle";
import { deriveStatusForDate, generateTrendPuzzle, puzzleDateId } from "../shared/trends";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();
const authOptions = { authMode: "iam" as const };

function logJson(payload: Record<string, unknown>) {
  console.log(JSON.stringify({ source: "regenerate-daily-puzzle", ...payload }));
}

/**
 * Invoked with `Event` (async) — the GraphQL mutation returns `{ success: true }` as soon
 * as this function is **queued**; the client does not receive the puzzle in the response.
 * Poll `DailyTrendPuzzle` for the given `id` (or check CloudWatch) for `computeState` and `items`.
 */
export const handler: Schema["regenerateDailyPuzzle"]["functionHandler"] = async (event) => {
  const id = String(event.arguments?.id || "").slice(0, 10);
  const requestedStatus = String(event.arguments?.status || "").toLowerCase();
  const topicSeed = String(event.arguments?.topicSeed || "").trim();
  const sourceDate = String(event.arguments?.sourceDate || puzzleDateId(0)).slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) {
    logJson({ event: "regenerate_invalid_id", id });
    return;
  }

  const todayId = puzzleDateId(0);
  const status = (requestedStatus === "active" || requestedStatus === "next" || requestedStatus === "archived")
    ? requestedStatus
    : deriveStatusForDate(id, todayId);

  const pendingBase: Record<string, unknown> = {
    id,
    status,
    scope: "global",
    sourceDate,
    topicSeed: topicSeed || "",
    items: [] as unknown[],
    timeframe: "now 7-d",
    rankSource: "",
    bqpRefreshDate: "",
    regionKey: "",
    computeState: "pending",
  };
  try {
    await client.models.DailyTrendPuzzle.create(pendingBase as any, authOptions);
  } catch {
    try {
      await client.models.DailyTrendPuzzle.update(pendingBase as any, authOptions);
    } catch (e) {
      logJson({ event: "regenerate_pending_write_failed", id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  let generated;
  try {
    generated = await generateTrendPuzzle({
      puzzleId: id,
      sourceDate,
      forcedSeed: topicSeed || undefined,
    });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    logJson({ event: "regenerate_failed", id, message: m });
    const failPayload: Record<string, unknown> = {
      id,
      status,
      scope: "global",
      sourceDate: sourceDate,
      topicSeed: "",
      items: [] as unknown[],
      timeframe: "now 7-d",
      rankSource: "",
      bqpRefreshDate: "",
      regionKey: "",
      computeState: "failed",
    };
    try {
      await client.models.DailyTrendPuzzle.create(failPayload as any, authOptions);
    } catch {
      try {
        await client.models.DailyTrendPuzzle.update(failPayload as any, authOptions);
      } catch {
        // no-op
      }
    }
    return;
  }

  const payload: Record<string, unknown> = {
    id,
    status,
    scope: "global",
    sourceDate: generated.sourceDate,
    topicSeed: generated.topicSeed,
    items: generated.items,
    timeframe: generated.timeframe,
    rankSource: generated.rankSource,
    bqpRefreshDate: generated.bqpRefreshDate,
    regionKey: generated.regionKey,
    computeState: "ready",
  };

  try {
    await client.models.DailyTrendPuzzle.create(payload as any, authOptions);
  } catch {
    await client.models.DailyTrendPuzzle.update(payload as any, authOptions);
  }

  if ((status === "active" || status === "next") && isPuzzleReadyForPlay(payload as any)) {
    try {
      const { data } = await client.models.DailyTrendPuzzle.list(authOptions);
      const all = Array.isArray(data) ? data : [];
      for (const puzzle of all) {
        if (!puzzle?.id || puzzle.id === id || puzzle.status !== status) continue;
        const fallback = puzzle.id < todayId ? "archived" : status === "active" ? "next" : "archived";
        try {
          await client.models.DailyTrendPuzzle.update({ id: puzzle.id, status: fallback }, authOptions);
        } catch {
          // no-op
        }
      }
    } catch {
      // no-op
    }
  }

  logJson({ event: "regenerate_ok", id, status, itemCount: generated.items.length });
};
