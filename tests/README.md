# Tests

These ran the real extension in headless Chrome against HTTPS replicas of Gmail, Amazon, Flipkart, YouTube, Hacker News,
DuckDuckGo, Wikipedia, ChatGPT and Claude (`sites.mjs`), a scripted mock of Meta's API, and the library running under `wrangler dev`.

| Script | Checks |
|---|---|
| `flows-test.py` | 38 checks: inspect_page on each site, saving with test runs, nested flows, AI steps, safety blocks, sharing with the confirm card, library search and publish, the agent using and writing flows |
| `mcp-test.py` | 46 checks: 14 flows incl. composites (price-compare, topic-briefing, morning-digest), per-site flows in the agent's context, the MCP server via the official SDK client (owner + relay, list_changed), HTTP endpoint, pairing-code and origin checks, and Claude Code itself using the flows |
| `feat-test.py` | 29 checks: quick actions in 2 agent calls (ask Claude via its flow), memory in ask / auto / off modes and refusing secrets, spotting common tasks and the "Make it a flow" button, views with 4 sections that refresh, and flow alerts |
| `harness/real-agent.js` | replays the agent's first request to the real Muse Spark with canned tool results, to count calls and time for quick actions, memory and views |
| `harness/harness.js` | in-page harness used with the real Muse Spark on real amazon.in / YouTube (Spark writing, testing and reusing flows) |
| `library/test-api.mjs` | the library API (publish, validation, search, report, delete) |

They were written for a scratch environment: paths point at `/tmp/claude-0/va9run`, the mock server (`mock/mock4.mts`, `mock/mock5.mts`)
imports the Voice Agent monorepo's `packages/meta-client/mock/server.ts`, and the HTTPS replicas need a self-signed
`cert.pem`/`key.pem` (not included; `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj /CN=localhost`).
