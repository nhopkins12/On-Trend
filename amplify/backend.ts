import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { dailyTrends } from "./functions/daily-trends/resource";
import { regenerateDailyPuzzle } from "./functions/regenerate-daily-puzzle/resource";

defineBackend({
  auth,
  data,
  dailyTrends,
  regenerateDailyPuzzle,
});
