/** IANA zone for a single app-wide "game day" (US Eastern, DST-aware). */
const PUZZLE_TIME_ZONE = "America/New_York";
export const TREND_ITEMS_PER_PUZZLE = 5;
/** Minimum puzzle-friendly candidates for legacy pick strategy. */
export const MIN_PUZZLE_FRIENDLY_POOL = 10;
/** Cap candidate pool size for legacy shuffle (performance). */
export const MAX_CANDIDATES_FOR_SAMPLE = 40;
export const FIXED_TIMEFRAME = "now 7-d";
const DAILY_RSS_GEOS = ["US"];
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
const GENERATION_MAX_ATTEMPTS = 5;
/**
 * Min spread (max score − min) on 0–100 scale after ranking; if below, rotate indices and re-rank.
 */
const MIN_SCORE_SPREAD = 3.0;
/** `stratified` (default) = list-anchored quintile pick; `legacy` = old shuffle pool. */
const pickStrategy = () => String(process.env.PUZZLE_PICK_STRATEGY || "stratified")
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
function logStage(payload) {
    console.log(JSON.stringify({ source: "trends.generateTrendPuzzle", ...payload }));
}
function stripXssi(text) {
    return text.replace(/^\)\]\}',?\n/, "");
}
function decodeXmlEntities(input) {
    return input
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
function toDateIdInTZ(date, timeZone) {
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
export function puzzleDateId(offsetDays = 0) {
    const today = toDateIdInTZ(new Date(), PUZZLE_TIME_ZONE);
    if (offsetDays === 0)
        return today;
    const [y, m, d] = today.split("-").map(Number);
    const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
    const shifted = utcNoon + offsetDays * 24 * 60 * 60 * 1000;
    return toDateIdInTZ(new Date(shifted), PUZZLE_TIME_ZONE);
}
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
function fetchSignal(ms) {
    if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
        return AbortSignal.timeout(ms);
    }
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}
/** Google Trends host or your reverse proxy origin (no trailing slash). */
function trendsOrigin() {
    return (process.env.TRENDS_ORIGIN || "https://trends.google.com").replace(/\/$/, "");
}
function trendsUrl(pathWithLeadingSlash) {
    const p = pathWithLeadingSlash.startsWith("/") ? pathWithLeadingSlash : `/${pathWithLeadingSlash}`;
    return `${trendsOrigin()}${p}`;
}
export function sanitizeTerm(input) {
    const cleaned = String(input || "")
        .replace(/\s+/g, " ")
        .trim();
    if (cleaned.length < 2 || cleaned.length > 80)
        return null;
    if (/^[^A-Za-z0-9]+$/.test(cleaned))
        return null;
    if (/[^\w\s'&+\-/.#]/.test(cleaned))
        return null;
    return cleaned;
}
export function isPuzzleFriendlyTerm(term) {
    const normalized = String(term || "").trim();
    if (!normalized)
        return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 5)
        return false;
    if (normalized.length > 48)
        return false;
    if (PUZZLE_NOISE_PATTERNS.some((p) => p.test(normalized)))
        return false;
    const tokens = normalized
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter(Boolean);
    if (!tokens.length)
        return false;
    const nonNounCount = tokens.filter((t) => NON_NOUN_TOKENS.has(t)).length;
    if (nonNounCount > 0)
        return false;
    return true;
}
/** Relaxed: same length/word/noise rules; allows verb-like tokens (for thin days). */
export function isPuzzleAcceptableLoose(term) {
    const normalized = String(term || "").trim();
    if (!normalized)
        return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 5)
        return false;
    if (normalized.length > 48)
        return false;
    if (PUZZLE_NOISE_PATTERNS.some((p) => p.test(normalized)))
        return false;
    return true;
}
/**
 * US dailytrends first (order preserved, dedupe by first occurrence), then RSS-only extras in RSS order.
 */
export function mergeOrderedUnique(legacyOrdered, rssOrdered) {
    const seen = new Set();
    const out = [];
    for (const t of legacyOrdered) {
        if (!t)
            continue;
        const k = t.toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(t);
    }
    for (const t of rssOrdered) {
        if (!t)
            continue;
        const k = t.toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(t);
    }
    return out;
}
/**
 * One term per fifth of `window` (0..4), with rotation by hash + `attempt` so retries pick a different set.
 * Indices are unique where possible; uses offsets within each fifth if collision.
 */
export function pickQuintileIndices(windowLen, puzzleId, attempt) {
    const W = Math.max(0, windowLen);
    if (W === 0)
        return [];
    const h = hashString(`${puzzleId}:quintile:${attempt}`);
    const out = [];
    const used = new Set();
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
export function pickFiveStratified(orderedFull, puzzleId, attempt, forcedSeed) {
    if (orderedFull.length < MIN_ORDERED_CANDIDATES) {
        throw new Error(`Need at least ${MIN_ORDERED_CANDIDATES} ordered candidates after merge, got ${orderedFull.length}`);
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
        const picked = [forced];
        for (const i of idxs) {
            if (picked.length >= TREND_ITEMS_PER_PUZZLE)
                break;
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
function fillPickedFromOrdered(orderedFull, start, puzzleId, attempt) {
    const out = [];
    const have = (t) => out.some((x) => x.toLowerCase() === t.toLowerCase());
    for (const t of start) {
        if (t && !have(t) && isPuzzleFriendlyTerm(t))
            out.push(t);
    }
    for (const t of start) {
        if (out.length >= TREND_ITEMS_PER_PUZZLE)
            break;
        if (t && !have(t) && isPuzzleAcceptableLoose(t))
            out.push(t);
    }
    for (const t of orderedFull) {
        if (out.length >= TREND_ITEMS_PER_PUZZLE)
            break;
        if (have(t))
            continue;
        if (isPuzzleFriendlyTerm(t))
            out.push(t);
    }
    for (const t of orderedFull) {
        if (out.length >= TREND_ITEMS_PER_PUZZLE)
            break;
        if (have(t))
            continue;
        if (isPuzzleAcceptableLoose(t))
            out.push(t);
    }
    for (const t of orderedFull) {
        if (out.length >= TREND_ITEMS_PER_PUZZLE)
            break;
        const s = sanitizeTerm(t);
        if (s && isPuzzleAcceptableLoose(s) && !have(s))
            out.push(s);
    }
    if (out.length < TREND_ITEMS_PER_PUZZLE) {
        throw new Error(`Stratified pick: could not find ${TREND_ITEMS_PER_PUZZLE} displayable terms (got ${out.length}) for puzzleId=${puzzleId} attempt=${attempt}`);
    }
    return out.slice(0, TREND_ITEMS_PER_PUZZLE);
}
async function fetchText(url) {
    const maxAttempts = 3;
    let lastError = null;
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
        }
        catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
                continue;
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}
async function fetchJson(url) {
    const txt = await fetchText(url);
    return JSON.parse(txt);
}
function parseDailyRssTitlesOrdered(xmlText) {
    const out = [];
    const seen = new Set();
    const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const block of itemMatches) {
        const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
        if (!titleMatch?.[1])
            continue;
        const clean = sanitizeTerm(decodeXmlEntities(titleMatch[1]));
        if (clean) {
            const k = clean.toLowerCase();
            if (!seen.has(k)) {
                seen.add(k);
                out.push(clean);
            }
        }
    }
    return out;
}
async function fetchRssDailyOrdered() {
    const merged = [];
    for (const geo of DAILY_RSS_GEOS) {
        try {
            const txt = await fetchText(trendsUrl(`/trending/rss?geo=${encodeURIComponent(geo)}`));
            merged.push(...parseDailyRssTitlesOrdered(txt));
        }
        catch {
            // no-op
        }
    }
    const seen = new Set();
    const ordered = [];
    for (const t of merged) {
        const k = t.toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        ordered.push(t);
    }
    return ordered;
}
/**
 * Preserves Google dailytrends `trendingSearches` order; dedupes by first occurrence (case-insensitive).
 */
function parseLegacyDailyListOrderedFromPayload(payload) {
    const latestDay = payload?.default?.trendingSearchesDays?.[0];
    const list = Array.isArray(latestDay?.trendingSearches) ? latestDay.trendingSearches : [];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const clean = sanitizeTerm(entry?.title?.query);
        if (clean) {
            const k = clean.toLowerCase();
            if (seen.has(k))
                continue;
            seen.add(k);
            out.push(clean);
        }
    }
    return out;
}
async function fetchLegacyDailyCandidatesOrdered() {
    const urls = [
        "/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15",
        "/trends/api/dailytrends?hl=en-US&tz=0&geo=&ns=15",
    ];
    for (const path of urls) {
        try {
            const txt = await fetchText(trendsUrl(path));
            const payload = JSON.parse(stripXssi(txt));
            const out = parseLegacyDailyListOrderedFromPayload(payload);
            if (out.length)
                return out;
        }
        catch {
            // try next variant
        }
    }
    return [];
}
async function fetchDailyCandidates() {
    const legacy = await fetchLegacyDailyCandidatesOrdered();
    const rss = await fetchRssDailyOrdered();
    const merged = mergeOrderedUnique(legacy, rss);
    if (merged.length)
        return merged;
    throw new Error("No candidates available from Google Trends sources.");
}
function chunkArray(items, chunkSize) {
    const out = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        out.push(items.slice(i, i + chunkSize));
    }
    return out;
}
async function fetchExploreWidgetsForComparison(keywords) {
    const req = {
        comparisonItem: keywords.map((keyword) => ({ keyword, geo: "US", time: FIXED_TIMEFRAME })),
        category: 0,
        property: "",
    };
    const url = trendsUrl(`/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`);
    const txt = await fetchText(url);
    const payload = JSON.parse(stripXssi(txt));
    return Array.isArray(payload?.widgets) ? payload.widgets : [];
}
async function fetchInterestAveragesForKeywords(keywords) {
    const out = new Map();
    if (!Array.isArray(keywords) || keywords.length === 0)
        return out;
    let widgets = [];
    try {
        widgets = await fetchExploreWidgetsForComparison(keywords);
    }
    catch {
        return out;
    }
    const timeWidget = widgets.find((w) => w?.id === "TIMESERIES") ||
        widgets.find((w) => String(w?.title || "").toLowerCase().includes("interest over time"));
    if (!timeWidget?.token || !timeWidget?.request)
        return out;
    const url = trendsUrl(`/trends/api/widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(timeWidget.request))}&token=${encodeURIComponent(String(timeWidget.token))}`);
    let txt = "";
    try {
        txt = await fetchText(url);
    }
    catch {
        return out;
    }
    const payload = JSON.parse(stripXssi(txt));
    const timeline = Array.isArray(payload?.default?.timelineData) ? payload.default.timelineData : [];
    if (!timeline.length)
        return out;
    const sums = new Array(keywords.length).fill(0);
    const counts = new Array(keywords.length).fill(0);
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
async function rankTermsByGoogleInterest(terms, seedKey) {
    const ranked = new Map();
    const unique = Array.from(new Set(terms
        .map((term) => sanitizeTerm(term))
        .filter((x) => Boolean(x))
        .map((x) => x.toLowerCase())));
    const canonical = new Map();
    for (const term of terms) {
        const clean = sanitizeTerm(term);
        if (!clean)
            continue;
        const key = clean.toLowerCase();
        if (!canonical.has(key))
            canonical.set(key, clean);
    }
    const ordered = unique.map((key) => canonical.get(key)).filter(Boolean);
    if (ordered.length === 0)
        return ranked;
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
            if (typeof termAvg !== "number" || !Number.isFinite(termAvg))
                continue;
            let normalized;
            if (typeof anchorAvg === "number" && Number.isFinite(anchorAvg) && anchorAvg > 0) {
                normalized = (termAvg / anchorAvg) * 100;
            }
            else {
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
async function rankTermsBySerpApiInterest(terms, apiKey) {
    const ranked = new Map();
    const normalizedTerms = Array.from(new Set(terms
        .map((x) => sanitizeTerm(x))
        .filter((x) => Boolean(x))));
    if (normalizedTerms.length === 0)
        return ranked;
    const url = `${SERPAPI_ENDPOINT}?engine=${encodeURIComponent(SERPAPI_ENGINE)}&data_type=TIMESERIES&q=${encodeURIComponent(normalizedTerms.join(","))}&date=${encodeURIComponent(FIXED_TIMEFRAME)}&geo=${encodeURIComponent(SERPAPI_REGION)}&api_key=${encodeURIComponent(apiKey)}`;
    let payload;
    try {
        payload = await fetchJson(url);
    }
    catch {
        return ranked;
    }
    const apiError = payload?.error;
    if (typeof apiError === "string" && apiError.trim())
        return ranked;
    const timeline = Array.isArray(payload?.interest_over_time?.timeline_data)
        ? payload.interest_over_time.timeline_data
        : [];
    const sums = new Array(normalizedTerms.length).fill(0);
    const counts = new Array(normalizedTerms.length).fill(0);
    for (const point of timeline) {
        const values = Array.isArray(point?.values) ? point.values : [];
        for (let i = 0; i < values.length; i++) {
            const row = values[i];
            const extracted = row?.extracted_value;
            const query = sanitizeTerm(String(row?.query || "")) || normalizedTerms[i];
            const idx = normalizedTerms.findIndex((term) => term.toLowerCase() === query.toLowerCase());
            if (idx < 0)
                continue;
            if (typeof extracted === "number" && Number.isFinite(extracted)) {
                sums[idx] += extracted;
                counts[idx] += 1;
            }
        }
    }
    const averages = sums.map((sum, idx) => (counts[idx] > 0 ? sum / counts[idx] : 0));
    const maxAvg = Math.max(...averages, 0);
    if (maxAvg <= 0)
        return ranked;
    for (let i = 0; i < normalizedTerms.length; i++) {
        const avg = averages[i];
        if (Number.isFinite(avg) && avg > 0) {
            ranked.set(normalizedTerms[i], (avg / maxAvg) * 100);
        }
    }
    return ranked;
}
function scoreMapGetCaseInsensitive(map, term) {
    const c = sanitizeTerm(term);
    if (!c)
        return undefined;
    if (map.has(c))
        return map.get(c);
    const lower = c.toLowerCase();
    for (const [k, v] of map) {
        if (k.toLowerCase() === lower)
            return v;
    }
    return undefined;
}
/**
 * Ranks exactly five terms using one transport: direct/proxy Google scrape, or SerpAPI google_trends (vendor).
 * Throws if any term lacks a finite score (no silent placeholder ordering).
 */
async function rankFiveTermsStrict(terms) {
    const normalized = terms.map((t) => sanitizeTerm(t)).filter((x) => Boolean(x));
    if (normalized.length !== TREND_ITEMS_PER_PUZZLE) {
        throw new Error(`Expected ${TREND_ITEMS_PER_PUZZLE} sanitized terms for ranking, got ${normalized.length}`);
    }
    const mode = String(process.env.TRENDS_FETCH_MODE || "direct").trim().toLowerCase();
    let raw;
    if (mode === "vendor") {
        const key = String(process.env.SERPAPI_KEY || "").trim();
        if (!key) {
            throw new Error("TRENDS_FETCH_MODE=vendor requires SERPAPI_KEY");
        }
        raw = await rankTermsBySerpApiInterest(normalized, key);
    }
    else {
        raw = await rankTermsByGoogleInterest(normalized, "strict-five");
    }
    const out = new Map();
    for (const t of normalized) {
        const s = scoreMapGetCaseInsensitive(raw, t);
        if (typeof s !== "number" || !Number.isFinite(s)) {
            throw new Error(`Incomplete Google Trends interest data for term "${t}" (mode=${mode}). Check TRENDS_ORIGIN proxy or switch TRENDS_FETCH_MODE=vendor with SERPAPI_KEY.`);
        }
        out.set(t, s);
    }
    return out;
}
function scoreSpread(scores) {
    const vals = [...scores.values()];
    if (vals.length < 2)
        return 0;
    return Math.max(...vals) - Math.min(...vals);
}
/**
 * Uniform random five (deterministic by seedKey): shuffle capped pool, take first five.
 * If forcedSeed is set and puzzle-friendly, it is always included and the other four are drawn from the rest.
 * Used when PUZZLE_PICK_STRATEGY=legacy.
 */
export function deterministicPickFiveFromPool(puzzleFriendly, seedKey, forcedSeed) {
    if (puzzleFriendly.length < MIN_PUZZLE_FRIENDLY_POOL) {
        throw new Error(`Need at least ${MIN_PUZZLE_FRIENDLY_POOL} puzzle-friendly candidates, got ${puzzleFriendly.length}`);
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
export async function generateTrendPuzzle(options) {
    const sourceDate = options.sourceDate || puzzleDateId(0);
    const strategy = pickStrategy();
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
        let pickedTerms;
        try {
            if (strategy === "legacy") {
                const puzzleFriendlyCandidates = candidates.filter((x) => isPuzzleFriendlyTerm(x));
                pickedTerms = deterministicPickFiveFromPool(puzzleFriendlyCandidates, `${options.puzzleId}:lowSpreadRetry:${attempt}`, options.forcedSeed);
            }
            else {
                pickedTerms = pickFiveStratified(candidates, options.puzzleId, attempt, options.forcedSeed);
            }
        }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            logStage({ stage: "pick_failed", puzzleId: options.puzzleId, attempt, error: err.message });
            throw err;
        }
        let scores;
        try {
            scores = await rankFiveTermsStrict(pickedTerms);
        }
        catch (e) {
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
        const sorted = [...pickedTerms].sort((a, b) => {
            const sa = scores.get(a) ?? 0;
            const sb = scores.get(b) ?? 0;
            if (sb !== sa)
                return sb - sa;
            return a.localeCompare(b);
        });
        const items = sorted.map((term, idx) => ({
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
            pickedTerms,
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
            return { topicSeed, sourceDate, timeframe: FIXED_TIMEFRAME, items };
        }
        logStage({ stage: "low_spread_retry", puzzleId: options.puzzleId, attempt, scoreSpread: spread });
    }
    throw new Error("generateTrendPuzzle: exhausted pick attempts");
}
export function deriveStatusForDate(id, todayId) {
    if (id < todayId)
        return "archived";
    if (id === todayId)
        return "active";
    return "next";
}
