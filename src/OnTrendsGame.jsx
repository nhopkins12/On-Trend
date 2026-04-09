import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";
import PillHighlight from "./PillHighlight";

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

function stripXssi(text) {
  return text.replace(/^\)\]\}',?\n/, "");
}

function sanitizeTrendTerm(input) {
  const cleaned = String(input || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  if (/^[^A-Za-z0-9]+$/.test(cleaned)) return null;
  if (/[^\w\s'&+\-/.#]/.test(cleaned)) return null;
  return cleaned;
}

const LOW_SIGNAL_TERMS = new Set([
  "becoming",
  "mannequin challenge",
  "today",
  "tomorrow",
  "yesterday",
  "thing",
  "things",
  "story",
  "stories",
  "update",
]);

function isLikelyLowSignal(term, score) {
  const normalized = String(term || "").toLowerCase();
  if (LOW_SIGNAL_TERMS.has(normalized) && score < 90) return true;

  const words = normalized.split(/\s+/).filter(Boolean);
  const hasDigit = /\d/.test(term);
  const isAcronym = /^[A-Z]{2,6}$/.test(term);

  if (hasDigit || isAcronym) return score < 30;
  if (words.length === 1 && /^[a-z]+$/.test(normalized) && score < 55) return true;
  if (normalized.length <= 4 && score < 50) return true;

  return false;
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

function todayIdToronto() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
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
const LOCAL_USER_ID = "local-user";
const DEFAULT_TIMEFRAME = "now 1-d";


async function fetchTrendsProxyText(path) {
  const response = await fetch(`/trends-proxy${path}`, {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`Proxy request failed (${response.status})`);
  }
  return response.text();
}

async function fetchLocalDailyCandidates() {
  const txt = await fetchTrendsProxyText("/trends/api/dailytrends?hl=en-US&tz=0&geo=&ns=15");
  const payload = JSON.parse(stripXssi(txt));
  const latestDay = payload?.default?.trendingSearchesDays?.[0];
  const list = Array.isArray(latestDay?.trendingSearches) ? latestDay.trendingSearches : [];

  const out = [];
  for (const entry of list) {
    const clean = sanitizeTrendTerm(entry?.title?.query);
    if (clean) out.push(clean);
  }
  return Array.from(new Set(out));
}

async function fetchLocalExploreWidgets(keyword) {
  const req = {
    comparisonItem: [{ keyword, geo: "", time: DEFAULT_TIMEFRAME }],
    category: 0,
    property: "",
  };
  const txt = await fetchTrendsProxyText(`/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`);
  const payload = JSON.parse(stripXssi(txt));
  return Array.isArray(payload?.widgets) ? payload.widgets : [];
}

async function fetchLocalRelatedTerms(seed) {
  const widgets = await fetchLocalExploreWidgets(seed);
  const relatedWidget = widgets.find((w) => w?.id === "RELATED_QUERIES") || widgets.find((w) => w?.title === "Related queries");
  if (!relatedWidget?.token || !relatedWidget?.request) return [];

  const txt = await fetchTrendsProxyText(
    `/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(relatedWidget.request))}&token=${encodeURIComponent(String(relatedWidget.token))}`
  );
  const payload = JSON.parse(stripXssi(txt));

  const ranked = [];
  const rankedLists = payload?.default?.rankedList;
  if (!Array.isArray(rankedLists)) return ranked;

  for (const group of rankedLists) {
    const items = Array.isArray(group?.rankedKeyword) ? group.rankedKeyword : [];
    for (const item of items) {
      const clean = sanitizeTrendTerm(item?.query);
      if (!clean) continue;

      let score = 0;
      if (Array.isArray(item?.value) && typeof item.value[0] === "number") {
        score = Number(item.value[0]);
      }
      if (!Number.isFinite(score) || score < 0) score = 0;
      if (String(item?.value?.[0] || "").toLowerCase() === "breakout") score = 100;

      if (isLikelyLowSignal(clean, score)) continue;
      ranked.push({ term: clean, score });
    }
  }

  return ranked;
}

function mergeRankedTerms(items) {
  const best = new Map();
  for (const item of items) {
    const key = item.term.toLowerCase();
    const prev = best.get(key);
    if (!prev || item.score > prev.score) best.set(key, item);
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
}

async function buildLocalPuzzleFromAlgorithm(puzzleId) {
  const candidates = await fetchLocalDailyCandidates();
  if (candidates.length < TOTAL_ITEMS) {
    throw new Error("Not enough daily candidates in local generator");
  }

  const seedCandidates = deterministicShuffle(candidates.slice(0, 32), `${puzzleId}:local-seed`);
  let selectedSeed = seedCandidates[0];
  let related = [];

  for (const seed of seedCandidates) {
    const rel = await fetchLocalRelatedTerms(seed);
    if (rel.filter((x) => x.score >= 45).length >= 8) {
      selectedSeed = seed;
      related = rel;
      break;
    }
  }

  const clusterPool = mergeRankedTerms(related);
  if (!clusterPool.find((x) => x.term.toLowerCase() === selectedSeed.toLowerCase())) {
    const top = clusterPool[0]?.score ?? 100;
    clusterPool.unshift({ term: selectedSeed, score: top + 1 });
  }

  const fallbackPool = mergeRankedTerms(
    candidates.map((term, index) => ({ term, score: Math.max(1, 100 - index) })).filter((x) => !isLikelyLowSignal(x.term, x.score))
  );

  const selected = [];
  const seen = new Set();

  for (const item of clusterPool) {
    const key = item.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length === TOTAL_ITEMS) break;
  }

  if (selected.length < TOTAL_ITEMS) {
    for (const item of fallbackPool) {
      const key = item.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(item);
      if (selected.length === TOTAL_ITEMS) break;
    }
  }

  if (selected.length < TOTAL_ITEMS) {
    throw new Error("Unable to build local puzzle from trends algorithm");
  }

  const ranked = selected
    .slice(0, TOTAL_ITEMS)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .map((item, i) => ({ term: item.term, rank: i + 1, score: item.score }));

  return {
    id: puzzleId,
    topicSeed: `${selectedSeed} (Local Algorithm)`,
    timeframe: DEFAULT_TIMEFRAME,
    items: ranked,
  };
}

function localLeaderboardKey(puzzleId) {
  return `ontrends:local:leaderboard:${puzzleId}`;
}

function readLocalLeaderboard(puzzleId) {
  try {
    const raw = localStorage.getItem(localLeaderboardKey(puzzleId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalLeaderboard(puzzleId, rows) {
  try {
    localStorage.setItem(localLeaderboardKey(puzzleId), JSON.stringify(rows));
  } catch {
    // no-op
  }
}

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
  const forceLocal = String(import.meta.env.VITE_LOCAL_ONLY || "") === "1";

  const [puzzleLoading, setPuzzleLoading] = useState(true);
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
  const [isAuthed, setIsAuthed] = useState(false);
  const [myUserId, setMyUserId] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [hasSavedScore, setHasSavedScore] = useState(false);
  const [isSavingScore, setIsSavingScore] = useState(false);
  const [useLocalMode, setUseLocalMode] = useState(forceLocal);

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

  const loadLocalPuzzle = useCallback(async () => {
    const pid = todayIdToronto();
    setUseLocalMode(true);
    setIsAuthed(true);
    setMyUserId(LOCAL_USER_ID);
    const localPuzzle = await buildLocalPuzzleFromAlgorithm(pid);

    setPuzzleId(localPuzzle.id);
    setTopicSeed(localPuzzle.topicSeed);
    setTimeframe(localPuzzle.timeframe);
    setOrderedItems(localPuzzle.items);
    initializeGame(localPuzzle.items, localPuzzle.id);
  }, [initializeGame]);

  const fetchLeaderboard = useCallback(
    async (pid) => {
      if (!pid) return;

      if (useLocalMode) {
        const sorted = sortEntries(readLocalLeaderboard(pid));
        setLeaderboard(
          sorted.map((x) => ({
            name: x?.name || "Local Player",
            userId: x?.userId || LOCAL_USER_ID,
            correctCount: x?.correctCount ?? 0,
            mistakes: x?.mistakes ?? TOTAL_ITEMS,
          }))
        );
        return;
      }

      try {
        const client = generateClient();
        const { data, errors } = await client.models.TrendScore.list();
        if (errors?.length) console.warn("TrendScore list errors", errors);

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
          }))
        );
      } catch (err) {
        console.warn("Failed leaderboard fetch. Switching to local mode.", err);
        await loadLocalPuzzle();
      }
    },
    [loadLocalPuzzle, useLocalMode]
  );

  useEffect(() => {
    const loadPuzzle = async () => {
      if (forceLocal) {
        await loadLocalPuzzle();
        setPuzzleLoading(false);
        return;
      }

      try {
        const client = generateClient();
        const { data } = await client.models.DailyTrendPuzzle.list();
        const items = Array.isArray(data) ? data : [];
        const ready = items.filter((x) => x?.computeState === "ready");
        const todayId = todayIdToronto();

        const activeToday = ready.find((x) => x?.id === todayId && x?.status === "active");
        const activeLatest = ready
          .filter((x) => x?.status === "active")
          .sort((a, b) => String(b.id || "").localeCompare(String(a.id || "")))[0];
        const fallback = ready.sort((a, b) => String(b.id || "").localeCompare(String(a.id || "")))[0];

        const chosen = activeToday || activeLatest || fallback;

        if (!chosen?.id) {
          await loadLocalPuzzle();
          return;
        }

        const parsedItems = parseItems(chosen.items);
        if (parsedItems.length !== TOTAL_ITEMS) {
          await loadLocalPuzzle();
          return;
        }

        setPuzzleId(chosen.id);
        setTopicSeed(String(chosen.topicSeed || ""));
        setTimeframe(String(chosen.timeframe || DEFAULT_TIMEFRAME));
        setOrderedItems(parsedItems);
        initializeGame(parsedItems, chosen.id);
      } catch (err) {
        console.warn("Failed to load trend puzzle. Switching to local mode.", err);
        await loadLocalPuzzle();
      } finally {
        setPuzzleLoading(false);
      }
    };

    loadPuzzle();
  }, [forceLocal, initializeGame, loadLocalPuzzle]);

  useEffect(() => {
    fetchLeaderboard(puzzleId);
  }, [puzzleId, fetchLeaderboard]);

  useEffect(() => {
    if (useLocalMode) {
      setIsAuthed(true);
      setMyUserId(LOCAL_USER_ID);
      return;
    }

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
  }, [useLocalMode]);

  const pendingTerm = pendingQueue[0] || "";
  const progress = Math.min(TOTAL_ITEMS, revealedItems.length);

  const placePendingAtIndex = useCallback((chosenIndex) => {
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
  }, [correctCount, isComplete, pendingQueue, pendingTerm, rankByTerm, revealedItems]);

  const getInsertionIndexFromY = useCallback((clientY) => {
    for (let i = 0; i < revealedItems.length; i++) {
      const node = itemRefs.current[i];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) return i;
    }
    return revealedItems.length;
  }, [revealedItems.length]);

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
    if (useLocalMode) return "Local Player";
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
  }, [useLocalMode]);

  const saveScore = useCallback(async () => {
    setSaveError("");
    if (!isComplete || !puzzleId) return;
    if (saveTriggeredRef.current) return;

    saveTriggeredRef.current = true;
    setIsSavingScore(true);

    try {
      const mistakes = TOTAL_ITEMS - correctCount;

      if (useLocalMode) {
        const name = "Local Player";
        const rows = readLocalLeaderboard(puzzleId);
        const existingIdx = rows.findIndex((x) => x?.userId === LOCAL_USER_ID);
        const entry = {
          userId: LOCAL_USER_ID,
          puzzleId,
          name,
          correctCount,
          mistakes,
          placementLog,
          createdAt: new Date().toISOString(),
        };

        if (existingIdx >= 0) {
          const old = rows[existingIdx];
          if ((entry.mistakes ?? 99) <= (old?.mistakes ?? 99)) {
            rows[existingIdx] = entry;
          }
        } else {
          rows.push(entry);
        }

        writeLocalLeaderboard(puzzleId, rows);
        setHasSavedScore(true);
        await fetchLeaderboard(puzzleId);
        return;
      }

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
            { authMode: "userPool" }
          );
        } else if (existing.name !== name) {
          await client.models.TrendScore.update(
            {
              id,
              name,
            },
            { authMode: "userPool" }
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
          { authMode: "userPool" }
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
  }, [correctCount, fetchLeaderboard, isComplete, placementLog, puzzleId, resolveDisplayName, useLocalMode]);

  useEffect(() => {
    if (!isComplete || hasSavedScore || isSavingScore) return;
    if (!useLocalMode && !isAuthed) return;
    saveScore();
  }, [hasSavedScore, isAuthed, isComplete, isSavingScore, saveScore, useLocalMode]);

  return (
    <div className="min-h-screen bg-white font-['Helvetica_Neue',_sans-serif]">
      <div className="max-w-4xl mx-auto px-6 py-12">
        {puzzleLoading && (
          <div className="fixed inset-0 z-40 bg-white flex items-center justify-center">
            <PillHighlight text="LOADING" />
          </div>
        )}

        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold text-black tracking-tight">On Trends</h1>
          <p className="text-gray-600 mt-2">Drag each incoming trend into the correct global ranking position.</p>
          {topicSeed && <p className="text-sm text-gray-500 mt-1">Seed: {topicSeed}</p>}
          <p className="text-xs text-gray-400 mt-1">Window: {timeframe}</p>
          {puzzleId && <p className="text-xs text-gray-400 mt-1">Puzzle {puzzleId}</p>}
          {useLocalMode && (
            <p className="text-xs mt-2 inline-block px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700">
              Local Mode: using trends algorithm via Vite proxy
            </p>
          )}
        </header>

        <section className="bg-gray-50 border border-gray-200 rounded-xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold text-gray-700">Progress {progress}/{TOTAL_ITEMS}</div>
            <div className="text-sm font-semibold text-gray-700">Score {correctCount}/{TOTAL_ITEMS}</div>
          </div>

          {!isComplete && pendingTerm && (
            <div className="mb-6 text-center">
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Drag this trend</div>
              <div
                draggable
                onDragStart={onDragStartPending}
                onDragEnd={onDragEndPending}
                className={`inline-block px-4 py-2 rounded-lg border-2 border-black bg-white text-lg font-bold cursor-grab active:cursor-grabbing ${draggingPending ? "opacity-60" : "opacity-100"}`}
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
                <div
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg font-semibold text-gray-900 transition-transform duration-150"
                  style={{
                    transform: draggingPending && dragOverIndex !== null && index >= dragOverIndex ? "translateY(10px)" : "translateY(0)",
                  }}
                >
                  {term}
                </div>
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

        {isComplete && (
          <section className="bg-green-50 border border-green-200 rounded-xl p-6 mb-8 text-center">
            <h2 className="text-2xl font-bold text-green-800">Round Complete</h2>
            <p className="text-green-700 mt-2">
              Final score: {correctCount}/{TOTAL_ITEMS} ({TOTAL_ITEMS - correctCount} mistake{TOTAL_ITEMS - correctCount === 1 ? "" : "s"})
            </p>
            {!isAuthed && !useLocalMode && (
              <button
                onClick={() => setAuthOpen(true)}
                className="mt-4 px-5 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700"
              >
                Sign in to save score
              </button>
            )}
            {saveError && <div className="text-red-600 text-sm mt-2">{saveError}</div>}
          </section>
        )}

        <section className="border border-gray-200 rounded-xl p-6">
          <h3 className="text-xl font-bold mb-4">Leaderboard</h3>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {leaderboard.map((entry, index) => (
              <div
                key={`${entry.userId || entry.name}-${index}`}
                className={`flex justify-between items-center p-3 rounded-lg border ${
                  entry.userId && myUserId && entry.userId === myUserId
                    ? "bg-yellow-50 border-yellow-300"
                    : "bg-gray-50 border-gray-200"
                }`}
              >
                <div className="font-semibold text-gray-800">{index + 1}. {entry.name}</div>
                <div className="text-sm text-gray-600">
                  {entry.correctCount}/{TOTAL_ITEMS} | {entry.mistakes} mistakes
                </div>
              </div>
            ))}
            {leaderboard.length === 0 && <div className="text-gray-500 text-sm">No scores yet.</div>}
          </div>
        </section>

        <section className="mt-8 bg-gray-50 rounded-lg p-5 text-sm text-gray-600">
          <strong>How to play:</strong> Drag one incoming trend into the list.
          The list shifts while dragging. If you are wrong, the term snaps to the correct position and play continues.
        </section>

        {!useLocalMode && authOpen && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-auto">
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <div className="text-lg font-semibold">Sign in to Save</div>
                <button onClick={() => setAuthOpen(false)} className="text-gray-500 text-2xl leading-none">x</button>
              </div>
              <div className="p-6">
                <Authenticator
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
                >
                  {({ user, signOut }) => {
                    if (user && !isAuthed) {
                      setTimeout(() => setIsAuthed(true), 0);
                      setTimeout(() => setAuthOpen(false), 0);
                    }

                    if (user) {
                      return (
                        <div className="flex flex-col items-center gap-3">
                          <div className="text-sm text-gray-700">Signed in</div>
                          <button
                            onClick={signOut}
                            className="px-3 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                          >
                            Sign out
                          </button>
                        </div>
                      );
                    }

                    return null;
                  }}
                </Authenticator>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
