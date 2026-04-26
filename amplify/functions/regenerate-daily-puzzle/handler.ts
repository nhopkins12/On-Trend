import type { Schema } from "../../data/resource";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/regenerate-daily-puzzle";
import { deriveStatusForDate, generateTrendPuzzle, puzzleDateId } from "../shared/trends";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();
const authOptions = { authMode: "iam" as const };

function logJson(payload: Record<string, unknown>) {
  console.log(JSON.stringify({ source: "regenerate-daily-puzzle", ...payload }));
}

export const handler: Schema["regenerateDailyPuzzle"]["functionHandler"] = async (event) => {
  const id = String(event.arguments?.id || "").slice(0, 10);
  const requestedStatus = String(event.arguments?.status || "").toLowerCase();
  const topicSeed = String(event.arguments?.topicSeed || "").trim();
  const sourceDate = String(event.arguments?.sourceDate || puzzleDateId(0)).slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) {
    return {
      ok: false,
      id: "",
      message: "Invalid id format; expected YYYY-MM-DD",
      itemCount: 0,
      status: "",
      topicSeed: "",
      sourceDate: "",
      timeframe: "",
    };
  }

  const todayId = puzzleDateId(0);
  const status = (requestedStatus === "active" || requestedStatus === "next" || requestedStatus === "archived")
    ? requestedStatus
    : deriveStatusForDate(id, todayId);

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
    return {
      ok: false,
      message: `Failed generating trend puzzle: ${m}`,
      id,
      itemCount: 0,
      status: "",
      topicSeed: "",
      sourceDate: "",
      timeframe: "",
    };
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

  if (status === "active" || status === "next") {
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
  return {
    ok: true,
    id,
    status,
    topicSeed: generated.topicSeed,
    sourceDate: generated.sourceDate,
    itemCount: generated.items.length,
    timeframe: generated.timeframe,
  };
};
