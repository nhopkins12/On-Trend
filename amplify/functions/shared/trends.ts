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
export const FIXED_TIMEFRAME = "now 1-d";

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

function stripXssi(text: string): string {
  return text.replace(/^\)\]\}',?\n/, "");
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function fetchDailyCandidates(): Promise<string[]> {
  const url = "https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=0&geo=&ns=15";
  const txt = await fetchText(url);
  const payload = JSON.parse(stripXssi(txt));

  const out: string[] = [];
  const days = payload?.default?.trendingSearchesDays;
  if (Array.isArray(days)) {
    // Use only the freshest daily bucket to keep generation within the recent 24h window.
    const latestDay = days[0];
    const list = latestDay?.trendingSearches;
    if (Array.isArray(list)) {
      for (const entry of list) {
        const q = entry?.title?.query;
        const clean = sanitizeTerm(q);
        if (clean) out.push(clean);
      }
    }
  }

  return Array.from(new Set(out));
}

async function fetchExploreWidgets(keyword: string): Promise<any[]> {
  const req = {
    comparisonItem: [{ keyword, geo: "", time: FIXED_TIMEFRAME }],
    category: 0,
    property: "",
  };

  const url = `https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`;
  const txt = await fetchText(url);
  const payload = JSON.parse(stripXssi(txt));
  return Array.isArray(payload?.widgets) ? payload.widgets : [];
}

async function fetchRelatedTerms(seed: string): Promise<RankedTerm[]> {
  const widgets = await fetchExploreWidgets(seed);
  const relatedWidget = widgets.find((w) => w?.id === "RELATED_QUERIES") || widgets.find((w) => w?.title === "Related queries");
  if (!relatedWidget?.token || !relatedWidget?.request) return [];

  const url = `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(relatedWidget.request))}&token=${encodeURIComponent(String(relatedWidget.token))}`;
  const txt = await fetchText(url);
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
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
}

export async function generateTrendPuzzle(options: {
  puzzleId: string;
  sourceDate?: string;
  forcedSeed?: string;
}): Promise<{ topicSeed: string; sourceDate: string; timeframe: string; items: TrendItem[] }> {
  const sourceDate = options.sourceDate || dateIdInToronto(0);
  const candidates = await fetchDailyCandidates();
  if (candidates.length < TREND_ITEMS_PER_PUZZLE) {
    throw new Error("Insufficient daily trend candidates.");
  }

  const seedCandidates = deterministicShuffle(candidates.slice(0, 32), `${options.puzzleId}:seed`);
  const manualSeed = sanitizeTerm(options.forcedSeed || "");

  let selectedSeed = manualSeed || "";
  let related: RankedTerm[] = [];

  if (selectedSeed) {
    related = await fetchRelatedTerms(selectedSeed);
  } else {
    for (const seed of seedCandidates) {
      const rel = await fetchRelatedTerms(seed);
      if (rel.filter((x) => x.score >= 45).length >= 8) {
        selectedSeed = seed;
        related = rel;
        break;
      }
    }
  }

  if (!selectedSeed) {
    selectedSeed = seedCandidates[0];
  }

  const clusterPool = mergeRankedTerms(related);
  const seedClean = sanitizeTerm(selectedSeed) || selectedSeed;

  if (seedClean && !clusterPool.find((x) => x.term.toLowerCase() === seedClean.toLowerCase())) {
    const top = clusterPool[0]?.score ?? 100;
    clusterPool.unshift({ term: seedClean, score: top + 1, isTopSignal: true });
  }

  const fallbackPool = mergeRankedTerms(
    candidates.map((term, index) => ({ term, score: Math.max(1, 100 - index), isTopSignal: true }))
  );

  const selected: RankedTerm[] = [];
  const seen = new Set<string>();

  for (const item of clusterPool) {
    const key = item.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length === TREND_ITEMS_PER_PUZZLE) break;
  }

  if (selected.length < TREND_ITEMS_PER_PUZZLE) {
    for (const item of fallbackPool) {
      const key = item.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(item);
      if (selected.length === TREND_ITEMS_PER_PUZZLE) break;
    }
  }

  if (selected.length < TREND_ITEMS_PER_PUZZLE) {
    throw new Error("Unable to build 5 unique trend items.");
  }

  const sorted = selected
    .slice(0, TREND_ITEMS_PER_PUZZLE)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

  const items: TrendItem[] = sorted.map((entry, idx) => ({
    term: entry.term,
    rank: idx + 1,
    score: Number.isFinite(entry.score) ? entry.score : null,
  }));

  return {
    topicSeed: seedClean,
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
