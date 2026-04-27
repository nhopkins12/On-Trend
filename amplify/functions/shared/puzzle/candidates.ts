import {
  decodeXmlEntities,
  fetchText,
  mergeOrderedUnique,
  sanitizeTerm,
  stripXssi,
  trendsUrl,
} from "../trends";

const DAILY_RSS_GEOS = ["US"];

/**
 * When unset: `legacy` rank source includes dailytrends (matches old merge behavior);
 * `bigquery` rank source excludes it so picks align with BQ top terms + RSS/curated only.
 * Override with CANDIDATE_INCLUDE_LEGACY_GOOGLE=1|0|true|false.
 */
function includeLegacyGoogleList(): boolean {
  const raw = String(process.env.CANDIDATE_INCLUDE_LEGACY_GOOGLE ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  const rank = String(process.env.PUZZLE_RANK_SOURCE || "legacy").trim().toLowerCase();
  return rank !== "bigquery";
}

/** Comma- or semicolon-separated terms; listed first in merge order. */
function parseCuratedFromEnv(): string[] {
  const raw = String(process.env.PUZZLE_CURATED_TERMS || "").trim();
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;]/)) {
    const c = sanitizeTerm(part.trim());
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function parseDailyRssTitlesOrdered(xmlText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const itemMatches = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];

  for (const block of itemMatches) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch?.[1]) continue;
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

export async function fetchRssDailyOrdered(): Promise<string[]> {
  const merged: string[] = [];
  for (const geo of DAILY_RSS_GEOS) {
    try {
      const txt = await fetchText(trendsUrl(`/trending/rss?geo=${encodeURIComponent(geo)}`));
      merged.push(...parseDailyRssTitlesOrdered(txt));
    } catch {
      // no-op
    }
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const t of merged) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(t);
  }
  return ordered;
}

function parseLegacyDailyListOrderedFromPayload(payload: any): string[] {
  const latestDay = payload?.default?.trendingSearchesDays?.[0];
  const list = Array.isArray(latestDay?.trendingSearches) ? latestDay.trendingSearches : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    const clean = sanitizeTerm(entry?.title?.query);
    if (clean) {
      const k = clean.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(clean);
    }
  }
  return out;
}

export async function fetchLegacyDailyCandidatesOrdered(): Promise<string[]> {
  const urls = [
    "/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15",
    "/trends/api/dailytrends?hl=en-US&tz=0&geo=&ns=15",
  ];

  for (const path of urls) {
    try {
      const txt = await fetchText(trendsUrl(path));
      const payload = JSON.parse(stripXssi(txt));
      const out = parseLegacyDailyListOrderedFromPayload(payload);
      if (out.length) return out;
    } catch {
      // try next variant
    }
  }
  return [];
}

/**
 * Daily puzzle candidate strings: optional curated (env) first, then Google RSS,
 * and optionally (CANDIDATE_INCLUDE_LEGACY_GOOGLE=1) dailytrends JSON merged before RSS dedupe.
 */
export async function fetchDailyCandidates(): Promise<string[]> {
  const curated = parseCuratedFromEnv();
  const rss = await fetchRssDailyOrdered();
  const legacy = includeLegacyGoogleList() ? await fetchLegacyDailyCandidatesOrdered() : [];
  const fromGoogle = mergeOrderedUnique(legacy, rss);
  const merged = mergeOrderedUnique(curated, fromGoogle);
  if (merged.length) return merged;
  throw new Error(
    "No candidates available. Configure PUZZLE_CURATED_TERMS, ensure RSS is reachable, and/or set CANDIDATE_INCLUDE_LEGACY_GOOGLE=1 for dailytrends.",
  );
}
