import { defineFunction } from "@aws-amplify/backend";

export const dailyTrends = defineFunction({
  name: "daily-trends",
  schedule: "0 6 ? * * *",
  entry: "./handler.ts",
});
