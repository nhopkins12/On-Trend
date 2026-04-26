export type TrendItem = {
  term: string;
  rank: number;
  score: number | null;
};

/** IANA zone for a single app-wide "game day" (US Eastern, DST-aware). */
const PUZZLE_TIME_ZONE = "America/New_York";
export const TREND_ITEMS_PER_PUZZLE = 5;
/** Minimum puzzle-friendly candidates for legacy pick strategy. */
export const MIN_PUZZLE_FRIENDLY_POOL = 10;
/** Cap candidate pool size for legacy shuffle (performance). */
export const MAX_CANDIDATES_FOR_SAMPLE = 40;
export const FIXED_TIMEFRAME = "now 7-d";
const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const SERPAPI_ENGINE = "google_trends";
const SERPAPI_REGION = "US";

/** Top of merged ordered list used for stratified index picks. */
const STRATIFIED_HEAD_WINDOW = 30;
/** Minimum ordered candidates (after merge) to attempt stratified pick. */
const MIN_ORDERED_CANDIDATES = 5;
/**
 * Max full pick+rank cycles: low score spread, incomplete interest data (e.g. niche / one-word queries),
 * or transient Google empty timeline — each retry advances `attempt` so quintile / shuffle selection changes.
 */
export const GENERATION_MAX_ATTEMPTS = 5;
/** When direct Google has no data for a term, swap it for the next from the list before re-ranking. */
const MAX_FAILED_TERM_SUBSTITUTIONS = 12;
/** Set with SERPAPI_KEY: skip scraping Google; use SerpAPI only. */
const skipDirect = (): boolean => String(process.env.TRENDS_SKIP_DIRECT || "").trim() === "1";
const serpKey = (): string | undefined => {
  const k = String(process.env.SERPAPI_KEY || "").trim();
  return k || undefined;
};
/**
 * Min spread (max score − min) on 0–100 scale after ranking; if below, rotate indices and re-rank.
 */
export const MIN_SCORE_SPREAD = 3.0;
/** `stratified` (default) = list-anchored quintile pick; `legacy` = old shuffle pool. */
export const getPuzzlePickStrategy = (): "stratified" | "legacy" =>
  String(process.env.PUZZLE_PICK_STRATEGY || "stratified")
    .trim()
    .toLowerCase() === "legacy"
    ? "legacy"
    : "stratified";
/** Per-HTTP `fetch` timeout (ms) so Lambda does not hang on Trends. */
const FETCH_TIMEOUT_MS = Math.min(90_000, Math.max(5_000, Number(process.env.TRENDS_FETCH_TIMEOUT_MS) || 25_000));

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

function logStage(payload: Record<string, unknown>) {
  console.log(JSON.stringify({ source: "trends.generateTrendPuzzle", ...payload }));
}

export function stripXssi(text: string): string {
  return text.replace(/^\)\]\}',?\n/, "");
}

export function decodeXmlEntities(input: string): string {
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

function fetchSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Google Trends host or your reverse proxy origin (no trailing slash). */
function trendsOrigin(): string {
  return (process.env.TRENDS_ORIGIN || "https://trends.google.com").replace(/\/$/, "");
}

export function trendsUrl(pathWithLeadingSlash: string): string {
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

/** Relaxed: same length/word/noise rules; allows verb-like tokens (for thin days). */
export function isPuzzleAcceptableLoose(term: string): boolean {
  const normalized = String(term || "").trim();
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  if (normalized.length > 48) return false;
  if (PUZZLE_NOISE_PATTERNS.some((p) => p.test(normalized))) return false;
  return true;
}

/**
 * US dailytrends first (order preserved, dedupe by first occurrence), then RSS-only extras in RSS order.
 */
export function mergeOrderedUnique(legacyOrdered: string[], rssOrdered: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of legacyOrdered) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  for (const t of rssOrdered) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * One term per fifth of `window` (0..4), with rotation by hash + `attempt` so retries pick a different set.
 * Indices are unique where possible; uses offsets within each fifth if collision.
 */
export function pickQuintileIndices(
  windowLen: number,
  puzzleId: string,
  attempt: number,
): number[] {
  const W = Math.max(0, windowLen);
  if (W === 0) return [];
  const h = hashString(`${puzzleId}:quintile:${attempt}`);
  const out: number[] = [];
  const used = new Set<number>();

  for (let q = 0; q < 5; q++) {
    const start = Math.floor((q * W) / 5);
    const end = Math.max(start, Math.floor(((q + 1) * W) / 5) - 1);
    const segLen = end - start + 1;
    for (let k = 0; k < segLen; k++) {
      const j = (start + ((h >>> (q * 3 + k * 7)) + k + q * 11) % segLen) % W;
      if (!used.has(j)) {
        used.add(j);
        out.push(j);
        break;
      }
    }
    if (out.length === q) {
      for (let j = start; j <= end && out.length < q + 1; j++) {
        if (!used.has(j)) {
          used.add(j);
          out.push(j);
          break;
        }
      }
    }
  }
  if (out.length < 5) {
    for (let j = 0; j < W && out.length < 5; j++) {
      if (!used.has(j)) {
        used.add(j);
        out.push(j);
      }
    }
  }
  return out.slice(0, 5);
}

/**
 * Picks 5 from ordered list: quintile in head window, then walk ordered for strict, then loose.
 */
export function pickFiveStratified(
  orderedFull: string[],
  puzzleId: string,
  attempt: number,
  forcedSeed?: string,
): string[] {
  if (orderedFull.length < MIN_ORDERED_CANDIDATES) {
    throw new Error(
      `Need at least ${MIN_ORDERED_CANDIDATES} ordered candidates after merge, got ${orderedFull.length}`,
    );
  }

  const window = Math.min(STRATIFIED_HEAD_WINDOW, orderedFull.length);
  const head = orderedFull.slice(0, window);
  const forced = forcedSeed?.trim() ? sanitizeTerm(forcedSeed.trim()) : null;

  if (forced) {
    if (!isPuzzleAcceptableLoose(forced)) {
      throw new Error("forcedSeed failed loose puzzle checks");
    }
    const fLower = forced.toLowerCase();
    const rest = orderedFull.filter((t) => t.toLowerCase() !== fLower);
    if (rest.length < TREND_ITEMS_PER_PUZZLE - 1) {
      throw new Error("Not enough candidates to combine with forcedSeed");
    }
    const restWindow = rest.slice(0, Math.min(STRATIFIED_HEAD_WINDOW, rest.length));
    const wlen = restWindow.length;
    const idxs = pickQuintileIndices(wlen, puzzleId, attempt + 1);
    const picked: string[] = [forced];
    for (const i of idxs) {
      if (picked.length >= TREND_ITEMS_PER_PUZZLE) break;
      const t = restWindow[i];
      if (t && !picked.some((p) => p.toLowerCase() === t.toLowerCase())) {
        picked.push(t);
      }
    }
    return fillPickedFromOrdered(orderedFull, picked, puzzleId, attempt);
  }

  const idxs = pickQuintileIndices(window, puzzleId, attempt);
  const raw = idxs.map((i) => head[i]).filter(Boolean);
  return fillPickedFromOrdered(orderedFull, raw, puzzleId, attempt);
}

function fillPickedFromOrdered(orderedFull: string[], start: string[], puzzleId: string, attempt: number): string[] {
  const out: string[] = [];
  const have = (t: string) => out.some((x) => x.toLowerCase() === t.toLowerCase());
  for (const t of start) {
    if (t && !have(t) && isPuzzleFriendlyTerm(t)) out.push(t);
  }
  for (const t of start) {
    if (out.length >= TREND_ITEMS_PER_PUZZLE) break;
    if (t && !have(t) && isPuzzleAcceptableLoose(t)) out.push(t);
  }
  for (const t of orderedFull) {
    if (out.length >= TREND_ITEMS_PER_PUZZLE) break;
    if (have(t)) continue;
    if (isPuzzleFriendlyTerm(t)) out.push(t);
  }
  for (const t of orderedFull) {
    if (out.length >= TREND_ITEMS_PER_PUZZLE) break;
    if (have(t)) continue;
    if (isPuzzleAcceptableLoose(t)) out.push(t);
  }
  for (const t of orderedFull) {
    if (out.length >= TREND_ITEMS_PER_PUZZLE) break;
    const s = sanitizeTerm(t);
    if (s && isPuzzleAcceptableLoose(s) && !have(s)) out.push(s);
  }
  if (out.length < TREND_ITEMS_PER_PUZZLE) {
    throw new Error(
      `Stratified pick: could not find ${TREND_ITEMS_PER_PUZZLE} displayable terms (got ${out.length}) for puzzleId=${puzzleId} attempt=${attempt}`,
    );
  }
  return out.slice(0, TREND_ITEMS_PER_PUZZLE);
}

export async function fetchText(url: string): Promise<string> {
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
        signal: fetchSignal(FETCH_TIMEOUT_MS),
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

type RankMode = "direct" | "vendor";

function makeIncompleteError(t: string, mode: RankMode, hint?: string): Error {
  const base = `Incomplete Google Trends interest data for term "${t}" (mode=${mode}).`;
  const h =
    hint ||
    "Set SERPAPI_KEY (auto-tries SerpAPI after direct) or TRENDS_FETCH_MODE=vendor, TRENDS_SKIP_DIRECT=1, or a working TRENDS_ORIGIN proxy.";
  return new Error(`${base} ${h}`);
}

/**
 * Ranks 5 terms with a single transport; throws if any term has no score.
 */
async function rankFiveTermsStrictForMode(terms: string[], mode: RankMode): Promise<Map<string, number>> {
  const normalized = terms.map((t) => sanitizeTerm(t)).filter((x): x is string => Boolean(x));
  if (normalized.length !== TREND_ITEMS_PER_PUZZLE) {
    throw new Error(`Expected ${TREND_ITEMS_PER_PUZZLE} sanitized terms for ranking, got ${normalized.length}`);
  }

  let raw: Map<string, number>;
  if (mode === "vendor") {
    const key = serpKey();
    if (!key) {
      throw new Error("SERPAPI_KEY is required for vendor / SerpAPI ranking");
    }
    raw = await rankTermsBySerpApiInterest(normalized, key);
  } else {
    raw = await rankTermsByGoogleInterest(normalized, "strict-five");
  }

  const out = new Map<string, number>();
  for (const t of normalized) {
    const s = scoreMapGetCaseInsensitive(raw, t);
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw makeIncompleteError(t, mode);
    }
    out.set(t, s);
  }
  return out;
}

/**
 * Resolves 5 interest scores. Order of attempts:
 * - `TRENDS_FETCH_MODE=vendor` (or TRENDS_SKIP_DIRECT=1): SerpAPI only
 * - Else: direct (Google) first; on **any** incomplete term, if `SERPAPI_KEY` is set, one retry with SerpAPI for the same 5
 */
async function rankFiveWithTransportAndFallback(terms: string[], puzzleId: string): Promise<Map<string, number>> {
  const explicit = String(process.env.TRENDS_FETCH_MODE || "direct")
    .trim()
    .toLowerCase();
  if (skipDirect() || explicit === "vendor") {
    const k = serpKey();
    if (!k) {
      throw new Error("TRENDS_FETCH_MODE=vendor or TRENDS_SKIP_DIRECT=1 requires SERPAPI_KEY");
    }
    logStage({ stage: "rank_transport", transport: "vendor", puzzleId, reason: "explicit_or_skip_direct" });
    return rankFiveTermsStrictForMode(terms, "vendor");
  }

  try {
    logStage({ stage: "rank_transport", transport: "direct", puzzleId });
    return await rankFiveTermsStrictForMode(terms, "direct");
  } catch (e) {
    const k = serpKey();
    if (k) {
      logStage({
        stage: "serpapi_fallback",
        puzzleId,
        afterError: e instanceof Error ? e.message : String(e),
      });
      return rankFiveTermsStrictForMode(terms, "vendor");
    }
    throw e;
  }
}

/** From strict rank error, extract the first quoted term. */
function parseFirstQuotedTermInMessage(msg: string): string | null {
  const m = msg.match(/for term "([^"]+)"/i);
  return m?.[1] ?? null;
}

/**
 * Replaces one failed term in `current` with the first acceptable candidate in `ordered` (by list order) not already in the pick.
 * Respects `forced` as immovable: returns null if the missing term is forced.
 */
function substituteOneFailedTerm(
  current: string[],
  failedDisplayTerm: string,
  ordered: string[],
  forced: string | null,
): string[] | null {
  const failLower = failedDisplayTerm.toLowerCase();
  if (forced && failLower === forced.toLowerCase()) {
    return null;
  }
  const inPick = (t: string) => current.some((x) => x.toLowerCase() === t.toLowerCase());
  for (const c of ordered) {
    if (!c) continue;
    if (c.toLowerCase() === failLower) continue;
    if (inPick(c)) continue;
    if (!isPuzzleAcceptableLoose(c)) continue;
    return current.map((t) => (t.toLowerCase() === failLower ? c : t));
  }
  return null;
}

/**
 * Ranks with direct → SerpAPI fallback, then swaps any term that still has no data for the next list candidate.
 */
async function rankWithTermSubstitutions(
  initialPicked: string[],
  orderedCandidates: string[],
  forcedDisplay: string | null,
  puzzleId: string,
): Promise<{ scores: Map<string, number>; finalPicked: string[] }> {
  let current = [...initialPicked];
  for (let sub = 0; sub < MAX_FAILED_TERM_SUBSTITUTIONS; sub++) {
    try {
      const scores = await rankFiveWithTransportAndFallback(current, puzzleId);
      return { scores, finalPicked: current };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (forcedDisplay && /interest data for term/i.test(err.message)) {
        const m = err.message.match(/for term "([^"]+)"/i);
        if (m?.[1] && m[1].toLowerCase() === forcedDisplay.toLowerCase()) {
          throw new Error(
            `Cannot rank forcedSeed "${forcedDisplay}": no complete interest for that query (Google and SerpAPI). Try another topicSeed. ${err.message}`,
          );
        }
      }
      const miss = parseFirstQuotedTermInMessage(err.message);
      if (!miss) {
        throw err;
      }
      const nxt = substituteOneFailedTerm(current, miss, orderedCandidates, forcedDisplay);
      if (!nxt) {
        throw err;
      }
      const diffI = current.findIndex((t, i) => t !== nxt[i]);
      logStage({
        stage: "swap_no_data_term",
        puzzleId,
        sub,
        from: miss,
        to: diffI >= 0 ? nxt[diffI] : "?",
      });
      current = nxt;
    }
  }
  throw new Error("Exhausted term substitutions without a full ranking; broaden candidate list or set SERPAPI_KEY.");
}

function scoreSpread(scores: Map<string, number>): number {
  const vals = [...scores.values()];
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

/**
 * Uniform random five (deterministic by seedKey): shuffle capped pool, take first five.
 * If forcedSeed is set and puzzle-friendly, it is always included and the other four are drawn from the rest.
 * Used when PUZZLE_PICK_STRATEGY=legacy.
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

  const pool = puzzleFriendly.slice(0, MAX_CANDIDATES_FOR_SAMPLE);
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

export type GeneratedPuzzle = {
  topicSeed: string;
  sourceDate: string;
  timeframe: string;
  items: TrendItem[];
  rankSource: string;
  bqpRefreshDate: string;
  regionKey: string;
};

function puzzleRankSource(): "bigquery" | "legacy" {
  return String(process.env.PUZZLE_RANK_SOURCE || "legacy").trim().toLowerCase() === "bigquery" ? "bigquery" : "legacy";
}

export async function generateTrendPuzzle(options: {
  puzzleId: string;
  sourceDate?: string;
  forcedSeed?: string;
}): Promise<GeneratedPuzzle> {
  if (puzzleRankSource() === "bigquery") {
    const { runBigQueryPuzzle } = await import("./puzzle/orchestrate");
    return runBigQueryPuzzle(options);
  }
  return generateTrendPuzzleLegacy(options);
}

async function generateTrendPuzzleLegacy(options: {
  puzzleId: string;
  sourceDate?: string;
  forcedSeed?: string;
}): Promise<GeneratedPuzzle> {
  const { fetchDailyCandidates } = await import("./puzzle/candidates");
  const sourceDate = options.sourceDate || puzzleDateId(0);
  const strategy = getPuzzlePickStrategy();
  const t0 = Date.now();

  const candidates = await fetchDailyCandidates();
  logStage({
    stage: "candidates_fetched",
    puzzleId: options.puzzleId,
    strategy,
    rawCount: candidates.length,
    headPreview: candidates.slice(0, 5),
  });

  for (let attempt = 0; attempt < GENERATION_MAX_ATTEMPTS; attempt++) {
    let pickedTerms: string[];
    try {
      if (strategy === "legacy") {
        const puzzleFriendlyCandidates = candidates.filter((x) => isPuzzleFriendlyTerm(x));
        pickedTerms = deterministicPickFiveFromPool(
          puzzleFriendlyCandidates,
          `${options.puzzleId}:lowSpreadRetry:${attempt}`,
          options.forcedSeed,
        );
      } else {
        pickedTerms = pickFiveStratified(candidates, options.puzzleId, attempt, options.forcedSeed);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logStage({ stage: "pick_failed", puzzleId: options.puzzleId, attempt, error: err.message });
      throw err;
    }

    const forcedDisplay = options.forcedSeed?.trim() ? sanitizeTerm(options.forcedSeed.trim()) : null;

    let scores: Map<string, number>;
    let termsForOutput: string[];
    try {
      const ranked = await rankWithTermSubstitutions(pickedTerms, candidates, forcedDisplay, options.puzzleId);
      scores = ranked.scores;
      termsForOutput = ranked.finalPicked;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const canRetry = attempt < GENERATION_MAX_ATTEMPTS - 1;
      logStage({
        stage: "rank_failed",
        puzzleId: options.puzzleId,
        attempt,
        pickedTerms,
        error: err.message,
        willRetry: canRetry,
        ms: Date.now() - t0,
      });
      if (canRetry) {
        logStage({
          stage: "rank_retry_new_pick",
          puzzleId: options.puzzleId,
          nextAttempt: attempt + 1,
        });
        continue;
      }
      throw err;
    }

    const spread = scoreSpread(scores);
    const sorted = [...termsForOutput].sort((a, b) => {
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

    logStage({
      stage: "rank_ok",
      puzzleId: options.puzzleId,
      attempt,
      strategy,
      pickedTerms: termsForOutput,
      scoreSpread: spread,
      minScore: Math.min(...[...scores.values()]),
      maxScore: Math.max(...[...scores.values()]),
      ms: Date.now() - t0,
    });

    if (spread >= MIN_SCORE_SPREAD || attempt === GENERATION_MAX_ATTEMPTS - 1) {
      if (spread < MIN_SCORE_SPREAD) {
        logStage({
          stage: "low_spread_accepted",
          puzzleId: options.puzzleId,
          attempt,
          scoreSpread: spread,
        });
      }
      return {
        topicSeed,
        sourceDate,
        timeframe: FIXED_TIMEFRAME,
        items,
        rankSource: "legacy:google_multiline_serp",
        bqpRefreshDate: "",
        regionKey: "US",
      };
    }

    logStage({ stage: "low_spread_retry", puzzleId: options.puzzleId, attempt, scoreSpread: spread });
  }

  throw new Error("generateTrendPuzzle: exhausted pick attempts");
}

export function deriveStatusForDate(id: string, todayId: string): "archived" | "active" | "next" {
  if (id < todayId) return "archived";
  if (id === todayId) return "active";
  return "next";
}
