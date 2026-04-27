import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { dailyTrends } from "../functions/daily-trends/resource";
import { regenerateDailyPuzzle } from "../functions/regenerate-daily-puzzle/resource";

const schema = a
  .schema({
    /** GraphQL return for `regenerateDailyPuzzle` (async: job accepted, not the puzzle payload). */
    RegenerateDailyPuzzleResult: a.customType({
      success: a.boolean().required(),
    }),

    DailyTrendPuzzle: a
      .model({
        id: a.id(),
        status: a.string(), // next | active | archived
        scope: a.string(), // global
        sourceDate: a.string(), // date from Google Trends source
        topicSeed: a.string(),
        items: a.json(), // Array<{ term: string; rank: number; score?: number | null }>
        computeState: a.string(), // pending | ready | failed
        timeframe: a.string(), // now 1-d
        rankSource: a.string(), // e.g. bigquery:international | legacy:google_multiline
        bqpRefreshDate: a.string(), // YYYY-MM-DD partition used in BigQuery
        regionKey: a.string(), // e.g. US | US:US-CA
      })
      .authorization((allow) => [allow.publicApiKey()]),

    TrendScore: a
      .model({
        id: a.id(), // userId#puzzleId
        userId: a.string(),
        puzzleId: a.string(),
        name: a.string(),
        correctCount: a.integer(),
        mistakes: a.integer(),
        placementLog: a.json(),
      })
      .authorization((allow) => [
        allow.publicApiKey().to(["read"]),
        allow.authenticated().to(["create", "read", "update"]),
      ]),

    regenerateDailyPuzzle: a
      .mutation()
      .arguments({
        id: a.string(),
        status: a.string(),
        topicSeed: a.string(),
        sourceDate: a.string(),
      })
      .returns(a.ref("RegenerateDailyPuzzleResult"))
      .authorization((allow) => [allow.authenticated()])
      // Async invocation: AppSync returns immediately; Lambda can run up to timeout (see resource.ts).
      .handler(a.handler.function(regenerateDailyPuzzle).async()),
  })
  .authorization((allow) => [allow.resource(dailyTrends), allow.resource(regenerateDailyPuzzle)]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});
