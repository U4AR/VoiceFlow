// Test the matching backend against a running library (node test-match.mjs http://127.0.0.1:8787).
// Expects an empty database; publishes the starter flows first.
import { readFileSync, readdirSync } from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail).slice(0, 600)));
};
const post = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const token = 'test-token-0123456789abcdef';
const order = ['gmail-search', 'gmail-read-mails', 'amazon-search', 'flipkart-search', 'youtube-feed', 'youtube-search', 'hackernews-top', 'duckduckgo-search', 'wikipedia-summary', 'gmail-digest', 'amazon-best-pick', 'price-compare', 'topic-briefing', 'morning-digest', 'ask-chatgpt', 'ask-claude'];
const files = readdirSync('examples').map((f) => f.replace(/\.json$/, ''));
let published = 0;
for (const n of [...order.filter((x) => files.includes(x)), ...files.filter((x) => !order.includes(x))]) {
  const r = await post('/api/flows', { flow: JSON.parse(readFileSync('examples/' + n + '.json', 'utf8')) }, { 'x-contributor': token });
  if (r.status === 201) published++;
  else console.log('publish', n, r.status, r.body);
}
check('starter flows published', published === files.length, published);
const h = await (await fetch(base + '/api/health')).json();
check('health says how tasks are matched', h.matching === 'hash' || h.matching === 'ai', h);

const cases = [
  ['ask Claude what the price of gold is today', 'ask-claude'],
  ['what does chatgpt think about flutter vs react native', 'ask-chatgpt'],
  ['search youtube for flutter riverpod tutorials', 'youtube-search'],
  ['what is new on my youtube home feed', 'youtube-feed'],
  ['find mails from my bank in gmail', 'gmail-search'],
  ['compare earbud prices on amazon and flipkart', 'price-compare'],
  ['top stories on hacker news', 'hackernews-top'],
  ['summarize the wikipedia article about Kerala', 'wikipedia-summary'],
  ['search flipkart for a phone under 15000', 'flipkart-search'],
];
for (const [task, want] of cases) {
  const r = await post('/api/resolve', { task });
  check(`"${task}" → ${want}`, r.body.best && r.body.best.id === want && r.body.verdict !== 'none', { verdict: r.body.verdict, got: (r.body.candidates || []).slice(0, 3).map((c) => c.id + ':' + c.score) });
}
for (const task of ['book a bus ticket to Kochi on KSRTC', 'turn off the bedroom lights']) {
  const r = await post('/api/resolve', { task });
  check(`"${task}" → no flow (verdict none)`, r.body.verdict === 'none' && r.body.next, { verdict: r.body.verdict, best: r.body.best && r.body.best.id, c: (r.body.candidates || []).slice(0, 2).map((c) => c.id + ':' + c.score) });
}
const onSite = await post('/api/resolve', { task: 'search for flutter', site: 'https://www.youtube.com/' });
check('the site the user is on breaks ties ("search for flutter" on youtube.com → youtube-search)', onSite.body.best && onSite.body.best.id === 'youtube-search', onSite.body.candidates && onSite.body.candidates.slice(0, 3).map((c) => c.id + ':' + c.score));

// Learning: a phrasing that worked is kept (scrubbed) and matches a later task that shares no words with the flow.
const before = await post('/api/resolve', { task: 'todays horoscope for leo please' });
const rep = await post('/api/flows/ask-claude/report', { ok: true, task: 'Claude: todays horoscope for leo please, my card 4111 1111 1111 1111' });
check('a successful run with its task is learned', rep.body.learned === true, rep.body);
const after = await post('/api/resolve', { task: 'horoscope for leo?' });
check('a learned phrasing helps match a new task ("horoscope for leo?" → ask-claude)', after.body.best && after.body.best.id === 'ask-claude' && (!before.body.best || before.body.best.id !== 'ask-claude' || after.body.best.score > before.body.best.score), { before: before.body.best && before.body.best.id + ':' + before.body.best.score, after: after.body.best && after.body.best.id + ':' + after.body.best.score, like: after.body.best && after.body.best.why });
check('learned phrasings never show the card number', !JSON.stringify(after.body).includes('4111'), after.body.best && after.body.best.why);
const getOne = await (await fetch(base + '/api/flows/ask-claude')).json();
check('learned phrasings are not in the public flow data', !JSON.stringify(getOne).includes('horoscope'), Object.keys(getOne));
const failRep = await post('/api/flows/ask-claude/report', { ok: false, task: 'something that failed' });
check('a failed run teaches nothing', !failRep.body.learned, failRep.body);

// Wanted: common tasks without a flow, counted per person; publishing a flow for one marks it done.
const w1 = await post('/api/wanted', { kind: 'ksrtc-bus-search', name: 'Search KSRTC buses from Thrissur to 9876543210', site: 'onlineksrtcswift.com', client: 'clientAAAAAAAAAAAAAAAA' });
await post('/api/wanted', { kind: 'ksrtc-bus-search', name: 'Search KSRTC buses', site: 'onlineksrtcswift.com', client: 'clientAAAAAAAAAAAAAAAA' });
const w3 = await post('/api/wanted', { kind: 'ksrtc-bus-search', name: 'Search KSRTC buses', site: 'onlineksrtcswift.com', client: 'clientBBBBBBBBBBBBBBBB' });
check('wanted: counted once per person (3 asks, 2 people)', w3.body.n === 3 && w3.body.clients === 2, w3.body);
check('wanted: numbers in the name are dropped', !/\d{4}/.test(w1.body.name), w1.body);
const bad = await post('/api/wanted', { kind: 'Not An Id!', name: 'x' });
check('wanted: a bad kind is refused', bad.status === 400, bad);
const covered = await post('/api/wanted', { kind: 'claude-ask', name: 'Ask Claude a question', site: 'claude.ai', client: 'clientCCCCCCCCCCCCCCCC' });
check('wanted: says when a flow already covers it', covered.body.coveredBy === 'ask-claude', covered.body);
let list = (await (await fetch(base + '/api/wanted')).json()).wanted;
check('GET /api/wanted lists the most wanted first', list[0] && list[0].kind === 'ksrtc-bus-search' && list[0].people === 2, list);
const site = (await (await fetch(base + '/api/wanted?site=onlineksrtcswift.com')).json()).wanted;
check('GET /api/wanted?site= filters by site', site.length === 1, site);
const irctc = {
  id: 'ksrtc-bus-search', name: 'Search KSRTC buses', description: 'List KSRTC buses between two places on a date: name, departure, arrival, fare.', sites: ['onlineksrtcswift.com'],
  inputs: { from: { type: 'string', required: true }, to: { type: 'string', required: true } }, model: 'none',
  steps: [{ do: 'open', url: 'https://onlineksrtcswift.com/search?from={{from}}&to={{to}}' }, { do: 'extract', as: 'buses', items: '.bus-item', fields: { name: '.bus-name' } }],
  output: '{{buses}}',
};
const pub = await post('/api/flows', { flow: irctc }, { 'x-contributor': token });
check('publishing a flow for a wanted task marks it done', pub.status === 201 && (pub.body.covers || []).includes('ksrtc-bus-search'), pub.body);
list = (await (await fetch(base + '/api/wanted')).json()).wanted;
check('a done task leaves the wanted list', !list.some((x) => x.kind === 'ksrtc-bus-search'), list);
const nowFound = await post('/api/resolve', { task: 'KSRTC buses from Thrissur to Chennai' });
check('the new flow is found right away', nowFound.body.best && nowFound.body.best.id === 'ksrtc-bus-search', nowFound.body.candidates && nowFound.body.candidates.slice(0, 2));
const big = await fetch(base + '/api/resolve', { method: 'POST', body: 'x'.repeat(20000) });
check('a huge body is refused', big.status === 413, big.status);
console.log(`RESULT ${pass} of ${pass + fail} passed`);
