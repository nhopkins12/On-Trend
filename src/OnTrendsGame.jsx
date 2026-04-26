import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from "react";
import { generateClient } from "aws-amplify/data";
import "@aws-amplify/ui-react/styles.css";
import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import PillHighlight from "./PillHighlight";

const LazyAuthenticator = lazy(() =>
  import("@aws-amplify/ui-react").then((m) => ({ default: m.Authenticator })),
);

function hashString(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicShuffle(items, seedKey) {
  const rng = mulberry32(hashString(seedKey));
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseItems(rawItems) {
  const parsed = Array.isArray(rawItems)
    ? rawItems
    : typeof rawItems === "string"
      ? JSON.parse(rawItems)
      : [];

  return Array.isArray(parsed)
    ? parsed
        .map((item) => ({
          term: String(item?.term || "").trim(),
          rank: Number(item?.rank),
          score: typeof item?.score === "number" ? item.score : null,
        }))
        .filter((item) => item.term && Number.isFinite(item.rank))
        .sort((a, b) => a.rank - b.rank)
    : [];
}

/** Must match the API’s `puzzleDateId(0)` (same IANA as backend `PUZZLE_TIME_ZONE`). */
const PUZZLE_TIME_ZONE = "America/New_York";

function todayPuzzleDateId() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: PUZZLE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

const TOTAL_ITEMS = 5;
const DEFAULT_TIMEFRAME = "now 7-d";

/** Set `VITE_MOCK_PUZZLE=1` in `.env` / `.env.local` to play without AppSync (UI / layout only). */
const MOCK_PUZZLE_ENABLED = import.meta.env.VITE_MOCK_PUZZLE === "1";

const DEV_MOCK_ITEMS = [
  { term: "Generative AI", rank: 1, score: 100 },
  { term: "Electric vehicles", rank: 2, score: 86 },
  { term: "Championship final", rank: 3, score: 72 },
  { term: "Box office", rank: 4, score: 58 },
  { term: "Music awards", rank: 5, score: 44 },
];

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const am = a?.mistakes ?? 99;
    const bm = b?.mistakes ?? 99;
    if (am !== bm) return am - bm;
    const ac = a?.correctCount ?? -1;
    const bc = b?.correctCount ?? -1;
    if (ac !== bc) return bc - ac;
    const ta = a?.createdAt ? new Date(a.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b?.createdAt ? new Date(b.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
}

export default function OnTrendsGame() {
  /** loading | ready | pending | failed | missing */
  const [puzzleCloudState, setPuzzleCloudState] = useState("loading");
  const [puzzleError, setPuzzleError] = useState("");
  const [puzzleRetryTick, setPuzzleRetryTick] = useState(0);
  /** Dev-only: shows when using mock or latest-ready fallback. */
  const [devPuzzleNote, setDevPuzzleNote] = useState("");

  const [puzzleId, setPuzzleId] = useState("");
  const [topicSeed, setTopicSeed] = useState("");
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [orderedItems, setOrderedItems] = useState([]);

  const [revealedItems, setRevealedItems] = useState([]);
  const [pendingQueue, setPendingQueue] = useState([]);
  const [correctCount, setCorrectCount] = useState(0);
  const [placementLog, setPlacementLog] = useState([]);
  const [lastResult, setLastResult] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [draggingPending, setDraggingPending] = useState(false);

  const [isComplete, setIsComplete] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState("");
  const [isAuthed, setIsAuthed] = useState(false);
  const [myUserId, setMyUserId] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [hasSavedScore, setHasSavedScore] = useState(false);
  const [isSavingScore, setIsSavingScore] = useState(false);

  const listContainerRef = useRef(null);
  const itemRefs = useRef([]);
  const saveTriggeredRef = useRef(false);

  const rankByTerm = useMemo(() => {
    const map = new Map();
    for (const item of orderedItems) {
      map.set(item.term, item.rank);
    }
    return map;
  }, [orderedItems]);

  const initializeGame = useCallback((items, pid) => {
    const orderedTerms = items.map((x) => x.term);
    const playOrder = deterministicShuffle(orderedTerms, `on-trends:${pid}`);

    const anchor = playOrder[0];
    const queue = playOrder.slice(1);

    setRevealedItems([anchor]);
    setPendingQueue(queue);
    setCorrectCount(1);
    setPlacementLog([
      {
        term: anchor,
        chosenIndex: 0,
        correctIndex: 0,
        wasCorrect: true,
        autoPlaced: true,
        interaction: "drag_drop",
      },
    ]);
    setLastResult(null);
    setDragOverIndex(null);
    setDraggingPending(false);
    setIsComplete(false);
    setHasSavedScore(false);
    setSaveError("");
    saveTriggeredRef.current = false;
  }, []);

  const loadTodayPuzzle = useCallback(async () => {
    setPuzzleCloudState("loading");
    setPuzzleError("");
    setDevPuzzleNote("");
    const todayId = todayPuzzleDateId();

    if (MOCK_PUZZLE_ENABLED) {
      setPuzzleCloudState("ready");
      setPuzzleId(todayId);
      setTopicSeed("");
      setTimeframe(DEFAULT_TIMEFRAME);
      setOrderedItems(DEV_MOCK_ITEMS);
      setDevPuzzleNote("Mock puzzle (VITE_MOCK_PUZZLE=1) — not loaded from the cloud.");
      initializeGame(DEV_MOCK_ITEMS, todayId);
      return;
    }

    try {
      const client = generateClient();
      const { data, errors } = await client.models.DailyTrendPuzzle.get({ id: todayId });

      if (errors?.length) {
        setPuzzleError(errors.map((e) => e.message).join("; ") || "Failed to load puzzle");
        setPuzzleCloudState("failed");
        return;
      }

      if (!data) {
        if (import.meta.env.DEV) {
          try {
            const { data: listData, errors: listErrors } = await client.models.DailyTrendPuzzle.list();
            if (!listErrors?.length && Array.isArray(listData)) {
              const ready = listData
                .filter(
                  (x) =>
                    x &&
                    String(x.computeState || "").toLowerCase() === "ready" &&
                    parseItems(x.items).length === TOTAL_ITEMS,
                )
                .sort((a, b) => String(b.id || "").localeCompare(String(a.id || "")));
              const row = ready[0];
              if (row) {
                const parsedItems = parseItems(row.items);
                const pid = String(row.id);
                setPuzzleCloudState("ready");
                setPuzzleId(pid);
                setTopicSeed(String(row.topicSeed || ""));
                setTimeframe(String(row.timeframe || DEFAULT_TIMEFRAME));
                setOrderedItems(parsedItems);
                setDevPuzzleNote(
                  `Dev fallback: no row for ${todayId} — using latest ready puzzle (${pid}) from your backend.`,
                );
                initializeGame(parsedItems, pid);
                return;
              }
            }
          } catch (fallbackErr) {
            console.warn("Dev fallback: list latest ready failed", fallbackErr);
          }
        }
        setPuzzleCloudState("missing");
        setPuzzleError(
          "No puzzle row for today yet. After deployment, the scheduled job writes the next day’s puzzle; today’s row may still be empty.",
        );
        return;
      }

      const compute = String(data.computeState || "").toLowerCase();
      if (compute === "pending") {
        setPuzzleCloudState("pending");
        setPuzzleId(String(data.id || ""));
        return;
      }

      if (compute === "failed") {
        setPuzzleCloudState("failed");
        setPuzzleId(String(data.id || ""));
        setPuzzleError("The backend could not rank today’s trends (strict scoring). Check Lambda env: TRENDS_FETCH_MODE, TRENDS_ORIGIN, or SERPAPI_KEY for vendor mode.");
        return;
      }

      if (compute !== "ready") {
        setPuzzleCloudState("failed");
        setPuzzleError(`Unexpected compute state: ${compute || "unknown"}`);
        return;
      }

      const parsedItems = parseItems(data.items);
      if (parsedItems.length !== TOTAL_ITEMS) {
        setPuzzleCloudState("failed");
        setPuzzleError(`Puzzle is incomplete (${parsedItems.length}/${TOTAL_ITEMS} ranked items).`);
        return;
      }

      setPuzzleCloudState("ready");
      setPuzzleId(String(data.id));
      setTopicSeed(String(data.topicSeed || ""));
      setTimeframe(String(data.timeframe || DEFAULT_TIMEFRAME));
      setOrderedItems(parsedItems);
      initializeGame(parsedItems, String(data.id));
    } catch (err) {
      console.warn("DailyTrendPuzzle.get failed", err);
      setPuzzleError(err?.message || "Network or configuration error loading the puzzle.");
      setPuzzleCloudState("failed");
    }
  }, [initializeGame]);

  useEffect(() => {
    loadTodayPuzzle();
  }, [loadTodayPuzzle, puzzleRetryTick]);

  const fetchLeaderboard = useCallback(async (pid) => {
    if (!pid || puzzleCloudState !== "ready") return;
    if (MOCK_PUZZLE_ENABLED) {
      setLeaderboardLoading(false);
      setLeaderboard([]);
      setLeaderboardError("");
      return;
    }
    setLeaderboardLoading(true);
    setLeaderboardError("");
    try {
      const client = generateClient();
      const { data, errors } = await client.models.TrendScore.list();
      if (errors?.length) {
        setLeaderboardError(errors.map((e) => e.message).join("; "));
        setLeaderboard([]);
        return;
      }

      const entries = (Array.isArray(data) ? data : []).filter((x) => x?.puzzleId === pid);
      const byUser = new Map();
      for (const entry of entries) {
        const key = entry?.userId || `name:${entry?.name || ""}`;
        const prev = byUser.get(key);
        if (!prev || (entry?.mistakes ?? 99) < (prev?.mistakes ?? 99)) {
          byUser.set(key, entry);
        }
      }

      const sorted = sortEntries(Array.from(byUser.values()));
      setLeaderboard(
        sorted.map((x) => ({
          name: x?.name || "Player",
          userId: x?.userId || "",
          correctCount: x?.correctCount ?? 0,
          mistakes: x?.mistakes ?? TOTAL_ITEMS,
        })),
      );
    } catch (err) {
      console.warn("Leaderboard fetch failed", err);
      setLeaderboardError("Could not load leaderboard.");
      setLeaderboard([]);
    } finally {
      setLeaderboardLoading(false);
    }
  }, [puzzleCloudState]);

  useEffect(() => {
    if (puzzleCloudState === "ready" && puzzleId) {
      fetchLeaderboard(puzzleId);
    }
  }, [puzzleId, puzzleCloudState, fetchLeaderboard]);

  useEffect(() => {
    (async () => {
      try {
        const user = await getCurrentUser();
        const attrs = await fetchUserAttributes();
        const uid = user?.userId || attrs?.sub || user?.username || "";
        setMyUserId(uid);
        setIsAuthed(Boolean(uid));
      } catch {
        setMyUserId("");
        setIsAuthed(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!authOpen) return undefined;
    const remove = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn") {
        (async () => {
          try {
            const user = await getCurrentUser();
            const attrs = await fetchUserAttributes();
            const uid = user?.userId || attrs?.sub || user?.username || "";
            setMyUserId(uid);
            setIsAuthed(Boolean(uid));
            setAuthOpen(false);
          } catch {
            // no-op
          }
        })();
      }
    });
    return () => remove();
  }, [authOpen]);

  const pendingTerm = pendingQueue[0] || "";
  const progress = Math.min(TOTAL_ITEMS, revealedItems.length);

  const placePendingAtIndex = useCallback(
    (chosenIndex) => {
      if (!pendingTerm || isComplete) return;

      const pendingRank = rankByTerm.get(pendingTerm);
      const correctIndex = revealedItems.filter((term) => (rankByTerm.get(term) ?? 999) < pendingRank).length;
      const wasCorrect = chosenIndex === correctIndex;

      const nextRevealed = [...revealedItems];
      nextRevealed.splice(correctIndex, 0, pendingTerm);

      const nextQueue = pendingQueue.slice(1);
      const nextCorrect = correctCount + (wasCorrect ? 1 : 0);

      const stepLog = {
        term: pendingTerm,
        chosenIndex,
        correctIndex,
        wasCorrect,
        autoPlaced: false,
        interaction: "drag_drop",
      };

      setRevealedItems(nextRevealed);
      setPendingQueue(nextQueue);
      setCorrectCount(nextCorrect);
      setPlacementLog((prev) => [...prev, stepLog]);
      setLastResult({
        term: pendingTerm,
        wasCorrect,
        chosenIndex,
        correctIndex,
      });
      setDragOverIndex(null);
      setDraggingPending(false);

      if (nextQueue.length === 0) {
        setIsComplete(true);
      }
    },
    [correctCount, isComplete, pendingQueue, pendingTerm, rankByTerm, revealedItems],
  );

  const getInsertionIndexFromY = useCallback(
    (clientY) => {
      for (let i = 0; i < revealedItems.length; i++) {
        const node = itemRefs.current[i];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (clientY < mid) return i;
      }
      return revealedItems.length;
    },
    [revealedItems],
  );

  const onDragStartPending = (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", pendingTerm || "");
    setDraggingPending(true);
  };

  const onDragEndPending = () => {
    setDraggingPending(false);
    setDragOverIndex(null);
  };

  const onListDragOver = (event) => {
    if (!pendingTerm || isComplete) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const idx = getInsertionIndexFromY(event.clientY);
    setDragOverIndex(idx);
  };

  const onListDrop = (event) => {
    if (!pendingTerm || isComplete) return;
    event.preventDefault();
    const idx = getInsertionIndexFromY(event.clientY);
    placePendingAtIndex(idx);
  };

  const resolveDisplayName = useCallback(async () => {
    try {
      const attrs = await fetchUserAttributes();
      const user = await getCurrentUser();
      return (
        attrs?.preferred_username ||
        (attrs?.email ? String(attrs.email).split("@")[0] : null) ||
        user?.username ||
        "Player"
      );
    } catch {
      return "Player";
    }
  }, []);

  const saveScore = useCallback(async () => {
    setSaveError("");
    if (!isComplete || !puzzleId) return;
    if (saveTriggeredRef.current) return;

    saveTriggeredRef.current = true;
    setIsSavingScore(true);

    try {
      const mistakes = TOTAL_ITEMS - correctCount;

      let userId = "";
      try {
        const user = await getCurrentUser();
        const attrs = await fetchUserAttributes();
        userId = user?.userId || attrs?.sub || user?.username || "";
      } catch {
        // no-op
      }

      if (!userId) {
        setAuthOpen(true);
        setSaveError("Sign in to save your score.");
        saveTriggeredRef.current = false;
        return;
      }

      const client = generateClient();
      const name = await resolveDisplayName();
      const id = `${userId}#${puzzleId}`;

      let existing = null;
      try {
        const { data } = await client.models.TrendScore.get({ id });
        existing = data || null;
      } catch {
        existing = null;
      }

      if (existing) {
        const oldMistakes = existing?.mistakes ?? TOTAL_ITEMS;
        const isBetter = mistakes < oldMistakes;
        if (isBetter) {
          await client.models.TrendScore.update(
            {
              id,
              userId,
              puzzleId,
              name,
              correctCount,
              mistakes,
              placementLog,
            },
            { authMode: "userPool" },
          );
        } else if (existing.name !== name) {
          await client.models.TrendScore.update(
            {
              id,
              name,
            },
            { authMode: "userPool" },
          );
        }
      } else {
        await client.models.TrendScore.create(
          {
            id,
            userId,
            puzzleId,
            name,
            correctCount,
            mistakes,
            placementLog,
          },
          { authMode: "userPool" },
        );
      }

      setHasSavedScore(true);
      await fetchLeaderboard(puzzleId);
    } catch (err) {
      console.warn("Failed to save trend score", err);
      setSaveError("Failed to save score. Try again.");
      saveTriggeredRef.current = false;
    } finally {
      setIsSavingScore(false);
    }
  }, [correctCount, fetchLeaderboard, isComplete, placementLog, puzzleId, resolveDisplayName]);

  useEffect(() => {
    if (!isComplete || hasSavedScore || isSavingScore) return;
    if (!isAuthed) return;
    saveScore();
  }, [hasSavedScore, isAuthed, isComplete, isSavingScore, saveScore]);

  useEffect(() => {
    if (puzzleCloudState !== "ready" || isComplete || !pendingTerm) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      const tag = e.target?.tagName?.toLowerCase?.() || "";
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
      const k = e.key;
      if (k < "1" || k > "5") return;
      const idx = Number.parseInt(k, 10) - 1;
      const max = revealedItems.length;
      if (idx >= 0 && idx <= max) {
        e.preventDefault();
        placePendingAtIndex(idx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [puzzleCloudState, isComplete, pendingTerm, revealedItems.length, placePendingAtIndex]);

  const showGame = puzzleCloudState === "ready" && orderedItems.length === TOTAL_ITEMS;
  const mistakesSoFar = TOTAL_ITEMS - correctCount;

  return (
    <div className="min-h-screen bg-white font-['Helvetica_Neue',_sans-serif]">
      <div className="max-w-4xl mx-auto px-6 py-12">
        {puzzleCloudState === "loading" && (
          <div className="fixed inset-0 z-40 bg-white/90 flex flex-col items-center justify-center gap-4">
            <PillHighlight text="LOADING" />
            <p className="text-sm text-gray-500">Fetching today’s puzzle from the cloud…</p>
          </div>
        )}

        {puzzleCloudState === "pending" && (
          <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
            <h2 className="text-lg font-semibold text-amber-900">Puzzle not ready</h2>
            <p className="text-sm text-amber-800 mt-2">
              Today’s row exists but ranking is still pending. The scheduled Lambda usually fills it ahead of time.
            </p>
            <button
              type="button"
              onClick={() => setPuzzleRetryTick((n) => n + 1)}
              className="mt-4 px-4 py-2 rounded-md bg-amber-700 text-white text-sm font-medium hover:bg-amber-800"
            >
              Retry
            </button>
          </div>
        )}

        {(puzzleCloudState === "failed" || puzzleCloudState === "missing") && (
          <div className="mb-8 rounded-xl border border-red-200 bg-red-50 p-6 text-center">
            <h2 className="text-lg font-semibold text-red-900">Could not load puzzle</h2>
            <p className="text-sm text-red-800 mt-2 whitespace-pre-wrap">{puzzleError}</p>
            {import.meta.env.DEV ? (
              <p className="text-sm text-amber-900 mt-4 text-left max-w-md mx-auto">
                <strong>Local dev:</strong> add{" "}
                <code className="bg-amber-100 px-1 rounded">VITE_MOCK_PUZZLE=1</code> to{" "}
                <code className="bg-amber-100 px-1 rounded">.env.local</code> (or{" "}
                <code className="bg-amber-100 px-1 rounded">.env</code>) and restart{" "}
                <code className="bg-amber-100 px-1 rounded">npm run dev</code> for a mock grid without AppSync. For real
                data, run <code className="bg-amber-100 px-1 rounded">npx ampx sandbox</code> and keep{" "}
                <code className="bg-amber-100 px-1 rounded">amplify_outputs.json</code> in sync, or create a{" "}
                <code className="bg-amber-100 px-1 rounded">DailyTrendPuzzle</code> row for today in the backend.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => setPuzzleRetryTick((n) => n + 1)}
              className="mt-4 px-4 py-2 rounded-md bg-red-700 text-white text-sm font-medium hover:bg-red-800"
            >
              Retry
            </button>
          </div>
        )}

        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold text-black tracking-tight">On Trends</h1>
          <p className="text-gray-600 mt-2">Drag each incoming trend into the correct global ranking position.</p>
          {devPuzzleNote ? (
            <p className="text-sm text-amber-800 mt-3 inline-block max-w-lg px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
              {devPuzzleNote}
            </p>
          ) : null}
          {topicSeed ? <p className="text-sm text-gray-500 mt-1">Seed: {topicSeed}</p> : null}
          <p className="text-xs text-gray-400 mt-1">Window: {timeframe}</p>
          {puzzleId ? <p className="text-xs text-gray-400 mt-1">Puzzle {puzzleId}</p> : null}
        </header>

        {showGame && (
          <section className="bg-gray-50 border border-gray-200 rounded-xl p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-semibold text-gray-700">
                Progress {progress}/{TOTAL_ITEMS}
              </div>
              <div className="text-sm font-semibold text-gray-700">
                Score {correctCount}/{TOTAL_ITEMS}
                {!isComplete ? (
                  <span className="text-gray-500 font-normal ml-2">({mistakesSoFar} mistake{mistakesSoFar === 1 ? "" : "s"} so far)</span>
                ) : null}
              </div>
            </div>

            {!isComplete && pendingTerm && (
              <div className="mb-6 text-center">
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Drag or tap a row below</div>
                <div
                  draggable
                  onDragStart={onDragStartPending}
                  onDragEnd={onDragEndPending}
                  className={`inline-block px-4 py-2 rounded-lg border-2 border-black bg-white text-lg font-bold cursor-grab active:cursor-grabbing ${
                    draggingPending ? "opacity-60" : "opacity-100"
                  }`}
                >
                  {pendingTerm}
                </div>
              </div>
            )}

            <div
              ref={listContainerRef}
              onDragOver={onListDragOver}
              onDrop={onListDrop}
              onDragLeave={() => setDragOverIndex(null)}
              className="space-y-2"
            >
              {revealedItems.map((term, index) => (
                <div key={`${term}-${index}`} className="relative">
                  {draggingPending && dragOverIndex === index && (
                    <div className="absolute -top-2 left-2 right-2 h-1 rounded bg-black/70" />
                  )}
                  <button
                    type="button"
                    disabled={!pendingTerm || isComplete}
                    onClick={() => placePendingAtIndex(index)}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    className="w-full text-left px-4 py-3 bg-white border border-gray-300 rounded-lg font-semibold text-gray-900 transition-transform duration-150 hover:border-gray-500 disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                      transform:
                        draggingPending && dragOverIndex !== null && index >= dragOverIndex
                          ? "translateY(10px)"
                          : "translateY(0)",
                    }}
                  >
                    {term}
                  </button>
                </div>
              ))}
              {draggingPending && dragOverIndex === revealedItems.length && (
                <div className="h-1 rounded bg-black/70 mx-2" />
              )}
            </div>

            {lastResult && (
              <div
                className={`mt-4 px-4 py-3 rounded-md text-sm font-medium ${
                  lastResult.wasCorrect
                    ? "bg-green-50 border border-green-200 text-green-700"
                    : "bg-red-50 border border-red-200 text-red-700"
                }`}
              >
                {lastResult.wasCorrect
                  ? `${lastResult.term} placed correctly.`
                  : `${lastResult.term} was incorrect. Snapped to position ${lastResult.correctIndex + 1}.`}
              </div>
            )}
          </section>
        )}

        {isComplete && showGame && (
          <section className="bg-green-50 border border-green-200 rounded-xl p-6 mb-8 text-center">
            <h2 className="text-2xl font-bold text-green-800">Round Complete</h2>
            <p className="text-green-700 mt-2">
              Final score: {correctCount}/{TOTAL_ITEMS} ({TOTAL_ITEMS - correctCount} mistake{TOTAL_ITEMS - correctCount === 1 ? "" : "s"})
            </p>
            {!isAuthed && (
              <button
                type="button"
                onClick={() => setAuthOpen(true)}
                className="mt-4 px-5 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700"
              >
                Sign in to save score
              </button>
            )}
            {saveError ? <div className="text-red-600 text-sm mt-2">{saveError}</div> : null}
          </section>
        )}

        {showGame && (
          <section className="border border-gray-200 rounded-xl p-6">
            <h3 className="text-xl font-bold mb-4">Leaderboard</h3>
            {leaderboardLoading ? (
              <div className="animate-pulse space-y-2">
                <div className="h-10 bg-gray-100 rounded-lg" />
                <div className="h-10 bg-gray-100 rounded-lg" />
                <div className="h-10 bg-gray-100 rounded-lg" />
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {leaderboardError ? (
                  <p className="text-sm text-amber-700">{leaderboardError}</p>
                ) : null}
                {leaderboard.map((entry, index) => (
                  <div
                    key={`${entry.userId || entry.name}-${index}`}
                    className={`flex justify-between items-center p-3 rounded-lg border ${
                      entry.userId && myUserId && entry.userId === myUserId
                        ? "bg-yellow-50 border-yellow-300"
                        : "bg-gray-50 border-gray-200"
                    }`}
                  >
                    <div className="font-semibold text-gray-800">
                      {index + 1}. {entry.name}
                    </div>
                    <div className="text-sm text-gray-600">
                      {entry.correctCount}/{TOTAL_ITEMS} | {entry.mistakes} mistakes
                    </div>
                  </div>
                ))}
                {!leaderboardLoading && leaderboard.length === 0 && !leaderboardError ? (
                  <div className="text-gray-500 text-sm">No scores yet.</div>
                ) : null}
              </div>
            )}
          </section>
        )}

        {showGame && (
          <section className="mt-8 bg-gray-50 rounded-lg p-5 text-sm text-gray-600">
            <strong>How to play:</strong> Drag the highlighted trend into the list, or tap the row where it belongs. The
            list shifts while dragging.             Wrong placements snap to the correct slot; play continues until all five are
            placed. Keyboard: press 1–5 to choose the row where the incoming trend belongs (1 is top).
          </section>
        )}

        {authOpen && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-auto">
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <div className="text-lg font-semibold">Sign in to Save</div>
                <button type="button" onClick={() => setAuthOpen(false)} className="text-gray-500 text-2xl leading-none">
                  ×
                </button>
              </div>
              <div className="p-6">
                <Suspense fallback={<div className="text-sm text-gray-500">Loading sign-in…</div>}>
                  <LazyAuthenticator
                    loginMechanisms={["email"]}
                    socialProviders={[]}
                    formFields={{
                      signIn: {
                        username: { label: "Email", placeholder: "your@email.com" },
                      },
                      signUp: {
                        email: { label: "Email", placeholder: "your@email.com" },
                        preferred_username: { label: "Username", placeholder: "Your username" },
                        password: { label: "Password" },
                        confirm_password: { label: "Confirm Password" },
                      },
                    }}
                  />
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
