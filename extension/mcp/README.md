# Voice Agent MCP server

Lets **Claude Code, Claude Desktop and any other MCP app** on this computer use the flows saved in your Voice Agent extension. A flow ("search Gmail", "compare prices on Amazon and Flipkart", "morning digest") runs in *your* browser, with your sign-ins, and returns JSON. So a Claude Code pipeline can, for example, read your Gmail results without any Google API keys.

Each saved flow shows up as its own MCP tool (`flow_gmail_search`, `flow_price_compare`, ...) with the flow's inputs as parameters. In effect, each site's flows are a small MCP server for that site. There are also `find_flows` (which searches your flows and the online library), `get_flow`, `run_flow` and `browser_status`. When you save a new flow in the browser, connected apps get the new tool straight away.

## Set up (once)

You need Node.js 18 or later, and Edge or Chrome with the Voice Agent extension open.

1. **Get the pairing code:**
   ```
   node "D:\UserData\Downloads\voice-agent-test (3)\mcp\voice-agent-mcp.mjs" --pairing-code
   ```
   The code is created the first time and kept in `%USERPROFILE%\.voice-agent-mcp\pairing-code`.
2. **In the extension:** open the Tasks page, then **Apps on this computer (MCP)**.
   - Tick **Let apps on this computer use my flows**.
   - Paste the code.
   - Click **Save**.
3. **Add it to your app.**
   - Claude Code:
     ```
     claude mcp add voice-agent -- node "D:\UserData\Downloads\voice-agent-test (3)\mcp\voice-agent-mcp.mjs"
     ```
   - Claude Desktop: Settings → Developer → Edit config. Inside `"mcpServers"`, add:
     ```json
     "voice-agent": { "command": "node", "args": ["D:\\UserData\\Downloads\\voice-agent-test (3)\\mcp\\voice-agent-mcp.mjs"] }
     ```
   - Other products (HTTP): start it with `node voice-agent-mcp.mjs --http`. Then send JSON-RPC to `POST http://127.0.0.1:17345/mcp` with the header `Authorization: Bearer <pairing code>`.

The Tasks page shows **● connected** once an app has started the server. Every request is listed there: which app, which flow, whether it worked.

## Try it in Claude Code

> Use the voice-agent tools: compare prices for wireless earbuds under ₹2000 on Amazon and Flipkart, then tell me the subjects of my unread Gmail from today.

## How it works, and what keeps it safe

- The first copy of the server listens on `127.0.0.1:17345`; it is never reachable from other computers. A second Claude window starts a second copy, which relays to the first.
- The extension connects to the server only when you've ticked the setting. Before anything else, both sides prove they know the pairing code. The check is an HMAC, so the code itself is never sent.
- Only the extension can connect: the server refuses connections whose origin isn't a browser extension, so web pages can't pretend to be it.
- Connected apps can search and run your saved flows, and read-only flows from the online library.
- Library flows that click, type or use AI run only after you have approved them once in the browser.
- Apps can add new flows only if you tick **Also let them add new flows**.
- Flows can never pay, order, send, post or delete, and never type passwords.
- Flow outputs are web page data. The server tells apps to treat them as information, not instructions.

Options: `--port N` (the extension's port setting must match; the default is 17345), `--http` (no stdio, only the HTTP endpoint), `VOICE_AGENT_MCP_DIR` (where the pairing code is kept).
