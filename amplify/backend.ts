import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { dailyTrends } from "./functions/daily-trends/resource";
import { overrideTrendPuzzle } from "./functions/override-trend-puzzle/resource";

defineBackend({
  auth,
  data,
  dailyTrends,
  overrideTrendPuzzle,
});
