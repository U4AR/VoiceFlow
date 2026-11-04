// Deploy the Voice Agent flow library to your Cloudflare account and publish the starter flows.
//   node deploy.mjs            (or double-click deploy.cmd on Windows)
// Steps: log in to Cloudflare if needed → create the D1 database (once) → create its tables → deploy the Worker →
// publish examples/*.json → print the address to paste into the extension (Tasks page → Flows → Library address).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const run = (cmd, opts = {}) => {
  console.log('> ' + cmd);
  return execSync(cmd, { encoding: 'utf8', stdio: opts.show ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
};
const wr = 'npx --yes wrangler@4';

// 1. Logged in?
try {
  console.log(run(`${wr} whoami`).split('\n').filter((l) => /logged in|account/i.test(l)).slice(0, 3).join('\n'));
} catch {
  run(`${wr} login`, { show: true });
}

// 2. The database (created once; its id goes into wrangler.toml).
let toml = readFileSync('wrangler.toml', 'utf8');
let id = (/database_id = "([0-9a-f-]{36})"/.exec(toml) || [])[1];
if (!id || /^0{8}-/.test(id)) {
  let list = [];
  try {
    list = JSON.parse(run(`${wr} d1 list --json`));
  } catch {}
  const found = list.find((d) => d.name === 'voice-agent-flows');
  if (found) id = found.uuid || found.database_id || found.id;
  else {
    const out = run(`${wr} d1 create voice-agent-flows`);
    id = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out) || [])[1];
  }
  if (!id) throw new Error('Could not create or find the D1 database "voice-agent-flows". Create it in the Cloudflare dashboard and put its id in wrangler.toml.');
  toml = toml.replace(/database_id = "[^"]*"/, `database_id = "${id}"`);
  writeFileSync('wrangler.toml', toml);
  console.log('database id', id, 'saved in wrangler.toml');
}

// 3. Tables (safe to run again).
run(`${wr} d1 execute voice-agent-flows --remote --file schema.sql --yes`, { show: true });

// 4. Deploy.
const out = run(`${wr} deploy`);
console.log(out);
const url = (/https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out) || [])[0];
if (!url) {
  console.log('Deployed, but the address was not in the output. Find it in the Cloudflare dashboard (Workers → voice-agent-flows).');
  process.exit(0);
}

// 5. Publish the starter flows with this computer's contributor token (kept in .contributor-token).
if (!existsSync('.contributor-token')) writeFileSync('.contributor-token', randomBytes(24).toString('hex'));
const token = readFileSync('.contributor-token', 'utf8').trim();
const order = ['gmail-search', 'gmail-read-mails', 'amazon-search', 'flipkart-search', 'youtube-feed', 'youtube-search', 'hackernews-top', 'duckduckgo-search', 'wikipedia-summary', 'gmail-digest', 'amazon-best-pick', 'price-compare', 'topic-briefing', 'morning-digest', 'ask-chatgpt', 'ask-claude', 'github-trending', 'arxiv-search', 'pypi-search', 'weather-now', 'currency-rate', 'youtube-channel-videos'];
const files = readdirSync('examples').map((f) => f.replace(/\.json$/, ''));
for (const name of [...order.filter((n) => files.includes(n)), ...files.filter((n) => !order.includes(n))]) {
  const flow = JSON.parse(readFileSync(`examples/${name}.json`, 'utf8'));
  const res = await fetch(url + '/api/flows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-contributor': token }, body: JSON.stringify({ flow: { ...flow, author: 'starter' } }) });
  const body = await res.json().catch(() => ({}));
  console.log(res.ok ? `published ${body.id} v${body.version}` : `could not publish ${name}: ${body.error} ${(body.errors || []).join('; ')}`);
}
// 6. Check that tasks find their flows (on Cloudflare, matching by meaning uses Workers AI, which also understands
//    other languages). The first call may take a few seconds while the flows get their embeddings.
const checks = [
  ['ask Claude what the price of gold is today', 'ask-claude'],
  ['what does chatgpt think about flutter vs react native', 'ask-chatgpt'],
  ['search youtube for flutter riverpod tutorials', 'youtube-search'],
  ['what is new on my youtube home feed', 'youtube-feed'],
  ['find mails from my bank in gmail', 'gmail-search'],
  ['compare earbud prices on amazon and flipkart', 'price-compare'],
  ['top stories on hacker news', 'hackernews-top'],
  ['look up Kerala on wikipedia', 'wikipedia-summary'],
  ['യൂട്യൂബിൽ ഫ്ലട്ടർ വീഡിയോകൾ തിരയൂ', 'youtube-search'],
  ['ChatGPT से पूछो कि आज कोच्चि में मौसम कैसा है', 'ask-chatgpt'],
  ['book a train ticket on IRCTC', null],
];
let good = 0;
for (const [task, want] of checks) {
  const r = await (await fetch(url + '/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) })).json().catch((e) => ({ error: e.message }));
  const got = r.verdict === 'none' ? null : r.best && r.best.id;
  const ok = got === want;
  if (ok) good++;
  console.log(`${ok ? 'ok  ' : 'MISS'} "${task}" → ${got || 'no flow'} (${r.verdict}${r.best ? ', score ' + r.best.score : ''}${want && !ok ? '; expected ' + want : ''})`);
}
console.log(`Matching check: ${good} of ${checks.length} tasks found the right flow.` + (good < checks.length ? ' The thresholds are in src/match.js (rank, verdict).' : ''));

const health = await (await fetch(url + '/api/health')).json().catch(() => ({}));
console.log(`\nThe flow library is live at ${url} (${health.flows ?? '?'} flows, matching by ${health.matching === 'ai' ? 'meaning (Workers AI) and words' : 'words'}).`);
console.log('In the extension: Tasks page → Flows → Online flow library → paste that address → Save → Test the connection.');
