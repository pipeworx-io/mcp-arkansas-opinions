# @pipeworx/arkansas-opinions

Current Arkansas Supreme Court and Arkansas Court of Appeals opinions —
neutral citation, case name, decision date, docket, author, disposition, full
text and every published revision — from the Arkansas Judiciary's official
opinions archive, decisions from 2026-01-01 on, collected hourly. Fleet #2924.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1863+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

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

Every response carries `source` ("Arkansas Judiciary, official opinions
archive") and `data_as_of` (when the collector last finished a successful run).
Each opinion also carries `source_url`, the opinion's own page on the court's
site, so the text can be checked against the original.

### Versions

Slip opinions get editorial corrections after release, and the archive flags
them as updated. The collector re-reads a flagged opinion; when its text or metadata hash differs from the current
version, the new text becomes the current version and the earlier one is kept.
`ark_opinion` lists every version with its retrieval time, SHA-256, length and
reason (`first_fetch`, `source_updated`). A re-read that changes nothing adds no
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

- Arkansas Judiciary, official opinions archive — Arkansas Supreme Court and
  Court of Appeals opinions with their metadata (court, date, neutral
  citation, docket, author, opinion type, county, term, disposition,
  concurring and dissenting judges) and full text. Checked hourly; decisions
  from 2026-01-01 on.

Opinions of the Arkansas courts are government works and public domain.

Notes for the next person:

- The archive applies a bot check that varies by source IP. The same honest
  User-Agent was challenged from a laptop and answered from Cloudflare's
  network on 2026-10-10, which is why the collector runs as a Cloudflare
  Worker cron. It never solves a challenge and never changes identity; a
  challenge stops the run and shows as `captcha_wall` in
  `ark_coverage().last_collection_attempt`. How the collector reads the
  archive is documented in `workers/ark-opinions-collector`.
- Opinions decided before 2026-01-01 that the archive re-releases are left to
  `court-listener`.
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

Both URLs reach the same gateway and the same 1863+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ark_recent_opinions \
  -H 'Content-Type: application/json' \
  -d '{"court":"supreme","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ark_recent_opinions`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-arkansas-opinions` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/arkansas-opinions/mcp` endpoint shown above. It needs network access;
there is no offline mode.

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

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

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
