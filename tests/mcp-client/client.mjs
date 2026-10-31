// MCP client test (official SDK): owner over stdio, a second copy relaying, list_changed, and the per-flow tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
const SERVER = process.env.SERVER;
const env = { ...process.env };
const out = {};
const mk = async (name) => {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'inherit' }));
  return c;
};
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return r.content && r.content[0] && r.content[0].text; } };
const a = await mk('test-client-a');
let changed = 0;
a.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
// wait for the extension to connect (it retries every 10 s)
let st;
for (let i = 0; i < 40; i++) { st = parse(await a.callTool({ name: 'browser_status', arguments: {} })); if (st.connected) break; await new Promise((r) => setTimeout(r, 1000)); }
out.status = st;
const tools = (await a.listTools()).tools;
out.toolNames = tools.map((t) => t.name);
out.gmailSchema = (tools.find((t) => t.name === 'flow_gmail_search') || {}).inputSchema;
const call = async (c, name, args) => { const t0 = Date.now(); const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 240000 }); return { isError: !!r.isError, ms: Date.now() - t0, data: parse(r) }; };
out.gmail = await call(a, 'flow_gmail_search', { query: 'hackathon' });
out.priceCompare = await call(a, 'flow_price_compare', { query: 'headphones', maxPrice: 3000 });
out.briefing = await call(a, 'flow_topic_briefing', { topic: 'Kerala backwaters' });
out.digest = await call(a, 'flow_morning_digest', {});
out.find = await call(a, 'find_flows', { query: 'hacker news' });
out.getFlow = await call(a, 'get_flow', { id: 'price-compare' });
out.runById = await call(a, 'run_flow', { id: 'hackernews-top', input: {} });
out.saveNotAllowed = await call(a, 'save_flow', { flow: { id: 'x' } });
out.missingInput = await call(a, 'flow_gmail_search', {});
// a second copy (another Claude Code window) relays to the first
const b = await mk('test-client-b');
out.relayTools = (await b.listTools()).tools.length;
out.relayRun = await call(b, 'flow_wikipedia_summary', { topic: 'Kerala backwaters' });
// a new flow saved in the browser shows up as a tool (list_changed)
out.changedBefore = changed;
if (process.env.SIGNAL_FILE) { const fs = await import('node:fs'); fs.writeFileSync(process.env.SIGNAL_FILE, 'ready'); for (let i = 0; i < 60 && fs.readFileSync(process.env.SIGNAL_FILE, 'utf8') !== 'saved'; i++) await new Promise((r) => setTimeout(r, 500)); }
await new Promise((r) => setTimeout(r, 1500));
out.changedAfter = changed;
out.newTool = (await a.listTools()).tools.some((t) => t.name === 'flow_hn_titles');
await b.close();
await a.close();
console.log(JSON.stringify(out));
