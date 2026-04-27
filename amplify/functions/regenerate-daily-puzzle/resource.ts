import { defineFunction } from "@aws-amplify/backend";

export const regenerateDailyPuzzle = defineFunction({
  name: "regenerate-daily-puzzle",
  entry: "./handler.ts",
  // Puzzle generation (RSS, optional legacy HTTTP, BigQuery) can run far longer than the AppSync sync limit; handler uses .async() so the client is not blocked. Match Lambda to max practical duration.
  timeoutSeconds: 900,
  memoryMB: 1024,
});
