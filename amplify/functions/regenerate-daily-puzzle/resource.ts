import { defineFunction } from "@aws-amplify/backend";

export const regenerateDailyPuzzle = defineFunction({
  name: "regenerate-daily-puzzle",
  entry: "./handler.ts",
  timeoutSeconds: 180,
  memoryMB: 512,
});
