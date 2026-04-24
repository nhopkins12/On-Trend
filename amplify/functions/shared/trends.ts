export type TrendItem = {
  term: string;
  rank: number;
  score: number | null;
};

type RankedTerm = {
  term: string;
  score: number;
  isTopSignal?: boolean;
};

const TZ = "America/Toronto";
const TREND_ITEMS_PER_PUZZLE = 5;
export const FIXED_TIMEFRAME = "now 7-d";
const DAILY_RSS_GEOS = ["US"];
const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const SERPAPI_ENGINE = "google_trends";
const SERPAPI_REGION = "US";

const GENERIC_LOW_SIGNAL = new Set([
  "becoming",
  "today",
  "tomorrow",
  "yesterday",
  "thing",
  "things",
  "story",
  "stories",
  "update",
  "news",
  "photo",
  "video",
  "challenge",
  "mannequin challenge",
]);
const PUZZLE_NOISE_PATTERNS = [
  /\bupdate\b/i,
  /\blive\b/i,
  /\bradar\b/i,
  /\bvideo\b/i,
  /\bstream\b/i,
  /\bbreaking\b/i,
];
const NON_NOUN_TOKENS = new Set([
  "is",
  "are",
  "was",
  "were",
  "be",
  "being",
  "been",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "must",
  "will",
  "shall",
  "go",
  "goes",
  "went",
  "going",
  "get",
  "gets",
  "got",
  "make",
  "makes",
  "made",
  "say",
  "says",
  "said",
  "watch",
  "stream",
  "live",
  "see",
  "know",
  "find",
  "buy",
  "sell",
  "trade",
  "play",
  "playing",
  "played",
  "win",
  "won",
  "lose",
  "lost",
]);

function stripXssi(text: string): string {
  return text.replace(/^\)\]\}',?\n/, "");
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toDateIdInTZ(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

export function dateIdInToronto(offsetDays = 0): string {
  const logical = new Date();
  logical.setUTCDate(logical.getUTCDate() + offsetDays);
  return toDateIdInTZ(logical, TZ);
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicShuffle<T>(items: T[], seedKey: string): T[] {
  const rng = mulberry32(hashString(seedKey));
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function deterministicWeightedSampleTop<T>(
  items: T[],
  sampleSize: number,
  seedKey: string
): T[] {
  const rng = mulberry32(hashString(seedKey));
  const pool = [...items];
  const out: T[] = [];

  while (pool.length > 0 && out.length < sampleSize) {
    // Higher-ranked items (earlier in array) get higher probability.
    let totalWeight = 0;
    for (let i = 0; i < pool.length; i++) {
      totalWeight += pool.length - i;
    }

    let pick = rng() * totalWeight;
    let chosenIndex = 0;
    for (let i = 0; i < pool.length; i++) {
      pick -= pool.length - i;
      if (pick <= 0) {
        chosenIndex = i;
        break;
      }
    }

    out.push(pool[chosenIndex]);
    pool.splice(chosenIndex, 1);
  }

  return out;
}

function sanitizeTerm(input: string): string | null {
  const cleaned = String(input || "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 2 || cleaned.length > 80) return null;
  if (/^[^A-Za-z0-9]+$/.test(cleaned)) return null;
  if (/[^\w\s'&+\-/.#]/.test(cleaned)) return null;

  return cleaned;
}

function isLikelyLowSignal(term: string, score: number): boolean {
  const normalized = term.toLowerCase();
  if (GENERIC_LOW_SIGNAL.has(normalized) && score < 90) return true;

  const words = normalized.split(/\s+/).filter(Boolean);
  const isSingleWord = words.length === 1;
  const hasDigit = /\d/.test(term);
  const isAcronym = /^[A-Z]{2,6}$/.test(term);

  // Keep numeric and acronym terms if they have reasonable signal.
  if (hasDigit || isAcronym) return score < 30;

  // Low-signal generic single words are filtered more aggressively.
  if (isSingleWord && /^[a-z]+$/.test(normalized) && score < 55) return true;

  // Short and vague terms need stronger evidence.
  if (normalized.length <= 4 && score < 50) return true;

  return false;
}

function isPuzzleFriendlyTerm(term: string): boolean {
  const normalized = String(term || "").trim();
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  if (normalized.length > 48) return false;
  if (PUZZLE_NOISE_PATTERNS.some((p) => p.test(normalized))) return false;
  const tokens = normalized
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  if (!tokens.length) return false;
  const nonNounCount = tokens.filter((t) => NON_NOUN_TOKENS.has(t)).length;
  if (nonNounCount > 0) return false;
  return true;
}

async function fetchText(url: string): Promise<string> {
  const maxAttempts = 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (response.ok) {
        return response.text();
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }

      throw new Error(`Request failed (${response.status}) for ${url}`);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}

async function fetchJson(url: string): Promise<any> {
  const txt = await fetchText(url);
  return JSON.parse(txt);
}

function parseDailyRssTitles(xmlText: string): string[] {
  const out: string[] = [];
  const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];

  for (const block of itemMatches) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch?.[1]) continue;
    const clean = sanitizeTerm(decodeXmlEntities(titleMatch[1]));
    if (clean) out.push(clean);
  }

  return Array.from(new Set(out));
}

async function fetchRssDailyCandidates(): Promise<string[]> {
  const merged: string[] = [];
  for (const geo of DAILY_RSS_GEOS) {
    try {
      const txt = await fetchText(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`);
      merged.push(...parseDailyRssTitles(txt));
    } catch {
      // no-op
    }
  }
  return Array.from(new Set(merged));
}

async function fetchLegacyDailyCandidates(): Promise<string[]> {
  const urls = [
    "https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15",
    "https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=0&geo=&ns=15",
  ];

  for (const url of urls) {
    try {
      const txt = await fetchText(url);
      const payload = JSON.parse(stripXssi(txt));
      const latestDay = payload?.default?.trendingSearchesDays?.[0];
      const list = Array.isArray(latestDay?.trendingSearches) ? latestDay.trendingSearches : [];
      const out: string[] = [];
      for (const entry of list) {
        const clean = sanitizeTerm(entry?.title?.query);
        if (clean) out.push(clean);
      }
      const unique = Array.from(new Set(out));
      if (unique.length) return unique;
    } catch {
      // try next variant
    }
  }

  return [];
}

async function fetchDailyCandidates(): Promise<string[]> {
  const legacy = await fetchLegacyDailyCandidates();
  if (legacy.length) return legacy;

  const rss = await fetchRssDailyCandidates();
  if (rss.length) {
    return rss;
  }

  throw new Error("No candidates available from Google Trends sources.");
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

async function fetchExploreWidgetsForComparison(keywords: string[]): Promise<any[]> {
  const req = {
    comparisonItem: keywords.map((keyword) => ({ keyword, geo: "US", time: FIXED_TIMEFRAME })),
    category: 0,
    property: "",
  };

  const url = `https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`;
  const txt = await fetchText(url);
  const payload = JSON.parse(stripXssi(txt));
  return Array.isArray(payload?.widgets) ? payload.widgets : [];
}

async function fetchExploreWidgets(keyword: string): Promise<any[]> {
  return fetchExploreWidgetsForComparison([keyword]);
}

async function fetchInterestAveragesForKeywords(keywords: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!Array.isArray(keywords) || keywords.length === 0) return out;

  let widgets: any[] = [];
  try {
    widgets = await fetchExploreWidgetsForComparison(keywords);
  } catch {
    return out;
  }

  const timeWidget =
    widgets.find((w) => w?.id === "TIMESERIES") ||
    widgets.find((w) => String(w?.title || "").toLowerCase().includes("interest over time"));
  if (!timeWidget?.token || !timeWidget?.request) return out;

  const url = `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(timeWidget.request))}&token=${encodeURIComponent(String(timeWidget.token))}`;
  let txt = "";
  try {
    txt = await fetchText(url);
  } catch {
    return out;
  }

  const payload = JSON.parse(stripXssi(txt));
  const timeline = Array.isArray(payload?.default?.timelineData) ? payload.default.timelineData : [];
  if (!timeline.length) return out;

  const sums = new Array<number>(keywords.length).fill(0);
  const counts = new Array<number>(keywords.length).fill(0);

  for (const point of timeline) {
    const values = Array.isArray(point?.value) ? point.value : [];
    for (let i = 0; i < keywords.length; i++) {
      const raw = values[i];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        sums[i] += raw;
        counts[i] += 1;
      }
    }
  }

  for (let i = 0; i < keywords.length; i++) {
    if (counts[i] > 0) {
      out.set(keywords[i], sums[i] / counts[i]);
    }
  }

  return out;
}

async function rankTermsByGoogleInterest(terms: string[], seedKey: string): Promise<Map<string, number>> {
  const ranked = new Map<string, number>();
  const unique = Array.from(
    new Set(
      terms
        .map((term) => sanitizeTerm(term))
        .filter((x): x is string => Boolean(x))
        .map((x) => x.toLowerCase())
    )
  );

  const canonical = new Map<string, string>();
  for (const term of terms) {
    const clean = sanitizeTerm(term);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, clean);
  }

  const ordered = unique.map((key) => canonical.get(key)!).filter(Boolean);
  if (ordered.length === 0) return ranked;
  if (ordered.length === 1) {
    ranked.set(ordered[0], 100);
    return ranked;
  }

  if (ordered.length <= 5) {
    const averages = await fetchInterestAveragesForKeywords(ordered);
    if (averages.size > 0) {
      const maxAvg = Math.max(...Array.from(averages.values()), 1);
      for (const term of ordered) {
        const avg = averages.get(term);
        if (typeof avg === "number" && Number.isFinite(avg)) {
          ranked.set(term, (avg / maxAvg) * 100);
        }
      }
    }
    return ranked;
  }

  const shuffled = deterministicShuffle(ordered, `${seedKey}:google-rank`);
  const anchor = shuffled[0];
  ranked.set(anchor, 100);

  const batches = chunkArray(shuffled.slice(1), 4);
  for (const group of batches) {
    const batch = [anchor, ...group];
    const averages = await fetchInterestAveragesForKeywords(batch);
    const anchorAvg = averages.get(anchor);
    for (const term of group) {
      const termAvg = averages.get(term);
      if (typeof termAvg !== "number" || !Number.isFinite(termAvg)) continue;
      let normalized: number;
      if (typeof anchorAvg === "number" && Number.isFinite(anchorAvg) && anchorAvg > 0) {
        normalized = (termAvg / anchorAvg) * 100;
      } else {
        normalized = termAvg;
      }
      const prev = ranked.get(term);
      if (typeof prev !== "number" || !Number.isFinite(prev) || normalized > prev) {
        ranked.set(term, Number.isFinite(normalized) ? normalized : 0);
      }
    }
  }

  return ranked;
}

async function rankTermsBySerpApiInterest(
  terms: string[],
  apiKey: string,
): Promise<Map<string, number>> {
  const ranked = new Map<string, number>();
  const normalizedTerms = Array.from(
    new Set(
      terms
        .map((x) => sanitizeTerm(x))
        .filter((x): x is string => Boolean(x))
    )
  );

  if (normalizedTerms.length === 0) return ranked;

  const url = `${SERPAPI_ENDPOINT}?engine=${encodeURIComponent(SERPAPI_ENGINE)}&data_type=TIMESERIES&q=${encodeURIComponent(
    normalizedTerms.join(",")
  )}&date=${encodeURIComponent(FIXED_TIMEFRAME)}&geo=${encodeURIComponent(SERPAPI_REGION)}&api_key=${encodeURIComponent(apiKey)}`;

  let payload: any;
  try {
    payload = await fetchJson(url);
  } catch {
    return ranked;
  }

  const apiError = payload?.error;
  if (typeof apiError === "string" && apiError.trim()) return ranked;

  const timeline = Array.isArray(payload?.interest_over_time?.timeline_data)
    ? payload.interest_over_time.timeline_data
    : [];

  const sums = new Array<number>(normalizedTerms.length).fill(0);
  const counts = new Array<number>(normalizedTerms.length).fill(0);

  for (const point of timeline) {
    const values = Array.isArray(point?.values) ? point.values : [];

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const extracted = row?.extracted_value;
      const query = sanitizeTerm(String(row?.query || "")) || normalizedTerms[i];
      const idx = normalizedTerms.findIndex((term) => term.toLowerCase() === query.toLowerCase());
      if (idx < 0) continue;

      if (typeof extracted === "number" && Number.isFinite(extracted)) {
        sums[idx] += extracted;
        counts[idx] += 1;
      }
    }
  }

  const averages = sums.map((sum, idx) => (counts[idx] > 0 ? sum / counts[idx] : 0));
  const maxAvg = Math.max(...averages, 0);
  if (maxAvg <= 0) return ranked;

  for (let i = 0; i < normalizedTerms.length; i++) {
    const avg = averages[i];
    if (Number.isFinite(avg) && avg > 0) {
      ranked.set(normalizedTerms[i], (avg / maxAvg) * 100);
    }
  }

  return ranked;
}

async function rankTermsByConfiguredProvider(terms: string[], seedKey: string): Promise<Map<string, number>> {
  const provider = String(process.env.TREND_RANK_PROVIDER || "google").trim().toLowerCase();
  const serpApiKey = String(process.env.SERPAPI_KEY || "").trim();

  if (provider === "serpapi" && serpApiKey) {
    const serpScores = await rankTermsBySerpApiInterest(terms, serpApiKey);
    if (serpScores.size > 0) return serpScores;
    return rankTermsByGoogleInterest(terms, seedKey);
  }

  if (provider === "hybrid" && serpApiKey) {
    const serpScores = await rankTermsBySerpApiInterest(terms, serpApiKey);
    if (serpScores.size > 0) return serpScores;
    return rankTermsByGoogleInterest(terms, seedKey);
  }

  const googleScores = await rankTermsByGoogleInterest(terms, seedKey);
  if (googleScores.size > 0) return googleScores;

  if (serpApiKey) {
    const serpScores = await rankTermsBySerpApiInterest(terms, serpApiKey);
    if (serpScores.size > 0) return serpScores;
  }

  return googleScores;
}

async function fetchRelatedTerms(seed: string): Promise<RankedTerm[]> {
  let widgets: any[] = [];
  try {
    widgets = await fetchExploreWidgets(seed);
  } catch {
    return [];
  }
  const relatedWidget = widgets.find((w) => w?.id === "RELATED_QUERIES") || widgets.find((w) => w?.title === "Related queries");
  if (!relatedWidget?.token || !relatedWidget?.request) return [];

  const url = `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(relatedWidget.request))}&token=${encodeURIComponent(String(relatedWidget.token))}`;
  let txt = "";
  try {
    txt = await fetchText(url);
  } catch {
    return [];
  }
  const payload = JSON.parse(stripXssi(txt));

  const ranked: RankedTerm[] = [];
  const rankedLists = payload?.default?.rankedList;
  if (!Array.isArray(rankedLists)) return ranked;

  for (const group of rankedLists) {
    const isTop = String(group?.rankedKeywordType || "").toLowerCase() === "top";
    const items = group?.rankedKeyword;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const raw = item?.query;
      const clean = sanitizeTerm(raw);
      if (!clean) continue;

      let score = 0;
      if (Array.isArray(item?.value) && typeof item.value[0] === "number") {
        score = Number(item.value[0]);
      }
      if (!Number.isFinite(score) || score < 0) score = 0;

      if (String(item?.value?.[0] || "").toLowerCase() === "breakout") {
        score = 100;
      }

      ranked.push({ term: clean, score, isTopSignal: isTop });
    }
  }

  return ranked;
}

function mergeRankedTerms(items: RankedTerm[]): RankedTerm[] {
  const best = new Map<string, RankedTerm>();
  for (const item of items) {
    const key = item.term.toLowerCase();
    const prev = best.get(key);
    if (!prev || item.score > prev.score) {
      best.set(key, item);
    }
  }

  return Array.from(best.values())
    .filter((x) => !isLikelyLowSignal(x.term, x.score))
    .filter((x) => isPuzzleFriendlyTerm(x.term))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
}

export async function generateTrendPuzzle(options: {
  puzzleId: string;
  sourceDate?: string;
  forcedSeed?: string;
}): Promise<{ topicSeed: string; sourceDate: string; timeframe: string; items: TrendItem[] }> {
  const sourceDate = options.sourceDate || dateIdInToronto(0);
  const candidates = await fetchDailyCandidates();
  const puzzleFriendlyCandidates = candidates.filter((x) => isPuzzleFriendlyTerm(x));
  if (puzzleFriendlyCandidates.length < TREND_ITEMS_PER_PUZZLE) {
    throw new Error("Insufficient daily trend candidates.");
  }

  // Randomness from only the current top trend window:
  // keeps puzzles varied while staying anchored to what's trending now.
  const topWindow = puzzleFriendlyCandidates.slice(0, 16);
  const pickedTerms = deterministicWeightedSampleTop(
    topWindow,
    TREND_ITEMS_PER_PUZZLE,
    `${options.puzzleId}:pick`
  );
  if (pickedTerms.length < TREND_ITEMS_PER_PUZZLE) {
    throw new Error("Unable to build 5 unique trend items.");
  }

  const relevancePool: RankedTerm[] = pickedTerms.map((term, idx) => ({
    term,
    score: Math.max(1, 100 - idx),
    isTopSignal: true,
  }));

  const googleScores = await rankTermsByConfiguredProvider(
    relevancePool.map((x) => x.term),
    options.puzzleId
  );

  const scored = relevancePool.map((entry) => {
    const googleScore = googleScores.get(entry.term);
    return {
      ...entry,
      score: Number.isFinite(googleScore) ? (googleScore as number) : entry.score,
    };
  });

  const sorted = scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

  const items: TrendItem[] = sorted.map((entry, idx) => ({
    term: entry.term,
    rank: idx + 1,
    score: Number.isFinite(entry.score) ? entry.score : null,
  }));

  return {
    topicSeed: "",
    sourceDate,
    timeframe: FIXED_TIMEFRAME,
    items,
  };
}

export function deriveStatusForDate(id: string, todayId: string): "archived" | "active" | "next" {
  if (id < todayId) return "archived";
  if (id === todayId) return "active";
  return "next";
}
