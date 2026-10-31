# Voice Agent flows

A voice-driven browser agent (Edge/Chrome extension) that turns repeatable browser jobs into **flows**. A flow is a small, tested function such as "search Gmail", "compare prices on Amazon and Flipkart" or "my morning digest". Once saved, a flow runs in one step instead of the agent working the site out again. Flows can be shared through an online library, and Claude Code and other MCP apps can use them.

| Folder | What |
|---|---|
| `extension/` | The extension, ready to load unpacked (Nanobrowser fork plus the Voice Agent add-ons) |
| `extension/mcp/` | `voice-agent-mcp.mjs`, a local MCP server that exposes every saved flow as a tool to Claude Code, Claude Desktop or any MCP app |
| `library/` | The online flow library: a Cloudflare Worker with a D1 database, a browse page and 14 starter flows |
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

## Other improvements in the extension

- **Costs:** a task list with per-task cost; a cost meter that uses Meta's reported token counts and cache hits.
- **Smaller requests:**
  - The less-used tool descriptions load only when needed.
  - Older page observations are shortened (searchable with `look_back`).
  - These cut input tokens by about 77% on a real task.
- **Muse Spark is the default model.**
- **Interface:** a persistent task button and panel on every page; questions answered by typing, speaking or pointing at the page; a "worth automating?" suggestion after a task finishes.
