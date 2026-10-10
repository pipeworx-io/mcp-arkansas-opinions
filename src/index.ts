interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * arkansas-opinions — current Arkansas Supreme Court and Court of Appeals
 * opinions, from the Arkansas Judiciary's official opinion archive
 * (opinions.arcourts.gov, run on Lexum Decisia). Fleet #2924.
 *
 * Why this pack exists: the court-listener pack's case-law corpus comes from
 * CourtListener, which itself lags the Arkansas courts by months (its newest
 * Arkansas Supreme Court opinion was 2026 Ark. 114 of 2026-06-11 when this was
 * built, while the court had published through 2026 Ark. 144 of 2026-10-08).
 * This pack covers decisions from 2026-01-01 on, read from the court's own
 * archive every hour, so the gap is closed with margin. Older Arkansas case
 * law is court-listener's job, and lookup_citation there falls through to
 * this pack for a "YYYY Ark." / "YYYY Ark. App." neutral citation it lacks.
 *
 * Every response carries `data_as_of` (when the collector last finished a
 * successful run) and a `source_url` on the official archive.
 *
 * Versions: slip opinions get editorial corrections after release. When the
 * archive republishes an opinion with changed text, the new text becomes the
 * current version and every earlier one is kept, each with its retrieval time
 * and SHA-256; ark_opinion lists them and can return any of them.
 *
 * Citation status is recorded only from what the source states; see
 * citation_status / citation_status_note on every opinion.
 */
import {
  type Court,
  type D1Like,
  type OpinionRow,
  ARCHIVE,
  FEEDS,
  SOURCE,
  WINDOW_FROM,
  coverage,
  dataAsOf,
  findByCitation,
  findByItem,
  ftsQuery,
  parseNeutralCitation,
  recentOpinions,
  requireDb,
  searchOpinions,
  shapeOpinion,
  versionText,
  versionsOf,
} from './store.js';

export { parseNeutralCitation } from './store.js';


const tools: McpToolExport['tools'] = [
  {
    name: 'ark_recent_opinions',
    description:
      'Newest Arkansas Supreme Court and Arkansas Court of Appeals opinions, newest first, read from the Arkansas Judiciary\'s official opinion archive (opinions.arcourts.gov) every hour. Returns each decision\'s neutral citation (e.g. "2026 Ark. 140", "2026 Ark. App. 449"), case name, decision date, docket number, authoring judge, opinion type, disposition and an official source URL. Use for "what did the Arkansas Supreme Court decide this week", "latest Arkansas Court of Appeals opinions", or recent Arkansas appellate decisions since a date. Covers decisions from 2026-01-01 on.',
    summary: 'Latest Arkansas Supreme Court / Court of Appeals opinions from the official archive.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        court: { type: 'string', enum: ['supreme', 'appeals'], description: '"supreme" (Arkansas Supreme Court) or "appeals" (Arkansas Court of Appeals). Omit for both.' },
        since: { type: 'string', description: 'Only decisions on or after this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Maximum opinions to return (1-100, default 20).' },
        include_syllabi: { type: 'boolean', description: 'Also list the courts\' daily syllabus documents and no-opinion notices (default false).' },
      },
    },
  },
  {
    name: 'ark_opinion',
    description:
      'Read one Arkansas Supreme Court or Court of Appeals opinion by its neutral citation ("2026 Ark. 140", "2026 Ark. App. 449") or archive item id: case name, decision date, docket, author, disposition, the full opinion text, its citation status, and its version history (every editorial revision the court published, each with retrieval time and SHA-256). From the Arkansas Judiciary\'s official opinion archive, decisions from 2026-01-01 on. For older Arkansas citations use court-listener lookup_citation.',
    summary: 'Text, metadata and version history of one Arkansas appellate opinion by neutral citation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: { type: 'string', description: 'Arkansas neutral citation, e.g. "2026 Ark. 140" or "2026 Ark. App. 449".' },
        item_id: { type: 'number', description: 'Archive item id (from ark_recent_opinions or ark_search_opinions), used when there is no citation.' },
        version: { type: 'number', description: 'Return this earlier version\'s text instead of the current one (see versions[]).' },
        max_chars: { type: 'number', description: 'Truncate the returned text to this many characters (default 40000, max 200000).' },
      },
    },
  },
  {
    name: 'ark_search_opinions',
    description:
      'Full-text search of recent Arkansas Supreme Court and Court of Appeals opinions (decisions from 2026-01-01 on, from the Arkansas Judiciary\'s official archive) by subject, party or phrase — "parole eligibility", "termination of parental rights", "Walmart". Filter by court and decision date. Returns matching opinions with neutral citation, case name, date, a highlighted passage and the official source URL; read the whole opinion with ark_opinion. Use quotes for an exact phrase.',
    summary: 'Full-text search over recent Arkansas appellate opinions, filterable by court and date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Words or a "quoted phrase" to find in the opinion text, case name or citation.' },
        court: { type: 'string', enum: ['supreme', 'appeals'], description: '"supreme" or "appeals". Omit for both.' },
        date_after: { type: 'string', description: 'Only decisions on or after this date, YYYY-MM-DD.' },
        date_before: { type: 'string', description: 'Only decisions on or before this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Maximum results (1-50, default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ark_coverage',
    description:
      'What Arkansas appellate opinions this pack can answer from: per court (Supreme Court, Court of Appeals) the number of opinions, the earliest and latest decision date, the highest neutral citation number per year, how many opinions were revised after release, and when the hourly collection from the official archive (opinions.arcourts.gov) last succeeded. Use before relying on an absence ("is 2026 Ark. 150 out yet?").',
    summary: 'Date range, counts per court and last successful collection for arkansas-opinions.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function courtArg(v: unknown): Court | undefined {
  if (v == null || v === '' || v === 'both' || v === 'all') return undefined;
  const s = String(v).toLowerCase();
  if (s.startsWith('sup')) return 'supreme';
  if (s.startsWith('app') || s === 'coa' || s.includes('appeal')) return 'appeals';
  throw new Error(`court must be "supreme" or "appeals" (got ${JSON.stringify(v)})`);
}
function dateArg(v: unknown, name: string): string | undefined {
  if (v == null || v === '') return undefined;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${name} must be a date as YYYY-MM-DD (got ${JSON.stringify(v)})`);
  return s;
}
function clamp(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}

async function recentTool(db: D1Like, args: Record<string, unknown>) {
  const court = courtArg(args.court);
  const since = dateArg(args.since, 'since');
  const limit = clamp(args.limit, 1, 100, 20);
  const [rows, asOf] = await Promise.all([
    recentOpinions(db, { court, since, limit, includeOther: args.include_syllabi === true }),
    dataAsOf(db),
  ]);
  return {
    court: court ? court : 'both',
    since: since ?? null,
    returned: rows.length,
    opinions: rows.map(shapeOpinion),
    ...(rows.length === 0
      ? {
          found: false,
          reason: since && since < WINDOW_FROM ? 'before_window' : 'none_in_range',
          hint:
            since && since < WINDOW_FROM
              ? `This pack covers decisions from ${WINDOW_FROM}. For earlier Arkansas opinions use court-listener search_case_law or find_case.`
              : 'No opinion in this range has been published by the court yet. ark_coverage shows the latest decision held and when collection last ran.',
        }
      : {}),
    data_as_of: asOf,
    source_url: court ? FEEDS[court] : `${ARCHIVE}/ark/en/nav.do`,
    source: SOURCE,
  };
}

const DEFAULT_MAX_CHARS = 40_000;

/** The opinion + its version history + text. Also used by court-listener's
 *  lookup_citation fall-through (with a shorter excerpt). */
export async function opinionPayload(
  db: D1Like,
  row: OpinionRow,
  opts: { version?: number; maxChars?: number } = {},
) {
  const [versions, asOf] = await Promise.all([versionsOf(db, row.item_id), dataAsOf(db)]);
  const wanted = opts.version ?? row.current_version ?? null;
  const text = wanted != null ? await versionText(db, row.item_id, wanted) : null;
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  return {
    found: true,
    opinion: shapeOpinion(row),
    version: wanted,
    is_current_version: wanted != null && wanted === row.current_version,
    text: text == null ? null : text.slice(0, max),
    chars: text?.length ?? 0,
    text_truncated: text != null && text.length > max,
    ...(text == null
      ? {
          text_status: opts.version != null ? 'no_such_version' : 'awaiting_fetch',
          text_note:
            opts.version != null
              ? `Version ${opts.version} does not exist for this opinion; see versions[].`
              : 'The court has listed this opinion and the collector has not read its text yet; it is read within a few hours. The metadata and source_url are already correct.',
        }
      : {}),
    versions: versions.map((v) => ({
      version: v.version,
      retrieved_at: v.retrieved_at,
      sha256: v.sha256,
      chars: v.chars,
      reason: v.trigger,
      is_current: v.is_current === 1,
    })),
    data_as_of: asOf,
    source_url: row.source_url,
    pdf_url: row.pdf_url,
    source: SOURCE,
  };
}

/**
 * Resolve an Arkansas neutral citation for court-listener's lookup_citation.
 * Returns null when this pack holds nothing for it, so the caller can carry on
 * with its own answer.
 */
export async function lookupArkNeutralCitation(d1: unknown, citation: string, maxChars = 3000) {
  const c = parseNeutralCitation(citation);
  if (!c || !d1 || typeof (d1 as D1Like).prepare !== 'function') return null;
  const db = d1 as D1Like;
  const rows = await findByCitation(db, c);
  if (!rows.length) return null;
  const body = await opinionPayload(db, rows[0], { maxChars });
  return { ...body, citation: c.citation, other_items_with_this_citation: rows.slice(1).map(shapeOpinion) };
}

async function opinionTool(db: D1Like, args: Record<string, unknown>) {
  const maxChars = clamp(args.max_chars, 500, 200_000, DEFAULT_MAX_CHARS);
  const version = args.version != null && args.version !== '' ? clamp(args.version, 1, 10_000, 1) : undefined;
  if (args.item_id != null && args.item_id !== '') {
    const id = Number(args.item_id);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`item_id must be a positive integer (got ${JSON.stringify(args.item_id)})`);
    const row = await findByItem(db, id);
    if (!row) {
      return {
        found: false,
        reason: 'not_held',
        item_id: id,
        message: `No item ${id} is held.`,
        hint: 'Item ids come from ark_recent_opinions or ark_search_opinions. ark_coverage shows the window held.',
        data_as_of: await dataAsOf(db),
        source_url: `${ARCHIVE}/ark/en/nav.do`,
      };
    }
    return opinionPayload(db, row, { version, maxChars });
  }
  const c = parseNeutralCitation(args.citation);
  if (!c) {
    return {
      found: false,
      reason: 'unparsed_citation',
      message: `${JSON.stringify(args.citation ?? null)} is not an Arkansas neutral citation. The shape is year, reporter, number: "2026 Ark. 140" (Supreme Court) or "2026 Ark. App. 449" (Court of Appeals).`,
      hint: 'Pass citation or item_id. For a reporter citation such as "371 Ark. 1" or "105 S.W.3d 1", use court-listener lookup_citation.',
    };
  }
  const rows = await findByCitation(db, c);
  const asOf = await dataAsOf(db);
  if (!rows.length) {
    const before = c.year < Number(WINDOW_FROM.slice(0, 4));
    return {
      found: false,
      reason: before ? 'before_window' : 'not_held',
      citation: c.citation,
      message: before
        ? `${c.citation} was decided before ${WINDOW_FROM}, which is where this pack starts.`
        : `${c.citation} is not among the opinions collected from the official archive as of ${asOf ?? 'the last collection'}.`,
      hint: before
        ? 'Use court-listener lookup_citation for older Arkansas opinions.'
        : 'If the number is past the latest one in ark_coverage, the court may not have issued it yet; absence here is not proof the citation is wrong.',
      data_as_of: asOf,
      source_url: FEEDS[c.reporter === 'Ark.' ? 'supreme' : 'appeals'],
    };
  }
  const body = await opinionPayload(db, rows[0], { version, maxChars });
  return {
    ...body,
    citation: c.citation,
    ...(rows.length > 1 ? { other_items_with_this_citation: rows.slice(1).map(shapeOpinion) } : {}),
  };
}

async function searchTool(db: D1Like, args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) throw new Error('query is required');
  const court = courtArg(args.court);
  const after = dateArg(args.date_after, 'date_after');
  const before = dateArg(args.date_before, 'date_before');
  const limit = clamp(args.limit, 1, 50, 10);
  const all = ftsQuery(q, 'all');
  if (!all) throw new Error(`query ${JSON.stringify(q)} has no searchable words`);
  let rows = await searchOpinions(db, { match: all, court, after, before, limit });
  let matched: 'all_terms' | 'any_term' = 'all_terms';
  const any = ftsQuery(q, 'any');
  if (!rows.length && any !== all) {
    rows = await searchOpinions(db, { match: any, court, after, before, limit });
    matched = 'any_term';
  }
  const asOf = await dataAsOf(db);
  return {
    query: q,
    court: court ?? 'both',
    date_after: after ?? null,
    date_before: before ?? null,
    matched,
    ...(matched === 'any_term' && rows.length
      ? { note: 'No opinion contained every term, so these match at least one. Check each passage before relying on it.' }
      : {}),
    returned: rows.length,
    results: rows.map((r) => ({ ...shapeOpinion(r), passage: r.snippet })),
    ...(rows.length === 0
      ? {
          found: false,
          reason: 'no_match',
          hint: `Nothing matched among opinions decided from ${WINDOW_FROM}. For older Arkansas case law use court-listener search_case_law.`,
        }
      : {}),
    data_as_of: asOf,
    source_url: `${ARCHIVE}/ark/en/nav.do`,
    source: SOURCE,
  };
}

async function coverageTool(db: D1Like) {
  const c = await coverage(db);
  const lastOk = c.lastOk;
  const lastAny = c.lastAny;
  return {
    window_from: WINDOW_FROM,
    courts: c.perCourt.map((p) => ({
      court: p.court === 'supreme' ? 'Arkansas Supreme Court' : 'Arkansas Court of Appeals',
      court_id: p.court,
      opinions: p.opinions,
      opinions_with_text: p.opinions_with_text,
      other_documents: p.items - p.opinions,
      awaiting_text_fetch: p.awaiting_fetch,
      earliest_decision: p.earliest_decision,
      latest_decision: p.latest_decision,
      citation_numbers: c.latestCites
        .filter((x) => x.court === p.court)
        .map((x) => ({ year: x.cite_year, lowest: x.min_number, highest: x.max_number })),
      feed_url: FEEDS[p.court],
    })),
    versions: {
      stored: c.versions?.versions ?? 0,
      opinions_revised_after_release: c.versions?.revised ?? 0,
    },
    last_successful_collection: lastOk
      ? {
          finished_at: lastOk.finished_at,
          feed_items_read: lastOk.feed_items,
          new_items: lastOk.enqueued_new,
          updated_items: lastOk.enqueued_updated,
          opinions_read: lastOk.fetched,
          new_versions: lastOk.new_versions,
        }
      : null,
    last_collection_attempt: lastAny
      ? { started_at: lastAny.started_at, finished_at: lastAny.finished_at, ok: lastAny.ok === 1, error: lastAny.error_detail ?? null }
      : null,
    backfill: c.backfill.map((b) => ({ listing: b.key.replace(/^backfill:/, ''), state: b.value === 'done' ? 'done' : `next page ${b.value}`, updated_at: b.updated_at })),
    data_as_of: lastOk?.finished_at ?? null,
    source_url: `${ARCHIVE}/ark/en/rss/index.do`,
    source: SOURCE,
    note: `Collected hourly from the court's own RSS feeds and date listings, from ${WINDOW_FROM}. Earlier Arkansas opinions are in court-listener.`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const db = requireDb(args._d1);
  switch (name) {
    case 'ark_recent_opinions':
      return recentTool(db, args);
    case 'ark_opinion':
      return opinionTool(db, args);
    case 'ark_search_opinions':
      return searchTool(db, args);
    case 'ark_coverage':
      return coverageTool(db);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
