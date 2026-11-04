# Voice Agent flows

A voice-driven browser agent (Edge/Chrome extension) that turns repeatable browser jobs into **flows**. A flow is a small, tested function such as "search Gmail", "compare prices on Amazon and Flipkart" or "my morning digest". Once saved, a flow runs in one step instead of the agent working the site out again. Flows can be shared through an online library, and Claude Code and other MCP apps can use them.

| Folder | What |
|---|---|
| `extension/` | The extension, ready to load unpacked (Nanobrowser fork plus the Voice Agent add-ons) |
| `extension/mcp/` | `voice-agent-mcp.mjs`, a local MCP server that exposes every saved flow as a tool to Claude Code, Claude Desktop or any MCP app |
| `library/` | The online flow library: a Cloudflare Worker with a D1 database, a browse page and 16 starter flows |
| `src/` | How `extension/background.js` is built from the add-on files |
| `tests/` | End-to-end tests (real extension, site replicas, MCP SDK client, Claude Code) |

## Quick start

1. **Load the extension:** go to `edge://extensions` (or `chrome://extensions`), turn on Developer mode, choose **Load unpacked** and pick `extension/`. Add your Meta API key in its settings.
2. **Put the library online (optional):** `cd library && npm install && node deploy.mjs`. Then paste the printed address into the Tasks page under **Flows → Online flow library**.
3. **Use the flows from Claude Code (optional):**
   - Run `node extension/mcp/voice-agent-mcp.mjs --pairing-code`.
   - Paste the code into the Tasks page under **Apps on this computer (MCP)**.
   - Run `claude mcp add voice-agent -- node <path>/extension/mcp/voice-agent-mcp.mjs`.

## Flows

Plain JSON, no code:
- **Page steps:** open, wait, extract, read, click, type, press, scroll, back.
- **Data steps** (fixed rules, no model): set, filter, sort, take, format, map, concat, unique.
- **ai:** a model call with a recommended class, fast (Muse Spark) or strong (Muse Wonder).
- **each:** a loop over a list.
- **flow:** calls another flow, so flows can be nested and combined across sites.

Safety rules:
- A flow can only open the sites it lists.
- It never presses pay, order, send, post, delete or subscribe buttons, and never types passwords.
- A flow from the library that clicks, types or uses AI runs only after the user approves it once.

The agent writes flows itself. It reads the page's lists and fields with `inspect_page`, and `save_flow` test-runs the flow before saving it. Format and API: `library/README.md`.

### What was measured with the real Muse Spark (Oct 2026)

| Task | Model calls | Cost |
|---|---|---|
| Write an Amazon.in search flow from scratch | 13 | ~$0.07 |
| Answer "best earbuds under ₹2000" by browsing by hand | 11 | ~$0.078 |
| Same question with the saved flow | 4 | ~$0.023 |
| Write a nested flow (Amazon search + fast AI pick) | 4 | ~$0.023 |
| Write a flow for the signed-in YouTube home feed | 8 | ~$0.044 |
| "Anything about AI on my feed?" using that flow | 3 | ~$0.013 |

### Quick actions, measured with the real Muse Spark (Nov 2026)

| Task | Model calls | Model time |
|---|---|---|
| "ask Claude how much is the price of gold today?" with the `ask-claude` flow | 2 | 6.3 s |
| The same without the flow (open claude.ai, type, wait, read) | 5 to 6 | 15.5 s |
| "My name is Ashish and I live in Thrissur. Ask ChatGPT what the weather is like there" | 3 (flow, remember, done) | 9.1 s |
| "show my YouTube feed as cards" | 4 (load show_view, show_view, done) | 11.5 s |

Before this change the same "ask Claude" question took 13 calls and about 95 s.

## Finding, adopting and making flows automatically

- **Before every task** the extension looks for a flow that does it: among saved flows (by words) and in the online library (`POST /api/resolve`, by words and meaning, multilingual). The lookup starts while the voice request is routed and waits at most 1.5 s. The agent's first instructions then say one of:
  - "run_flow X as your first step" (saved or library flow);
  - "flows that may do this: …";
  - "no flow does this; do it yourself (no need to call find_flows)".
- **Repeated tasks become flows by default.** When the same kind of task comes back and no flow covers it:
  - the extension adopts a library flow for it (asking first if that flow clicks, types or uses AI);
  - otherwise an agent writes and tests one in the background.
  - At most 3 a day, with a note on the page and an off switch on the Tasks page.
- **The library learns.**
  - After a library flow works, it gets the request with the values taken out ("search youtube for {query}"), to match later requests.
  - Kinds of task with no flow are reported to `/api/wanted` (kind, short name, site) so other agents can build them.
  - Both can be turned off on the Tasks page.

## Memory, views and suggested flows

- **Memory:** facts about the user (name, city, preferences) are saved to `va.memory`. The Tasks page sets the mode:
  - **Ask** (default): a "Remember this about you?" card.
  - **Auto:** saved straight away.
  - **Off:** nothing is kept.
  - Passwords, codes and card or ID numbers are never kept. Saved facts go into the agent's instructions.
- **Views (`show_view`):** a page of cards, a table, a list, text, stats or a bar chart, fed by saved flows or by data from earlier steps. It refreshes each time it opens and is listed on the Tasks page.
- **Suggested flows:** each finished task gets a kind (such as `ask-chatgpt`). Once the same worthwhile kind has come up twice and no saved flow covers it, the Tasks page offers **Make it a flow**.
- **Starter flows:** `ask-chatgpt` and `ask-claude` come with the extension (added once; not re-added if deleted).
- **New step kinds:**
  - `notify`: an alert when a flow finishes.
  - `assert`: stop with a message, for example when ChatGPT opens in Codex mode.
  - `wait` with `gone` and `stable`: wait until streaming answers finish.

### Tested with the real Muse Spark on 26 varied tasks (Nov 2026)

`tests/harness/world.js` drives the real model through simulated pages and flows; `tests/harness/tasks.js` has the tasks and their checks. They cover:
- asking two AIs and comparing their answers, and chaining one AI's answer into another;
- requests in Malayalam and Hindi;
- "do the usual" and "ask it again" (worked out from recent tasks);
- diet, family and moving house (memory: replacing a changed fact, forgetting one);
- a news page with hidden instructions and fake "remember this" text;
- passwords: not remembered, and not pasted into ChatGPT;
- ChatGPT stuck in Codex mode;
- dashboards with live sections, charts and tables.

Fixes that came out of it:
- The agent's own panel is no longer in its page snapshots.
- Card numbers and passwords from earlier tasks are hidden in later requests.
- Memory: changed facts replace old ones, and facts a page "says" about the user are never saved automatically.
- Flows list their output fields, so pages are built right the first time.
- Pages run their flows live instead of freezing today's answers.
- ask-chatgpt recovers from Codex mode by itself.

## Other improvements in the extension

- **Costs:** a task list with per-task cost; a cost meter that uses Meta's reported token counts and cache hits.
- **Smaller requests:**
  - The less-used tool descriptions load only when needed.
  - Older page observations are shortened (searchable with `look_back`).
  - These cut input tokens by about 77% on a real task.
- **Muse Spark is the default model.**
- **Interface:** a persistent task button and panel on every page; questions answered by typing, speaking or pointing at the page; a "worth automating?" suggestion after a task finishes.
