import type { EventBridgeHandler } from "aws-lambda";
import type { Schema } from "../../data/resource";

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/daily-trends";
import { generateTrendPuzzle, puzzleDateId } from "../shared/trends";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();
const authOptions = { authMode: "iam" as const };

function logJson(payload: Record<string, unknown>) {
  console.log(JSON.stringify({ source: "daily-trends", ...payload }));
}

export const handler: EventBridgeHandler<"Scheduled Event", null, void> = async () => {
  const todayId = puzzleDateId(0);
  const tomorrowId = puzzleDateId(1);

  try {
    const { data: todayPuzzle } = await client.models.DailyTrendPuzzle.get({ id: todayId }, authOptions);
    if (todayPuzzle && todayPuzzle.status !== "active" && todayPuzzle.computeState === "ready") {
      await client.models.DailyTrendPuzzle.update({ id: todayId, status: "active" }, authOptions);
    }
  } catch (err) {
    console.warn("Failed to promote today's puzzle", err);
  }

  try {
    const { data } = await client.models.DailyTrendPuzzle.list(authOptions);
    const all = Array.isArray(data) ? data : [];

    for (const puzzle of all) {
      if (!puzzle?.id || puzzle.id === todayId) continue;
      if (puzzle.status === "active") {
        const fallback = puzzle.id < todayId ? "archived" : "next";
        try {
          await client.models.DailyTrendPuzzle.update({ id: puzzle.id, status: fallback }, authOptions);
        } catch {
          // no-op
        }
      }
    }
  } catch (err) {
    console.warn("Failed to normalize puzzle statuses", err);
  }

  try {
    const { data: existing } = await client.models.DailyTrendPuzzle.get({ id: tomorrowId }, authOptions);
    if (existing && existing.computeState === "ready" && existing.status === "next") {
      return;
    }

    let payload: any = {
      id: tomorrowId,
      status: "next",
      scope: "global",
      computeState: "pending",
    };

    try {
      const generated = await generateTrendPuzzle({ puzzleId: tomorrowId, sourceDate: todayId });
      payload = {
        ...payload,
        topicSeed: generated.topicSeed,
        sourceDate: generated.sourceDate,
        items: generated.items,
        timeframe: generated.timeframe,
        rankSource: generated.rankSource,
        bqpRefreshDate: generated.bqpRefreshDate,
        regionKey: generated.regionKey,
        computeState: "ready",
      };
      logJson({ event: "puzzle_generated", puzzleId: tomorrowId, itemCount: generated.items.length });
    } catch (err) {
      logJson({
        event: "puzzle_generation_failed",
        puzzleId: tomorrowId,
        message: err instanceof Error ? err.message : String(err),
      });
      payload = {
        ...payload,
        topicSeed: "",
        sourceDate: todayId,
        items: [],
        timeframe: "now 7-d",
        rankSource: "",
        bqpRefreshDate: "",
        regionKey: "",
        computeState: "failed",
      };
    }

    try {
      await client.models.DailyTrendPuzzle.create(payload, authOptions);
    } catch {
      await client.models.DailyTrendPuzzle.update(payload, authOptions);
    }
  } catch (err) {
    console.warn("Failed to prepare tomorrow's trend puzzle", err);
  }
};
