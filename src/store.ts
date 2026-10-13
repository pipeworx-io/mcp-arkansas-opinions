/**
 * Reads for arkansas-opinions (fleet #2924).
 *
 * The opinions come from the Arkansas Judiciary's official opinions archive.
 * A scheduled collector (workers/ark-opinions-collector) checks that archive
 * every hour, reads each new or updated opinion, and writes it with every text
 * version into a D1 database that the gateway hands this pack as `_d1`
 * (pack-manifest "d1Binding": "ARK_OPINIONS_DB"). The table and column names
 * here must match workers/ark-opinions-collector/src/schema.ts.
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

// Provenance is publisher + dataset + data_as_of (CLAUDE.md step 9b, fleet
// #2939). Each opinion still carries its own public page as source_url: that
// is the record a lawyer checks, not a route. Feed and listing routes stay in
// the collector.
export const SOURCE = 'Arkansas Judiciary, official opinions archive';
export const WINDOW_FROM = '2026-01-01';

export type Court = 'supreme' | 'appeals';
export const COURT_NAMES: Record<Court, string> = {
  supreme: 'Arkansas Supreme Court',
  appeals: 'Arkansas Court of Appeals',
};

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'arkansas-opinions: the opinion store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export interface NeutralCite {
  year: number;
  reporter: 'Ark.' | 'Ark. App.';
  number: number;
  citation: string;
}
/** "2026 Ark. 140", "2026 Ark App 449", "2026 ark. app. 449" -> parts. */
export function parseNeutralCitation(s: unknown): NeutralCite | null {
  const m = /\b((?:19|20)\d{2})\s+Ark\.?\s*(App\.?)?\s+(\d{1,4})\b/i.exec(String(s ?? ''));
  if (!m) return null;
  const reporter = m[2] ? 'Ark. App.' : 'Ark.';
  return { year: Number(m[1]), reporter, number: Number(m[3]), citation: `${m[1]} ${reporter} ${Number(m[3])}` };
}

export interface OpinionRow {
  item_id: number;
  court: Court;
  title: string;
  citation: string | null;
  decision_date: string | null;
  docket: string | null;
  author: string | null;
  opinion_type: string | null;
  county: string | null;
  term: string | null;
  disposition: string | null;
  metadata_json: string | null;
  doc_kind: string;
  citation_status: string | null;
  citation_status_note: string | null;
  source_url: string;
  pdf_url: string | null;
  first_seen: string;
  last_checked: string | null;
  current_version: number | null;
  needs_fetch: number;
}

const OPINION_COLS = `item_id, court, title, citation, decision_date, docket, author, opinion_type, county, term,
  disposition, metadata_json, doc_kind, citation_status, citation_status_note, source_url, pdf_url, first_seen,
  last_checked, current_version, needs_fetch`;

/** When the collector last finished a successful run: the honest "as of". */
export async function dataAsOf(db: D1Like): Promise<string | null> {
  const r = await db
    .prepare(`SELECT max(finished_at) AS t FROM collector_runs WHERE ok = 1`)
    .first<{ t: string | null }>();
  return r?.t ?? null;
}

export function shapeOpinion(r: OpinionRow) {
  let extra: Record<string, string> = {};
  try {
    extra = r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, string>) : {};
  } catch {
    extra = {};
  }
  const judges: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (/opinion$|judge|justice/i.test(k) && k !== 'Opinion Type') judges[k] = v;
  }
  return {
    citation: r.citation,
    case_name: r.title,
    court: COURT_NAMES[r.court] ?? r.court,
    decision_date: r.decision_date,
    docket_number: r.docket,
    author: r.author,
    opinion_type: r.opinion_type,
    disposition: r.disposition,
    county: r.county,
    term: r.term,
    ...(Object.keys(judges).length ? { other_opinions: judges } : {}),
    document_kind: r.doc_kind,
    citation_status: r.citation_status ?? 'not_yet_read',
    citation_status_note:
      r.citation_status_note ??
      'The text of this item has not been read yet, so its citation status is unknown. Do not treat it as citable until it is.',
    item_id: r.item_id,
    source_url: r.source_url,
    text_held: r.current_version != null,
    version: r.current_version,
    last_checked: r.last_checked,
  };
}

export async function recentOpinions(
  db: D1Like,
  opts: { court?: Court; since?: string; limit: number; includeOther: boolean },
) {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.court) {
    where.push('court = ?');
    vals.push(opts.court);
  }
  if (opts.since) {
    where.push('decision_date >= ?');
    vals.push(opts.since);
  }
  if (!opts.includeOther) where.push(`doc_kind = 'opinion'`);
  const sql = `SELECT ${OPINION_COLS} FROM opinions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY decision_date DESC, cite_number DESC, item_id DESC LIMIT ?`;
  const r = await db.prepare(sql).bind(...vals, opts.limit).all<OpinionRow>();
  return r.results;
}

export async function findByCitation(db: D1Like, c: NeutralCite): Promise<OpinionRow[]> {
  const r = await db
    .prepare(
      `SELECT ${OPINION_COLS} FROM opinions WHERE cite_year = ? AND cite_reporter = ? AND cite_number = ?
       ORDER BY (doc_kind = 'opinion') DESC, item_id`,
    )
    .bind(c.year, c.reporter, c.number)
    .all<OpinionRow>();
  return r.results;
}

export async function findByItem(db: D1Like, itemId: number): Promise<OpinionRow | null> {
  return db.prepare(`SELECT ${OPINION_COLS} FROM opinions WHERE item_id = ?`).bind(itemId).first<OpinionRow>();
}

export interface VersionRow {
  version: number;
  retrieved_at: string;
  trigger: string | null;
  sha256: string;
  chars: number;
  is_current: number;
  source_doc_url: string | null;
}
export async function versionsOf(db: D1Like, itemId: number): Promise<VersionRow[]> {
  const r = await db
    .prepare(
      `SELECT version, retrieved_at, trigger, sha256, chars, is_current, source_doc_url
       FROM opinion_versions WHERE item_id = ? ORDER BY version`,
    )
    .bind(itemId)
    .all<VersionRow>();
  return r.results;
}
export async function versionText(db: D1Like, itemId: number, version: number): Promise<string | null> {
  const r = await db
    .prepare(`SELECT text FROM opinion_versions WHERE item_id = ? AND version = ?`)
    .bind(itemId, version)
    .first<{ text: string }>();
  return r?.text ?? null;
}

/** Turn free text into a safe FTS5 query: quoted phrases stay phrases, every
 *  other word becomes a quoted term, and FTS5 operators in the input are inert. */
export function ftsQuery(q: string, mode: 'all' | 'any' = 'all'): string {
  const parts: string[] = [];
  const re = /"([^"]+)"|([^\s"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const raw = (m[1] ?? m[2]).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    if (!m[1] && /^(AND|OR|NOT|NEAR)$/i.test(raw)) continue;
    parts.push(`"${raw.replace(/"/g, '')}"`);
  }
  return parts.join(mode === 'all' ? ' ' : ' OR ');
}

export interface SearchRow extends OpinionRow {
  snippet: string;
  rank: number;
}
export async function searchOpinions(
  db: D1Like,
  opts: { match: string; court?: Court; after?: string; before?: string; limit: number },
): Promise<SearchRow[]> {
  const where = ['opinion_fts MATCH ?'];
  const vals: unknown[] = [opts.match];
  if (opts.court) {
    where.push('o.court = ?');
    vals.push(opts.court);
  }
  if (opts.after) {
    where.push('o.decision_date >= ?');
    vals.push(opts.after);
  }
  if (opts.before) {
    where.push('o.decision_date <= ?');
    vals.push(opts.before);
  }
  const cols = OPINION_COLS.split(',').map((c) => `o.${c.trim()}`).join(', ');
  const sql = `SELECT ${cols}, snippet(opinion_fts, 2, '[', ']', ' … ', 28) AS snippet, bm25(opinion_fts) AS rank
    FROM opinion_fts JOIN opinions o ON o.item_id = opinion_fts.rowid
    WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`;
  const r = await db.prepare(sql).bind(...vals, opts.limit).all<SearchRow>();
  return r.results;
}

export async function coverage(db: D1Like) {
  const perCourt = await db
    .prepare(
      `SELECT court,
         count(*) AS items,
         sum(CASE WHEN doc_kind = 'opinion' THEN 1 ELSE 0 END) AS opinions,
         sum(CASE WHEN doc_kind = 'opinion' AND current_version IS NOT NULL THEN 1 ELSE 0 END) AS opinions_with_text,
         sum(CASE WHEN needs_fetch = 1 THEN 1 ELSE 0 END) AS awaiting_fetch,
         min(CASE WHEN doc_kind = 'opinion' THEN decision_date END) AS earliest_decision,
         max(CASE WHEN doc_kind = 'opinion' THEN decision_date END) AS latest_decision
       FROM opinions GROUP BY court ORDER BY court DESC`,
    )
    .all<{
      court: Court; items: number; opinions: number; opinions_with_text: number; awaiting_fetch: number;
      earliest_decision: string | null; latest_decision: string | null;
    }>();
  const latestCites = await db
    .prepare(
      `SELECT court, cite_year, max(cite_number) AS max_number, min(cite_number) AS min_number
       FROM opinions WHERE cite_number IS NOT NULL GROUP BY court, cite_year ORDER BY cite_year DESC`,
    )
    .all<{ court: Court; cite_year: number; max_number: number; min_number: number }>();
  const versions = await db
    .prepare(`SELECT count(*) AS versions, count(DISTINCT item_id) AS items, sum(CASE WHEN version > 1 THEN 1 ELSE 0 END) AS revised FROM opinion_versions`)
    .first<{ versions: number; items: number; revised: number }>();
  const lastOk = await db
    .prepare(`SELECT * FROM collector_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1`)
    .first<Record<string, unknown>>();
  const lastAny = await db
    .prepare(`SELECT id, started_at, finished_at, ok, error_detail FROM collector_runs ORDER BY id DESC LIMIT 1`)
    .first<Record<string, unknown>>();
  const backfill = await db.prepare(`SELECT key, value, updated_at FROM collector_state ORDER BY key`).all<{ key: string; value: string; updated_at: string }>();
  return { perCourt: perCourt.results, latestCites: latestCites.results, versions, lastOk, lastAny, backfill: backfill.results };
}
