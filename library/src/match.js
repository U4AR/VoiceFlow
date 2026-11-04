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
  'a an the and or of to in on for at by with from is are be me my i you your it this that these those please can could would will do does did get show find tell give make let us our what which who how when where about any some all'.split(' '),
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
const SAME = { find: 'search', look: 'search', lookup: 'search', seek: 'search', query: 'search', email: 'mail', mail: 'mail', inbox: 'mail', gmail: 'gmail', video: 'video', vid: 'video', cost: 'price', rate: 'price', cheap: 'price', cheapest: 'price', news: 'news', headline: 'news', story: 'news', storie: 'news', top: 'top', feed: 'feed', home: 'feed', homepage: 'feed', recommend: 'feed', summary: 'summar', summarize: 'summar', summarise: 'summar', wiki: 'wikipedia', yt: 'youtube', gpt: 'chatgpt', openai: 'chatgpt' };
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
  const brands = new Set();
  for (const r of rows)
    for (const host of JSON.parse(r.sites || '[]')) for (const label of String(host).toLowerCase().split('.')) if (label.length > 2 && !['www', 'com', 'org', 'net', 'co', 'in', 'mail', 'news', 'html', 'en', 'app'].includes(label)) brands.add(SAME[label] || label);
  brands.add('gmail');
  // Word rarity across flows (idf).
  const df = new Map();
  const toks = new Map();
  for (const r of rows) {
    const set = new Set([...tokens(r.search), ...tokens(r.id.replace(/-/g, ' ')), ...(ex.get(r.id) || []).flatMap((e) => tokens(e.text))]);
    toks.set(r.id, set);
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  }
  cache = { kind, at: Date.now(), rows, vecs, ex, df, toks, brands, n: rows.length };
  return cache;
}
export const forget = () => (cache = null);

const hostOf = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const onSite = (host, sites) => !!host && sites.some((s) => host === s || host.endsWith('.' + s) || s.endsWith('.' + host));

// Rank flows for a task. Returns [{row, score, words, meaning, example}], best first.
export async function rank(env, task, site, limit = 5) {
  const ix = await index(env);
  if (!ix.rows.length) return [];
  const q = [...new Set(tokens(task))];
  const idf = (t) => Math.log(1 + ix.n / (1 + (ix.df.get(t) || 0))) * (ix.brands.has(t) ? 3 : 1);
  const qWeight = q.reduce((a, t) => a + idf(t), 0) || 1;
  const named = q.some((t) => ix.brands.has(t)); // the task names a site or product
  const host = hostOf(site);
  const qv = ix.kind ? (await embed(env, [task]).catch(() => null))?.[0] : null;
  const out = [];
  for (const r of ix.rows) {
    const set = ix.toks.get(r.id);
    const hit = q.filter((t) => set.has(t));
    const words = hit.reduce((a, t) => a + idf(t), 0) / qWeight;
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
    const here = onSite(host, sites) ? (named ? 0.05 : 0.25) : 0;
    const reliable = r.runs > 3 ? (r.ok / r.runs - 0.5) * 0.1 : 0;
    // bge-m3 similarities of unrelated texts sit around 0.3-0.45 and of matching ones above 0.6: rescale to 0..1.
    const m = ix.kind === 'ai' ? Math.max(0, (meaning - 0.35) / 0.4) : meaning;
    const score = (qv ? 0.6 * Math.min(1, m) + 0.4 * words : words) + here + reliable;
    // It names a site or product that only one or two flows are about ("chatgpt", "irctc").
    const rare = hit.some((t) => ix.brands.has(t) && (ix.df.get(t) || 0) <= 2);
    out.push({ row: r, score: +score.toFixed(3), words: +words.toFixed(3), meaning: +meaning.toFixed(3), example, hits: hit, rare });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
// How sure a match is: "use" (run it), "maybe" (check it first) or "none".
export function verdict(best, second, kind) {
  if (!best) return 'none';
  const gap = best.score - (second ? second.score : 0);
  const sure = kind ? best.score >= 0.55 && (gap >= 0.08 || best.score >= 0.75) : best.words >= 0.6 && best.hits.length >= 2;
  if (sure || (best.rare && gap >= 0.08 && best.score >= 0.2)) return 'use';
  return best.score >= (kind ? 0.35 : 0.3) ? 'maybe' : 'none';
}
