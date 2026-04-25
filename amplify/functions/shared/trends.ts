export type TrendItem = {
  term: string;
  rank: number;
  score: number | null;
};

/** IANA zone for a single app-wide “game day” (US Eastern, DST-aware). */
const PUZZLE_TIME_ZONE = "America/New_York";
export const TREND_ITEMS_PER_PUZZLE = 5;
/** Minimum puzzle-friendly candidates before random draw (product spec). */
export const MIN_PUZZLE_FRIENDLY_POOL = 10;
/** Cap candidate pool size before shuffle (performance). */
export const MAX_CANDIDATES_FOR_SAMPLE = 40;
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

/**
 * YYYY-MM-DD in the app’s fixed puzzle clock (`PUZZLE_TIME_ZONE`).
 * `offsetDays` advances civil calendar days without UTC “midnight drift”.
 */
export function puzzleDateId(offsetDays = 0): string {
  const today = toDateIdInTZ(new Date(), PUZZLE_TIME_ZONE);
  if (offsetDays === 0) return today;
  const [y, m, d] = today.split("-").map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  const shifted = utcNoon + offsetDays * 24 * 60 * 60 * 1000;
  return toDateIdInTZ(new Date(shifted), PUZZLE_TIME_ZONE);
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

/** Google Trends host or your reverse proxy origin (no trailing slash). */
function trendsOrigin(): string {
  return (process.env.TRENDS_ORIGIN || "https://trends.google.com").replace(/\/$/, "");
}

function trendsUrl(pathWithLeadingSlash: string): string {
  const p = pathWithLeadingSlash.startsWith("/") ? pathWithLeadingSlash : `/${pathWithLeadingSlash}`;
  return `${trendsOrigin()}${p}`;
}

export function sanitizeTerm(input: string): string | null {
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

  if (hasDigit || isAcronym) return score < 30;
  if (isSingleWord && /^[a-z]+$/.test(normalized) && score < 55) return true;
  if (normalized.length <= 4 && score < 50) return true;

  return false;
}

export function isPuzzleFriendlyTerm(term: string): boolean {
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
      const txt = await fetchText(
        trendsUrl(`/trending/rss?geo=${encodeURIComponent(geo)}`),
      );
      merged.push(...parseDailyRssTitles(txt));
    } catch {
      // no-op
    }
  }
  return Array.from(new Set(merged));
}

async function fetchLegacyDailyCandidates(): Promise<string[]> {
  const urls = [
    "/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15",
    "/trends/api/dailytrends?hl=en-US&tz=0&geo=&ns=15",
  ];

  for (const path of urls) {
    try {
      const txt = await fetchText(trendsUrl(path));
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

  const url = trendsUrl(
    `/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`,
  );
  const txt = await fetchText(url);
  const payload = JSON.parse(stripXssi(txt));
  return Array.isArray(payload?.widgets) ? payload.widgets : [];
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

  const url = trendsUrl(
    `/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(timeWidget.request))}&token=${encodeURIComponent(String(timeWidget.token))}`,
  );
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
        .map((x) => x.toLowerCase()),
    ),
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

async function rankTermsBySerpApiInterest(terms: string[], apiKey: string): Promise<Map<string, number>> {
  const ranked = new Map<string, number>();
  const normalizedTerms = Array.from(
    new Set(
      terms
        .map((x) => sanitizeTerm(x))
        .filter((x): x is string => Boolean(x)),
    ),
  );

  if (normalizedTerms.length === 0) return ranked;

  const url = `${SERPAPI_ENDPOINT}?engine=${encodeURIComponent(SERPAPI_ENGINE)}&data_type=TIMESERIES&q=${encodeURIComponent(
    normalizedTerms.join(","),
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

function scoreMapGetCaseInsensitive(map: Map<string, number>, term: string): number | undefined {
  const c = sanitizeTerm(term);
  if (!c) return undefined;
  if (map.has(c)) return map.get(c);
  const lower = c.toLowerCase();
  for (const [k, v] of map) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Ranks exactly five terms using one transport: direct/proxy Google scrape, or SerpAPI google_trends (vendor).
 * Throws if any term lacks a finite score (no silent placeholder ordering).
 */
async function rankFiveTermsStrict(terms: string[]): Promise<Map<string, number>> {
  const normalized = terms.map((t) => sanitizeTerm(t)).filter((x): x is string => Boolean(x));
  if (normalized.length !== TREND_ITEMS_PER_PUZZLE) {
    throw new Error(`Expected ${TREND_ITEMS_PER_PUZZLE} sanitized terms for ranking, got ${normalized.length}`);
  }

  const mode = String(process.env.TRENDS_FETCH_MODE || "direct").trim().toLowerCase();
  let raw: Map<string, number>;

  if (mode === "vendor") {
    const key = String(process.env.SERPAPI_KEY || "").trim();
    if (!key) {
      throw new Error("TRENDS_FETCH_MODE=vendor requires SERPAPI_KEY");
    }
    raw = await rankTermsBySerpApiInterest(normalized, key);
  } else {
    raw = await rankTermsByGoogleInterest(normalized, "strict-five");
  }

  const out = new Map<string, number>();
  for (const t of normalized) {
    const s = scoreMapGetCaseInsensitive(raw, t);
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw new Error(
        `Incomplete Google Trends interest data for term "${t}" (mode=${mode}). Check TRENDS_ORIGIN proxy or switch TRENDS_FETCH_MODE=vendor with SERPAPI_KEY.`,
      );
    }
    out.set(t, s);
  }
  return out;
}

/**
 * Uniform random five (deterministic by seedKey): shuffle capped pool, take first five.
 * If forcedSeed is set and puzzle-friendly, it is always included and the other four are drawn from the rest.
 */
export function deterministicPickFiveFromPool(
  puzzleFriendly: string[],
  seedKey: string,
  forcedSeed?: string,
): string[] {
  if (puzzleFriendly.length < MIN_PUZZLE_FRIENDLY_POOL) {
    throw new Error(
      `Need at least ${MIN_PUZZLE_FRIENDLY_POOL} puzzle-friendly candidates, got ${puzzleFriendly.length}`,
    );
  }

  let pool = puzzleFriendly.slice(0, MAX_CANDIDATES_FOR_SAMPLE);
  const forcedRaw = forcedSeed?.trim() ? sanitizeTerm(forcedSeed.trim()) : null;

  if (forcedRaw) {
    if (!isPuzzleFriendlyTerm(forcedRaw)) {
      throw new Error("forcedSeed is not a puzzle-friendly term");
    }
    const forced = forcedRaw;
    const withoutForced = pool.filter((t) => t.toLowerCase() !== forced.toLowerCase());
    const need = TREND_ITEMS_PER_PUZZLE - 1;
    if (withoutForced.length < need) {
      throw new Error("Not enough candidates to combine with forcedSeed");
    }
    const shuffledRest = deterministicShuffle(withoutForced, `${seedKey}:forced-fill`);
    return [forced, ...shuffledRest.slice(0, need)];
  }

  const shuffled = deterministicShuffle(pool, `${seedKey}:pick5`);
  return shuffled.slice(0, TREND_ITEMS_PER_PUZZLE);
}

export async function generateTrendPuzzle(options: {
  puzzleId: string;
  sourceDate?: string;
  forcedSeed?: string;
}): Promise<{ topicSeed: string; sourceDate: string; timeframe: string; items: TrendItem[] }> {
  const sourceDate = options.sourceDate || puzzleDateId(0);
  const candidates = await fetchDailyCandidates();
  const puzzleFriendlyCandidates = candidates.filter((x) => isPuzzleFriendlyTerm(x));

  const pickedTerms = deterministicPickFiveFromPool(
    puzzleFriendlyCandidates,
    options.puzzleId,
    options.forcedSeed,
  );

  const scores = await rankFiveTermsStrict(pickedTerms);
  const sorted = [...pickedTerms].sort((a, b) => {
    const sa = scores.get(a) ?? 0;
    const sb = scores.get(b) ?? 0;
    if (sb !== sa) return sb - sa;
    return a.localeCompare(b);
  });

  const items: TrendItem[] = sorted.map((term, idx) => ({
    term,
    rank: idx + 1,
    score: scores.get(term) ?? null,
  }));

  const topicSeed = options.forcedSeed?.trim() ? String(sanitizeTerm(options.forcedSeed.trim()) || "") : "";

  return {
    topicSeed,
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
