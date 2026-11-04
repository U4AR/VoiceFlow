// Matching a task ("ask Claude how much gold costs today", "യൂട്യൂബിൽ ഫ്ലട്ടർ വീഡിയോകൾ തിരയൂ") to the flows that do it.
//
// Two signals, combined:
//  - words: the task's words found in a flow's id, name, description, tags and sites (weighted by how rare they are);
//  - meaning: cosine similarity of embeddings from Workers AI (@cf/baai/bge-m3, multilingual), of the flow's
//    description and of short phrasings that worked for it before (learned from successful runs).
// Without the AI binding (local tests) the meaning signal uses a small word-hash embedding instead, or is left out.
//
// Vectors are stored in D1 as base64 int8 (1 KB per vector at 1024 dimensions) and kept in memory for a minute.

export const MODEL = '@cf/baai/bge-m3';
const HASH_DIM = 256;
const STOP = new Set(
  'a an the and or of to in on for at by with from is are be me my i you your it this that these those please can could would will do does did get show tell give make let us our open go today now current currently what which who how when where about any some all'.split(' '),
);

export const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .map((w) => SAME[w] || w);
// Words that mean the same thing for finding a flow.
const SAME = { find: 'search', look: 'search', lookup: 'search', seek: 'search', query: 'search', email: 'mail', mail: 'mail', inbox: 'mail', gmail: 'gmail', video: 'video', vid: 'video', cost: 'price', rate: 'price', cheap: 'price', cheapest: 'price', news: 'news', headline: 'news', story: 'news', storie: 'news', top: 'top', feed: 'feed', home: 'feed', homepage: 'feed', recommend: 'feed', summary: 'summar', summarize: 'summar', summarise: 'summar', wiki: 'wikipedia', yt: 'youtube', gpt: 'chatgpt', openai: 'chatgpt', rupee: 'currency', dollar: 'currency', euro: 'currency', yen: 'currency', pound: 'currency', usd: 'currency', inr: 'currency', eur: 'currency', gbp: 'currency', exchange: 'currency', forex: 'currency', rain: 'weather', raining: 'weather', forecast: 'weather', temperature: 'weather', humid: 'weather', humidity: 'weather', sunny: 'weather', paper: 'paper', papers: 'paper', };
function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w;
  return w.replace(/(ings|ing|ers|er|ies|es|ed|s)$/, (m) => (m === 'ies' ? 'y' : ''));
}

// ---------- Embeddings ----------
function hashVec(text) {
  const v = new Float32Array(HASH_DIM);
  for (const t of tokens(text)) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    v[(h >>> 0) % HASH_DIM] += 1;
  }
  return normalize(v);
}
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}
// Which embedding this deployment uses: 'ai' (Workers AI), 'hash' (tests) or null (words only).
export const embedKind = (env) => (env.AI ? 'ai' : env.EMBED === 'hash' ? 'hash' : null);
export async function embed(env, texts) {
  const kind = embedKind(env);
  if (!kind || !texts.length) return null;
  if (kind === 'hash') return texts.map(hashVec);
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const r = await env.AI.run(MODEL, { text: texts.slice(i, i + 50).map((t) => String(t).slice(0, 2000)) });
    const data = (r && (r.data || r.response)) || [];
    for (const d of data) out.push(normalize(Float32Array.from(d)));
  }
  return out.length === texts.length ? out : null;
}
export function pack(v) {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  let s = '';
  for (const b of new Uint8Array(q.buffer)) s += String.fromCharCode(b);
  return btoa(s);
}
export function unpack(b64) {
  const bin = atob(b64);
  const q = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) q[i] = (bin.charCodeAt(i) << 24) >> 24;
  return normalize(Float32Array.from(q, (x) => x / 127));
}
export function cos(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// The text a flow is matched on.
export const flowText = (row) => [row.name, row.description, JSON.parse(row.tags || '[]').join(', '), 'Sites: ' + JSON.parse(row.sites || '[]').join(', '), 'Inputs: ' + row.inputs].join('. ');

// A phrasing of a task worth keeping as an example: personal details out, short. The extension already replaces the
// values it passed to the flow with {placeholders} ("ask Claude {question}").
export function scrub(task) {
  let t = String(task || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '{email}')
    .replace(/https?:\/\/\S+/g, '{link}')
    .replace(/\b(pass(?:word|code)?|otp|pin|cvv|code)\b\s*(?:is|:|=)?\s*\S+/gi, '$1 {secret}')
    .replace(/[₹$€£]?\s?\d[\d,.\s-]{2,}\d/g, '{number}')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 140 || t.split(' ').length > 16) return '';
  return t;
}

// ---------- Index (in memory per isolate, refreshed every minute) ----------
let cache = null;
async function index(env) {
  const kind = embedKind(env);
  if (cache && cache.kind === kind && Date.now() - cache.at < 60000) return cache;
  const rows = (await env.DB.prepare('SELECT id, name, description, sites, tags, inputs, acts, uses_ai, calls, version, author, runs, ok, updated, search FROM flows WHERE hidden = 0').all()).results;
  const vecs = new Map();
  const ex = new Map();
  if (kind) {
    for (const r of (await env.DB.prepare('SELECT id, vec FROM flow_vectors WHERE model = ?1').bind(kind).all()).results) vecs.set(r.id, unpack(r.vec));
    // Flows without a vector yet (published before embeddings were on): embed them now, 50 at a time.
    const missing = rows.filter((r) => !vecs.has(r.id)).slice(0, 50);
    if (missing.length) {
      const vs = await embed(env, missing.map(flowText)).catch(() => null);
      if (vs) {
        await env.DB.batch(missing.map((r, i) => env.DB.prepare('INSERT OR REPLACE INTO flow_vectors (id, model, vec, updated) VALUES (?1, ?2, ?3, ?4)').bind(r.id, kind, pack(vs[i]), new Date().toISOString())));
        missing.forEach((r, i) => vecs.set(r.id, vs[i]));
      }
    }
    for (const r of (await env.DB.prepare('SELECT id, text, vec FROM flow_examples WHERE model = ?1').bind(kind).all()).results) {
      if (!ex.has(r.id)) ex.set(r.id, []);
      ex.get(r.id).push({ text: r.text, vec: unpack(r.vec) });
    }
  }
  // Names of sites and products (youtube, chatgpt, gmail, flipkart …): a task naming one is almost always about it.
  // Each flow owns the brands of its own sites (a Gmail flow owns "gmail", not "google").
  const owns = new Map();
  for (const r of rows) owns.set(r.id, brandsOf(JSON.parse(r.sites || '[]')));
  const brands = new Set([...owns.values()].flatMap((b) => [...b]));
  // Word rarity across flows (idf).
  const df = new Map();
  const toks = new Map();
  for (const r of rows) {
    const set = new Set([...tokens(r.search), ...tokens(r.id.replace(/-/g, ' ')), ...(ex.get(r.id) || []).flatMap((e) => tokens(e.text))]);
    toks.set(r.id, set);
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  }
  cache = { kind, at: Date.now(), rows, vecs, ex, df, toks, brands, owns, n: rows.length };
  return cache;
}
export const forget = () => (cache = null);
// Things a task can ask for that flows never do on their own (they stop before paying, sending, posting or deleting).
const DEEDS = new Set(['book', 'buy', 'order', 'pay', 'purchase', 'send', 'post', 'delete', 'cancel', 'reserve', 'apply', 'register', 'subscribe', 'transfer', 'checkout', 'reply', 'forward', 'tweet', 'upload', 'sell']);
// The brand a site stands for: its main name (youtube.com → youtube), or the product for a few well-known subdomains
// (mail.google.com → gmail); other subdomains of a big site (news.google.com) stand for no brand of their own.
const PRODUCT = { 'mail.google.com': 'gmail' };
const GENERIC = new Set(['www', 'com', 'org', 'net', 'co', 'in', 'html', 'en', 'app', 'gov', 'edu', 'ac', 'io', 'ai', 'm']);
export function brandsOf(sites) {
  const out = new Set();
  for (const s of sites || []) {
    const host = String(s).toLowerCase().replace(/^www\./, '');
    if (PRODUCT[host]) {
      out.add(PRODUCT[host]);
      continue;
    }
    const labels = host.split('.').filter((l) => !GENERIC.has(l));
    if (!labels.length) continue;
    if (labels.length > 1) continue; // a subdomain of another site (news.google.com, html.duckduckgo.com is handled below)
    if (labels[0].length > 2) out.add(SAME[labels[0]] || labels[0]);
  }
  // html.duckduckgo.com and the like: a subdomain that is only a variant of the site keeps the site's name.
  for (const s of sites || []) {
    const m = /^(?:html|m|mobile|en|web)\.([a-z0-9-]+)\.[a-z.]+$/.exec(String(s).toLowerCase());
    if (m) out.add(SAME[m[1]] || m[1]);
  }
  return out;
}

const hostOf = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const onSite = (host, sites) => !!host && sites.some((s) => host === s || host.endsWith('.' + s) || s.endsWith('.' + host));

// Rank flows for a task. Returns [{row, score, words, meaning, example}], best first.
export async function rank(env, task, site, limit = 5) {
  const ix = await index(env);
  if (!ix.rows.length) return [];
  const q = [...new Set(tokens(task))];
  // Words no flow uses cannot tell flows apart (they are often the question itself): they count only a little.
  const base = (t) => (!ix.df.get(t) ? 0.5 : Math.log(1 + ix.n / (1 + ix.df.get(t))));
  // A brand word weighs 3 times as much, for the flows of that brand.
  const idf = (t, own) => base(t) * (ix.brands.has(t) && (!own || own.has(t)) ? 3 : 1);
  const qWeight = q.reduce((a, t) => a + idf(t), 0) || 1;
  const namedBrands = q.filter((t) => ix.brands.has(t));
  const acts = q.filter((t) => DEEDS.has(t));
  const named = namedBrands.length > 0; // the task names a site or product
  const host = hostOf(site);
  const qv = ix.kind ? (await embed(env, [task]).catch(() => null))?.[0] : null;
  const low = Number(env.MATCH_LOW) || 0.42;
  const span = Number(env.MATCH_SPAN) || 0.2;
  const out = [];
  for (const r of ix.rows) {
    const set = ix.toks.get(r.id);
    const hit = q.filter((t) => set.has(t));
    const own = ix.owns.get(r.id) || new Set();
    const words = hit.reduce((a, t) => a + idf(t, own), 0) / qWeight;
    let meaning = 0;
    let example = '';
    if (qv) {
      meaning = cos(qv, ix.vecs.get(r.id));
      for (const e of ix.ex.get(r.id) || []) {
        const c = cos(qv, e.vec);
        if (c > meaning) (meaning = c), (example = e.text);
      }
    }
    const sites = JSON.parse(r.sites || '[]');
    // The site the user is on counts for a lot when the task names none ("search for flutter" on youtube.com).
    const reliable = r.runs > 3 ? (r.ok / r.runs - 0.5) * 0.1 : 0;
    // Measured with bge-m3 on the live library (Nov 2026): unrelated task/flow pairs stay below about 0.44, matching
    // ones are 0.47-0.65. Rescale that band to 0..1 (MATCH_LOW / MATCH_SPAN in the Worker's settings adjust it).
    const m = ix.kind === 'ai' ? Math.max(0, (meaning - low) / span) : meaning;
    // ...but only for a flow the task has something to do with (on youtube.com, "turn off the lights" is no YouTube task).
    const here = onSite(host, sites) && (hit.length || m > 0.05) ? (named ? 0.05 : 0.25) : 0;
    // A task that names a site ("ask Claude …", "search Google for …") is about that site: other flows count half.
    const offBrand = named && !namedBrands.some((t) => own.has(t)) ? 0.5 : 1;
    // Flows never book, pay, order, send or delete: a task that asks for that is not done by a flow that only looks
    // things up ("book a train ticket" is not "train running status"), unless the flow says it does it.
    const deed = acts.length && !acts.some((t) => set.has(t)) ? 0.5 : 1;
    const score = ((qv ? 0.6 * Math.min(1, m) + 0.4 * words : words) + here) * offBrand * deed + reliable;
    // It names a site or product that only one or two flows are about ("chatgpt", "irctc").
    const rare = hit.some((t) => own.has(t) && (ix.df.get(t) || 0) <= 2);
    out.push({ row: r, score: +score.toFixed(3), words: +words.toFixed(3), meaning: +meaning.toFixed(3), example, hits: hit, rare });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
// How sure a match is: "use" (run it), "maybe" (check it first) or "none".
export function verdict(best, second, kind) {
  if (!best) return 'none';
  const gap = best.score - (second ? second.score : 0);
  // Flows of one site score alike ("gmail-search" / "gmail-digest"): without a clear gap the caller is shown both.
  const sure = kind ? (best.score >= 0.7 && gap >= 0.03) || (best.score >= 0.5 && gap >= 0.06) || (best.score >= 0.4 && gap >= 0.1) || (best.score >= 0.3 && gap >= 0.15) : best.words >= 0.6 && best.hits.length >= 2;
  if (sure || (best.rare && gap >= 0.08 && best.score >= 0.2)) return 'use';
  return best.score >= (kind ? 0.2 : 0.3) ? 'maybe' : 'none';
}
