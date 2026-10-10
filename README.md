# @pipeworx/arkansas-opinions

Current Arkansas Supreme Court and Arkansas Court of Appeals opinions —
neutral citation, case name, decision date, docket, author, disposition, full
text and every published revision — from the Arkansas Judiciary's official
opinion archive at opinions.arcourts.gov, decisions from 2026-01-01 on,
collected hourly. Fleet #2924.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1765+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

It exists because CourtListener, the source behind the `court-listener` pack,
runs months behind the Arkansas courts: on 2026-10-10 its newest Arkansas
Supreme Court opinion was 2026 Ark. 114 (2026-06-11) while the court had
issued through 2026 Ark. 144 (2026-10-08). Older Arkansas case law stays with
`court-listener`; its `lookup_citation` now falls through to this pack for a
`YYYY Ark. N` / `YYYY Ark. App. N` citation CourtListener does not have.

## Tools

- `ark_recent_opinions(court?, since?, limit?, include_syllabi?)` — newest
  opinions first, for one court (`"supreme"`, `"appeals"`) or both, optionally
  since a date. Answers "what did the Arkansas Supreme Court decide this week".
- `ark_opinion(citation | item_id, version?, max_chars?)` — one opinion by
  neutral citation (`"2026 Ark. 140"`, `"2026 Ark. App. 449"`, spelling is
  forgiving) or archive item id: metadata, full text, citation status and the
  version history. `version` returns an earlier revision's text.
- `ark_search_opinions(query, court?, date_after?, date_before?, limit?)` —
  full-text search (SQLite FTS5, porter stemming) over case name, citation and
  opinion text, with a highlighted passage per hit. Quote a phrase for an exact
  match; when no opinion holds every word it retries with any word and says so
  (`matched: "any_term"`).
- `ark_coverage()` — per court: opinion count, earliest and latest decision,
  lowest/highest citation number per year, how many opinions were revised
  after release, when collection last succeeded and the state of the backfill.
  Call it before treating an absence as meaningful.

Every response carries `data_as_of` (when the collector last finished a
successful run) and a `source_url` on opinions.arcourts.gov.

### Versions

Slip opinions get editorial corrections after release, and the archive's RSS
feeds flag them ("Document updated on MM/DD/YYYY"). The collector re-reads a
flagged opinion; when its text or metadata hash differs from the current
version, the new text becomes the current version and the earlier one is kept.
`ark_opinion` lists every version with its retrieval time, SHA-256, length and
reason (`first_fetch`, `rss_updated`). A re-read that changes nothing adds no
version.

### Citation status

Recorded only from what the source states, on every opinion as
`citation_status` + `citation_status_note`:

- `neutral_citation_assigned` — the court assigned a neutral citation and the
  text carries no "not designated for publication" marker. Nothing more is
  claimed; the source does not state precedential status beyond that.
- `unpublished` — the text says it is not designated for publication. Treat it
  as citation-restricted and never as precedent.
- `no_citation_assigned` — a syllabus, order or notice with no citation.
- `not_yet_read` — listed by the court, text not read yet (usually within the
  hour); not to be cited until it is.

## Auth

Keyless for callers. The tools answer only through the Pipeworx gateway: the
opinions are read from a database the collector fills, and a standalone
`npm install` has no data, so every tool throws a clear "not bound in this
runtime" error there instead of returning an empty list.

## Data sources

- <https://opinions.arcourts.gov/ark/supremecourt/en/rss.do> and
  <https://opinions.arcourts.gov/ark/courtofappeals/en/rss.do> — the 100 most
  recently published or updated items per court, with the update markers.
  Read every hour.
- `https://opinions.arcourts.gov/ark/<court>/en/<year>/nav_date.do?iframe=true&page=N`
  — the per-year date listing, 25 items a page, used once for the 2026
  backfill.
- `https://opinions.arcourts.gov/ark/<court>/en/item/<id>/index.do?iframe=true`
  — one opinion: the metadata table (court, date, neutral citation, docket,
  author, opinion type, county, term, disposition, concurring/dissenting
  judges) and the text, which the site renders from the source PDF as
  positioned lines. The text is read from that HTML; the PDF itself
  (`.../<id>/1/document.do`) is linked as `pdf_url`.

Opinions of the Arkansas courts are government works and public domain.

Things the next person would otherwise rediscover the hard way:

- **The site is Lexum Decisia/Norma, and its bot wall ("robocop") is per
  source IP.** On 2026-10-10, with the same honest User-Agent
  (`Pipeworx/1.0 (+https://pipeworx.io; data@pipeworx.io)`), a laptop got
  HTTP 403 plus a captcha page on every content URL — item pages, listings,
  `document.do` — while a Cloudflare Worker got 200 on all of them. The RSS
  feeds answered both. That is why the collector is a Cloudflare Worker cron
  (`workers/ark-opinions-collector`) rather than a GitHub Actions job: a
  runner's IP is untested. The collector never solves a captcha and never
  changes identity; a captcha response stops the run and is recorded as
  `captcha_wall` in `ark_coverage().last_collection_attempt`.
- The outer pages (`.../index.do` without `?iframe=true`) are a shell around
  an iframe; all the content is in the `?iframe=true` variant.
- The RSS feeds also re-list century-old opinions when Lexum corrects them;
  those predate this pack's window and are skipped (counted as
  `feed_items_before_floor` in the run record).
- Each court also publishes a daily syllabus document and, for the Court of
  Appeals, "no opinion" notices. They are kept as `document_kind: "syllabus"`
  / `"no_opinion_notice"` and left out of `ark_recent_opinions` unless
  `include_syllabi: true`.
- Store: Cloudflare D1 database `pipeworx-ark-opinions`, bound to the gateway
  as `ARK_OPINIONS_DB` (`d1Binding` in pack-manifest.json). Schema:
  `workers/ark-opinions-collector/src/schema.ts`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "arkansas-opinions": {
      "url": "https://gateway.pipeworx.io/arkansas-opinions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/arkansas-opinions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1765+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ark_recent_opinions \
  -H 'Content-Type: application/json' \
  -d '{"court":"supreme","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ark_recent_opinions`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "arkansas-opinions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-arkansas-opinions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-arkansas-opinions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Arkansas Opinions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
