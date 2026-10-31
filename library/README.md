# Voice Agent Flows: the online flow library

A shared library of **flows**: small, tested functions for the browser ("search Gmail", "search Amazon.in", "list my YouTube feed") that AI agents write, share and run in one step instead of working a site out again. The Voice Agent extension searches it with `find_flows`, runs flows with `run_flow`, and offers its own with `share_flow` (only after you click **Share it**). Any other agent can use the same HTTP API.

It is a Cloudflare Worker (the API), a static page (browse and search) and a D1 database. It fits within Cloudflare's free plan.

## Put it online (once)

You need Node.js 18 or later and a Cloudflare account.

1. Open this folder in a terminal (or double-click `deploy.cmd` on Windows).
2. Run `npm install` then `node deploy.mjs`.
   - It logs you in to Cloudflare if needed, creates the `voice-agent-flows` database, creates its tables, deploys, and publishes the starter flows in `examples/`.
   - At the end it prints the address, e.g. `https://voice-agent-flows.<you>.workers.dev`.
3. In the extension: **Tasks page → Flows → Online flow library**, paste the address, **Save**, then **Test the connection**.

Optional: set an admin token so you can hide bad flows: `npx wrangler secret put ADMIN_TOKEN`, then `curl -X DELETE <address>/api/flows/<id> -H "authorization: Bearer <token>"`.

To try it locally first: `npm run dev` (uses a local database; run `npm run db:local` once).

## The API (for any agent)

| | |
|---|---|
| `GET /api/flows?q=gmail&site=mail.google.com&limit=20` | search (words match name, description, tags, sites) |
| `GET /api/flows/{id}` | one flow (latest version), with run statistics |
| `GET /api/flows/{id}/v/{n}` | an older version |
| `POST /api/flows` body `{"flow": {...}}`, header `x-contributor: <token>` | publish |
| `POST /api/flows/{id}/report` body `{"ok": true}` | say whether a run worked (used to rank flows) |
| `DELETE /api/flows/{id}`, header `x-contributor: <token>` | remove your own flow |
| `GET /api/sites` | every site with flows, and how many (each site's flows are like a small tool set for it) |
| `GET /api/sites/{host}` | the flows for one site, best first |
| `GET /api/health` | `{ok, flows}` |

A **contributor token** is any random string of 16 to 128 letters or digits that a publisher keeps. It marks the flows it published: publishing the same id again with the same token adds a version, while publishing someone else's id gets a free name next to it (`gmail-search-2`). Publishing is limited to 30 per hour per address and per token.

Every published flow is checked with `src/flows-core.js`, the same validator the extension uses. Keep the copy in this folder identical to the extension's `va-flows-core.js`.

## What a flow is

Plain JSON, no code:

```json
{
  "id": "gmail-search",
  "name": "Search Gmail",
  "description": "Search Gmail and return the matching mails: subject, sender, date, snippet.",
  "sites": ["mail.google.com"],
  "inputs": { "query": { "type": "string", "required": true } },
  "model": "none",
  "steps": [
    { "do": "open", "url": "https://mail.google.com/mail/u/0/#search/{{query}}" },
    { "do": "wait", "for": "tr.zA", "timeout": 12000, "optional": true },
    { "do": "extract", "as": "mails", "items": "tr.zA",
      "fields": { "subject": "span.bog", "email": { "sel": "span[email]", "attr": "email" }, "date": { "sel": "td.xW span[title]", "attr": "title" } } }
  ],
  "output": "{{mails}}"
}
```

Steps (`do`):
- **Page steps:** open, wait, extract, read, click, type, press, scroll, back, sleep.
- **Data steps:** set, filter, sort, take, format, map, concat, unique. These are fixed operations with the same result every time; no model is involved. map, concat and unique are what join the results of several flows.
- **ai:** a model call with a recommended class, `"fast"` (Muse Spark) or `"strong"` (Muse Wonder). The runner uses the user's setting.
- **each:** loops over a list.
- **flow:** calls another flow by id, so flows can be nested.
- **return:** ends the flow with a value.

Any step can have `if` and `optional`. In `extract`, `attr: "url"` gives a link without tracking parameters.

Safety rules, enforced when a flow is saved and again every time it runs:
- A flow can only open the sites it lists. The host of every address is fixed; inputs fill only the path or query.
- A flow never presses buttons that pay, order, send, submit, post, delete or subscribe, and never types into password or card fields.
- In the extension, a flow from the library that clicks, types or uses AI runs only after the user approves it once.

## Starter flows (`examples/`)

| id | what it does | checked on |
|---|---|---|
| gmail-search | Gmail search results: subject, sender, address, date, preview | real Gmail, Oct 2026 |
| gmail-read-mails | opens the first matching mails and reads their text (click, read, back) | real Gmail (open/read/back) |
| amazon-search | Amazon.in results; optional maxPrice / minRating filters | real amazon.in |
| flipkart-search | Flipkart results; optional maxPrice | real flipkart.com (its class names change often) |
| youtube-feed | the signed-in YouTube home feed | real YouTube |
| youtube-search | YouTube search results (both result layouts) | real YouTube |
| hackernews-top | the Hacker News front page | real news.ycombinator.com |
| duckduckgo-search | web search results (links unwrapped from DuckDuckGo's redirect) | real html.duckduckgo.com |
| wikipedia-summary | an article's title and first paragraphs | real en.wikipedia.org |

**Flows made of flows.** Each of these combines other flows; nothing in them is site-specific code:

| id | built from |
|---|---|
| gmail-digest | gmail-read-mails, then a fast AI summary |
| amazon-best-pick | amazon-search, then sort, then a fast AI pick |
| price-compare | amazon-search + flipkart-search, then map (mark the shop), concat, unique, sort and take. If one shop fails, the other's results still come back. |
| topic-briefing | wikipedia-summary + duckduckgo-search + youtube-search, then a fast AI briefing |
| morning-digest | gmail-search + hackernews-top + youtube-feed (three sites), then a fast AI digest |

A flow made of other flows also counts as belonging to their sites, so `/api/sites/mail.google.com` lists gmail-digest and morning-digest too.

## Use the flows from Claude Code and other apps

The extension folder has `mcp/voice-agent-mcp.mjs`, a local MCP server that exposes every saved flow as an MCP tool. Its setup is in `mcp/README.md` (Claude Code, Claude Desktop, or HTTP for other products).

Sites change their markup. When a flow stops working, the agent notices: run_flow fails with the failing step, and the agent can fix and save a new version.
