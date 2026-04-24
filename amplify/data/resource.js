import { a, defineData } from "@aws-amplify/backend";
import { dailyTrends } from "../functions/daily-trends/resource";
import { overrideTrendPuzzle } from "../functions/override-trend-puzzle/resource";
const schema = a
    .schema({
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
    overrideTrendPuzzle: a
        .query()
        .arguments({
        id: a.string(),
        status: a.string(),
        topicSeed: a.string(),
        sourceDate: a.string(),
    })
        .returns(a.json())
        .authorization((allow) => [allow.publicApiKey()])
        .handler(a.handler.function(overrideTrendPuzzle)),
})
    .authorization((allow) => [allow.resource(dailyTrends), allow.resource(overrideTrendPuzzle)]);
export const data = defineData({
    schema,
    authorizationModes: {
        defaultAuthorizationMode: "apiKey",
        apiKeyAuthorizationMode: {
            expiresInDays: 30,
        },
    },
});
