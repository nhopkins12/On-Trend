import { defineFunction } from "@aws-amplify/backend";

export const dailyTrends = defineFunction({
  name: "daily-trends",
  schedule: "0 6 ? * * *",
  entry: "./handler.ts",
  // Default Amplify function timeout is 3s — puzzle generation needs many sequential
  // HTTP calls to Google Trends (and optional SerpAPI), so it will time out otherwise.
  timeoutSeconds: 120,
});
