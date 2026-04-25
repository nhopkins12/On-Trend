import { defineFunction } from "@aws-amplify/backend";

export const overrideTrendPuzzle = defineFunction({
  name: "override-trend-puzzle",
  entry: "./handler.ts",
  timeoutSeconds: 120,
});
