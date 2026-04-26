import type { BigQuery } from "@google-cloud/bigquery";

type Row = { term: string; rnk: number; scr: number | null };

let bqClient: BigQuery | null = null;

function getProjectId(): string {
  const p = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.BIGQUERY_PROJECT || "").trim();
  if (p) return p;
  const raw = String(process.env.BIGQUERY_SERVICE_ACCOUNT_JSON || "").trim();
  if (raw) {
    try {
      const j = JSON.parse(raw) as { project_id?: string };
      if (j.project_id) return j.project_id;
    } catch {
      // no-op
    }
  }
  return "";
}

async function getBigQuery(): Promise<BigQuery> {
  if (bqClient) return bqClient;
  const { BigQuery } = await import("@google-cloud/bigquery");
  const json = String(process.env.BIGQUERY_SERVICE_ACCOUNT_JSON || "").trim();
  if (!json) {
    throw new Error(
      "BigQuery ranking: set BIGQUERY_SERVICE_ACCOUNT_JSON to a service account JSON (string) with BigQuery read access, and GOOGLE_CLOUD_PROJECT (or project_id in the key).",
    );
  }
  const creds = JSON.parse(json) as { project_id?: string } & object;
  const projectId = getProjectId() || creds.project_id;
  if (!projectId) {
    throw new Error("BigQuery ranking: missing GOOGLE_CLOUD_PROJECT (or project_id in service account JSON).");
  }
  bqClient = new BigQuery({ projectId, credentials: creds });
  return bqClient;
}

export function resolveBqRefreshDate(sourceDate: string): string {
  const offset = Math.trunc(Number(process.env.PUZZLE_BQ_REFRESH_OFFSET_DAYS ?? "-1"));
  const d = new Date(`${sourceDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid sourceDate: ${sourceDate}`);
  }
  d.setUTCDate(d.getUTCDate() + (Number.isFinite(offset) ? offset : -1));
  return d.toISOString().slice(0, 10);
}

function sanitizeTableId(table: string): string {
  const t = table.trim();
  if (!/^[a-zA-Z0-9_.-]+(\.[a-zA-Z0-9_.-]+)*$/.test(t)) {
    throw new Error(`PUZZLE_BQ_TABLE has invalid characters: ${table}`);
  }
  return t;
}

/**
 * Fetches BQ `rank` (1 = highest in top 25) and `score` for the given display terms
 * in `international_top_terms` (or override `PUZZLE_BQ_TABLE`) for a country, grouped
 * across regions (MIN rank, MAX score per term text).
 */
export async function rankTermsFromBigQuery(
  terms: string[],
  bqpRefreshDate: string,
): Promise<Map<string, { rank: number; score: number }>> {
  if (terms.length < 1) {
    return new Map();
  }
  const bq = await getBigQuery();
  const table = sanitizeTableId(
    String(process.env.PUZZLE_BQ_TABLE || "bigquery-public-data.google_trends.international_top_terms"),
  );
  const country = String(process.env.PUZZLE_BQ_COUNTRY || "US").trim();
  const jobLocation = String(process.env.PUZZLE_BQ_LOCATION || "US").trim();
  const regionName = String(process.env.PUZZLE_BQ_REGION_NAME || "").trim();

  const query = regionName
    ? `
    SELECT
      t.term,
      MIN(t.rank) AS rnk,
      MAX(t.score) AS scr
    FROM \`${table}\` AS t
    CROSS JOIN UNNEST(@terms) AS want
    WHERE t.refresh_date = @refreshDate
      AND t.country_code = @country
      AND t.region_name = @regionName
      AND LOWER(TRIM(t.term)) = LOWER(TRIM(want))
    GROUP BY t.term
  `
    : `
    SELECT
      t.term,
      MIN(t.rank) AS rnk,
      MAX(t.score) AS scr
    FROM \`${table}\` AS t
    CROSS JOIN UNNEST(@terms) AS want
    WHERE t.refresh_date = @refreshDate
      AND t.country_code = @country
      AND LOWER(TRIM(t.term)) = LOWER(TRIM(want))
    GROUP BY t.term
  `;

  const [rows] = await bq.query({
    query: query.replace(/\s+/g, " ").trim(),
    location: jobLocation,
    params: regionName
      ? { terms, refreshDate: bqpRefreshDate, country, regionName }
      : { terms, refreshDate: bqpRefreshDate, country },
  });

  const byLower = new Map<string, { rank: number; score: number; display: string }>();
  for (const row of rows as Row[]) {
    if (row?.term == null) continue;
    byLower.set(String(row.term).toLowerCase(), {
      display: String(row.term),
      rank: Number(row.rnk),
      score: row.scr == null ? 0 : Number(row.scr),
    });
  }

  const out = new Map<string, { rank: number; score: number }>();
  for (const want of terms) {
    const row = byLower.get(want.toLowerCase());
    if (!row) {
      throw new Error(
        `Term "${want}" is not in BigQuery for refresh_date=${bqpRefreshDate} country=${country} (and optional region). Use public top terms or adjust CANDIDATE/PUZZLE_BQ_* settings.`,
      );
    }
    out.set(want, { rank: row.rank, score: row.score });
  }
  return out;
}

export function bqRegionKeyLabel(): string {
  const c = String(process.env.PUZZLE_BQ_COUNTRY || "US").trim();
  const r = String(process.env.PUZZLE_BQ_REGION_NAME || "").trim();
  return r ? `${c}:${r}` : c;
}
