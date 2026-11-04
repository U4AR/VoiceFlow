// Voice Agent flow library API (Cloudflare Worker + D1). Any agent can search and fetch flows; publishing needs a
// contributor token (any random string of 16 to 128 letters/digits that the publisher keeps; it proves ownership of
// the flows it published, nothing else). Every flow is validated with the same rules the extension uses.
//
//   GET    /api/health                      {ok, flows}
//   GET    /api/flows?q=&site=&limit=       {flows: [summary]}       search (q words match name, description, tags, sites)
//   GET    /api/flows/:id                   {flow, stats, versions}  latest version (or /api/flows/:id/v/:n)
//   POST   /api/flows        {flow}         {id, version}            publish (x-contributor header); new id, or a new version of your own
//   POST   /api/flows/:id/report {ok, ms}   {ok}                     tell the library a run worked or failed
//   DELETE /api/flows/:id                   {ok}                     the publisher (x-contributor) or the admin (Bearer ADMIN_TOKEN)
//   POST   /api/resolve {task, site?}       {verdict, best, candidates}  which flow does this task: "use", "maybe" or "none"
//   POST   /api/wanted {kind, name, site, client}  {kind, n, clients}  a common task with no flow yet (no personal text)
//   GET    /api/wanted?site=&limit=         {wanted: [...]}           what agents could build next, most wanted first
import './flows-core.js';
import { rank, verdict, embed, embedKind, pack, cos, unpack, tokens, scrub, flowText, forget } from './match.js';

const F = globalThis.VAFlows;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-contributor, authorization',
};
const reply = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });
const bad = (error, status = 400, more = {}) => reply({ error, ...more }, status);

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// A fixed-window counter per key per hour; false when over the limit.
async function allow(env, key, limit) {
  const win = new Date().toISOString().slice(0, 13);
  const r = await env.DB.prepare('INSERT INTO rate (k, win, n) VALUES (?1, ?2, 1) ON CONFLICT (k, win) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(key, win)
    .first();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate WHERE win < ?1').bind(new Date(Date.now() - 864e5).toISOString().slice(0, 13)).run();
  return !r || r.n <= limit;
}
function summary(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sites: JSON.parse(row.sites),
    tags: JSON.parse(row.tags),
    inputs: row.inputs,
    acts: !!row.acts,
    usesAI: !!row.uses_ai,
    calls: JSON.parse(row.calls || '[]'),
    version: row.version,
    author: row.author || null,
    runs: row.runs,
    ok: row.ok,
    updated: row.updated,
  };
}
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).slice(0, 8);

async function search(env, url) {
  const q = words(url.searchParams.get('q'));
  const site = String(url.searchParams.get('site') || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  // Candidates: any word or the site appears; scored here (fine for thousands of flows).
  const terms = [...q, ...(site ? [site.split('.').slice(-2, -1)[0] || site] : [])];
  let rows;
  if (terms.length) {
    const where = terms.map((_, i) => 'search LIKE ?' + (i + 1)).join(' OR ');
    rows = (await env.DB.prepare('SELECT * FROM flows WHERE hidden = 0 AND (' + where + ') ORDER BY updated DESC LIMIT 300').bind(...terms.map((t) => '%' + t + '%')).all()).results;
  } else rows = (await env.DB.prepare('SELECT * FROM flows WHERE hidden = 0 ORDER BY updated DESC LIMIT ?1').bind(limit).all()).results;
  const scored = rows.map((r) => {
    const hay = r.search;
    let score = q.filter((w) => hay.includes(w)).length * 3;
    if (site && JSON.parse(r.sites).some((s) => F.hostIn(site, s) || F.hostIn(s, site))) score += 4;
    score += Math.min(3, Math.log10(1 + r.ok)) - (r.runs > 3 && r.ok / r.runs < 0.5 ? 2 : 0);
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || String(b.r.updated).localeCompare(String(a.r.updated)));
  return reply({ flows: scored.slice(0, limit).map((x) => summary(x.r)) }, 200, { 'cache-control': 'public, max-age=30' });
}

async function publish(env, req, ip) {
  const token = req.headers.get('x-contributor') || '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return bad('send an x-contributor header: a random string of 16 to 128 letters or digits that you keep (it marks the flows as yours)', 401);
  if (!(await allow(env, 'pub:' + ip, 30)) || !(await allow(env, 'pubt:' + token.slice(0, 32), 30))) return bad('too many publishes this hour', 429);
  const text = await req.text();
  if (text.length > 40000) return bad('too large');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('the body must be JSON: {"flow": {...}}');
  }
  const flow = body && body.flow;
  const v = F.validate(flow);
  if (!v.ok) return bad('the flow is not valid', 422, { errors: v.errors });
  const secrets = F.privacyScan(flow).filter((h) => /key|account number/.test(h));
  if (secrets.length) return bad('the flow looks like it contains ' + secrets.join(', ') + '; remove it and publish again', 422);
  for (const c of v.calls) if (!(await env.DB.prepare('SELECT 1 FROM flows WHERE id = ?1 AND hidden = 0').bind(c).first())) return bad('it calls flow "' + c + '", which is not in the library; publish that first', 422);
  const owner = await sha256(token);
  const now = new Date().toISOString();
  // Your own id gets a new version; someone else's id gets a free name next to it.
  let id = flow.id;
  let row = await env.DB.prepare('SELECT id, owner, version, created FROM flows WHERE id = ?1').bind(id).first();
  for (let n = 2; row && row.owner !== owner && n < 50; n++) {
    id = (flow.id.slice(0, 60) + '-' + n).slice(0, 64);
    row = await env.DB.prepare('SELECT id, owner, version, created FROM flows WHERE id = ?1').bind(id).first();
  }
  if (row && row.owner !== owner) return bad('no free id near ' + flow.id + '; pick another id', 409);
  const version = row ? row.version + 1 : 1;
  const author = String(flow.author || '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || null;
  const def = { ...flow, id, version };
  delete def.author;
  const d = F.describe(def);
  // A flow made of other flows also belongs to their sites (so /api/sites/mail.google.com lists gmail-digest too).
  const allSites = new Set((def.sites || []).map((x) => String(x).toLowerCase().replace(/^www\./, '')));
  for (const c of v.calls) {
    const r = await env.DB.prepare('SELECT sites FROM flows WHERE id = ?1').bind(c).first();
    if (r) for (const x of JSON.parse(r.sites)) allSites.add(x);
  }
  const searchText = [id, def.name, def.description, (def.tags || []).join(' '), [...allSites].join(' ')].join(' ').toLowerCase();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO flows (id, owner, name, description, sites, tags, inputs, acts, uses_ai, calls, version, def, author, search, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15) ' +
        'ON CONFLICT (id) DO UPDATE SET name = ?3, description = ?4, sites = ?5, tags = ?6, inputs = ?7, acts = ?8, uses_ai = ?9, calls = ?10, version = ?11, def = ?12, author = ?13, search = ?14, updated = ?15, hidden = 0',
    ).bind(id, owner, def.name, def.description, JSON.stringify([...allSites]), JSON.stringify(def.tags || []), d.inputs, v.acts ? 1 : 0, v.usesAI ? 1 : 0, JSON.stringify(v.calls), version, JSON.stringify(def), author, searchText, now),
    env.DB.prepare('INSERT INTO flow_versions (id, version, def, created) VALUES (?1, ?2, ?3, ?4)').bind(id, version, JSON.stringify(def), now),
  ]);
  // Its embedding (for /api/resolve), and the wanted tasks it now covers.
  const done = [];
  try {
    const kind = embedKind(env);
    const text = flowText({ name: def.name, description: def.description, tags: JSON.stringify(def.tags || []), sites: JSON.stringify([...allSites]), inputs: d.inputs });
    const fv = kind ? (await embed(env, [text]))?.[0] : null;
    if (fv) await env.DB.prepare('INSERT OR REPLACE INTO flow_vectors (id, model, vec, updated) VALUES (?1, ?2, ?3, ?4)').bind(id, kind, pack(fv), now).run();
    const open = (await env.DB.prepare('SELECT kind, name, sites FROM wanted WHERE done_by IS NULL ORDER BY clients DESC, n DESC LIMIT 200').all()).results;
    const ft = new Set([...tokens(text), ...tokens(id.replace(/-/g, ' '))]);
    const wv = fv && open.length ? await embed(env, open.map((w) => w.name)) : null;
    open.forEach((w, i) => {
      const wt = [...new Set(tokens(w.name + ' ' + w.kind.replace(/-/g, ' ')))];
      const overlap = wt.length ? wt.filter((t) => ft.has(t)).length / wt.length : 0;
      const sim = wv ? cos(fv, wv[i]) : 0;
      if (w.kind === id || overlap >= 0.75 || sim >= (kind === 'ai' ? 0.78 : 0.8)) done.push(w.kind);
    });
    if (done.length) await env.DB.batch(done.map((k) => env.DB.prepare('UPDATE wanted SET done_by = ?2 WHERE kind = ?1').bind(k, id)));
  } catch {}
  forget();
  return reply({ id, version, ...(done.length ? { covers: done } : {}) }, 201);
}

async function getFlow(env, id, version) {
  const row = await env.DB.prepare('SELECT * FROM flows WHERE id = ?1 AND hidden = 0').bind(id).first();
  if (!row) return bad('not found', 404);
  let def = row.def;
  if (version) {
    const v = await env.DB.prepare('SELECT def FROM flow_versions WHERE id = ?1 AND version = ?2').bind(id, version).first();
    if (!v) return bad('no such version', 404);
    def = v.def;
  }
  const s = summary(row);
  return reply({ flow: JSON.parse(def), stats: { runs: s.runs, ok: s.ok, author: s.author, updated: s.updated, latest: s.version }, versions: s.version }, 200, { 'cache-control': 'public, max-age=30' });
}

async function report(env, req, id, ip) {
  if (!(await allow(env, 'rep:' + ip, 600))) return bad('too many reports this hour', 429);
  let b = {};
  try {
    b = await req.json();
  } catch {}
  const ok = b && b.ok === true ? 1 : 0;
  const r = await env.DB.prepare('UPDATE flows SET runs = runs + 1, ok = ok + ?2 WHERE id = ?1 AND hidden = 0').bind(id, ok).run();
  if (!r.meta.changes) return bad('not found', 404);
  // A phrasing that this flow did well: kept (scrubbed, at most 30 per flow) to match later tasks by meaning.
  let learned = false;
  const kind = embedKind(env);
  const text = ok && kind && typeof b.task === 'string' ? scrub(b.task) : '';
  if (text && (await allow(env, 'learn:' + ip, 120))) {
    const now = new Date().toISOString();
    const had = await env.DB.prepare('UPDATE flow_examples SET n = n + 1, updated = ?4 WHERE id = ?1 AND text = ?2 AND model = ?3').bind(id, text, kind, now).run();
    if (!had.meta.changes) {
      const v = (await embed(env, [text]))?.[0];
      if (v) {
        await env.DB.prepare('INSERT INTO flow_examples (id, text, model, vec, n, updated) VALUES (?1, ?2, ?3, ?4, 1, ?5)').bind(id, text, kind, pack(v), now).run();
        await env.DB.prepare('DELETE FROM flow_examples WHERE id = ?1 AND model = ?2 AND text NOT IN (SELECT text FROM flow_examples WHERE id = ?1 AND model = ?2 ORDER BY n DESC, updated DESC LIMIT 30)').bind(id, kind).run();
        forget();
      }
    }
    learned = true;
  }
  return reply({ ok: true, ...(learned ? { learned: true } : {}) });
}

async function remove(env, req, id) {
  const auth = req.headers.get('authorization') || '';
  const admin = env.ADMIN_TOKEN && auth === 'Bearer ' + env.ADMIN_TOKEN;
  const row = await env.DB.prepare('SELECT owner FROM flows WHERE id = ?1').bind(id).first();
  if (!row) return bad('not found', 404);
  const token = req.headers.get('x-contributor') || '';
  if (!admin && !(token && (await sha256(token)) === row.owner)) return bad('only the publisher or the admin can remove a flow', 403);
  await env.DB.prepare('UPDATE flows SET hidden = 1 WHERE id = ?1').bind(id).run();
  return reply({ ok: true });
}

const hostOf = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0].slice(0, 100);
async function readJson(req, max = 8000) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error('too large'), { status: 413 });
  try {
    return JSON.parse(t || '{}');
  } catch {
    throw Object.assign(new Error('the body must be JSON'), { status: 400 });
  }
}

// Which flow does this task? The task text is used for this answer only and not stored.
async function resolve(env, req) {
  const b = await readJson(req);
  const task = String(b.task || '').trim().slice(0, 500);
  if (!task) return bad('give {task: "what the user asked", site?: "the site they are on"}');
  const limit = Math.min(10, Math.max(1, Number(b.limit) || 5));
  const ranked = await rank(env, task, b.site, limit);
  const v = verdict(ranked[0], ranked[1], embedKind(env));
  const item = (x) => ({ ...summary(x.row), score: x.score, why: { words: x.hits, meaning: x.meaning, ...(x.example ? { like: x.example } : {}) } });
  const lead = ranked[0] ? +(ranked[0].score - (ranked[1] ? ranked[1].score : 0)).toFixed(3) : 0;
  const res = { verdict: v, best: v === 'none' ? null : item(ranked[0]), lead, candidates: ranked.filter((x) => x.score > 0.15).map(item), matching: embedKind(env) || 'words' };
  if (v === 'none') res.next = 'No flow does this yet. Do the task with your own tools; if it is repeatable, write a flow afterwards and publish it (POST /api/flows), and say it is wanted (POST /api/wanted).';
  return reply(res);
}

async function wantedAdd(env, req, ip) {
  if (!(await allow(env, 'want:' + ip, 120))) return bad('too many requests this hour', 429);
  const b = await readJson(req);
  const kind = String(b.kind || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{2,47}$/.test(kind)) return bad('kind: a short lowercase id such as "ask-chatgpt" or "youtube-search"');
  const name = scrub(String(b.name || '').slice(0, 80)).replace(/\{[a-z]+\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 3) return bad('name: a short generic title such as "Search YouTube" (no personal details)');
  const site = hostOf(b.site);
  const client = /^[A-Za-z0-9_-]{16,64}$/.test(String(b.client || '')) ? await sha256('c:' + b.client) : await sha256('ip:' + ip);
  const now = new Date().toISOString();
  const row = await env.DB.prepare('SELECT sites FROM wanted WHERE kind = ?1').bind(kind).first();
  const sites = new Set(row ? JSON.parse(row.sites) : []);
  if (site && sites.size < 5) sites.add(site);
  const fresh = (await env.DB.prepare('INSERT OR IGNORE INTO wanted_seen (kind, client) VALUES (?1, ?2)').bind(kind, client).run()).meta.changes;
  await env.DB.prepare(
    'INSERT INTO wanted (kind, name, sites, n, clients, first, last) VALUES (?1, ?2, ?3, 1, 1, ?4, ?4) ON CONFLICT (kind) DO UPDATE SET n = n + 1, clients = clients + ?5, sites = ?3, last = ?4',
  ).bind(kind, name, JSON.stringify([...sites]), now, fresh ? 1 : 0).run();
  // Already covered by a flow?
  const ranked = await rank(env, name + ' ' + kind.replace(/-/g, ' '), site, 2);
  const v = verdict(ranked[0], ranked[1], embedKind(env));
  // Covered when a flow clearly fits (a sure match, or one well ahead of the rest).
  const clear = v === 'use' || (v === 'maybe' && ranked[0].score >= 0.45 && ranked[0].score - (ranked[1] ? ranked[1].score : 0) >= 0.12);
  if (clear) await env.DB.prepare('UPDATE wanted SET done_by = ?2 WHERE kind = ?1 AND done_by IS NULL').bind(kind, ranked[0].row.id).run();
  const w = await env.DB.prepare('SELECT kind, name, sites, n, clients, done_by FROM wanted WHERE kind = ?1').bind(kind).first();
  return reply({ kind, name: w.name, n: w.n, clients: w.clients, sites: JSON.parse(w.sites), ...(w.done_by ? { coveredBy: w.done_by } : {}) });
}

async function wantedList(env, url) {
  const site = hostOf(url.searchParams.get('site'));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const all = url.searchParams.get('all') === '1';
  let rows = (await env.DB.prepare('SELECT kind, name, sites, n, clients, first, last, done_by FROM wanted' + (all ? '' : ' WHERE done_by IS NULL') + ' ORDER BY clients DESC, n DESC, last DESC LIMIT 300').all()).results;
  if (site) rows = rows.filter((r) => JSON.parse(r.sites).some((s) => s === site || site.endsWith('.' + s) || s.endsWith('.' + site)));
  return reply({ wanted: rows.slice(0, limit).map((r) => ({ kind: r.kind, name: r.name, sites: JSON.parse(r.sites), asked: r.n, people: r.clients, first: r.first, last: r.last, ...(r.done_by ? { doneBy: r.done_by } : {}) })) }, 200, { 'cache-control': 'public, max-age=30' });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    try {
      const p = url.pathname.replace(/\/+$/, '');
      if (p === '/api/health') {
        const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM flows WHERE hidden = 0').first();
        return reply({ ok: true, flows: r ? r.n : 0, format: 'voice-agent-flow/' + F.VERSION, matching: embedKind(env) || 'words' });
      }
      if (p === '/api/flows' && req.method === 'GET') {
        if (!(await allow(env, 'get:' + ip, 3000))) return bad('too many requests this hour', 429);
        return search(env, url);
      }
      if (p === '/api/flows' && req.method === 'POST') return publish(env, req, ip);
      if (p === '/api/resolve' && req.method === 'POST') {
        if (!(await allow(env, 'res:' + ip, 3000))) return bad('too many requests this hour', 429);
        return await resolve(env, req);
      }
      if (p === '/api/wanted' && req.method === 'POST') return await wantedAdd(env, req, ip);
      if (p === '/api/wanted' && req.method === 'GET') return wantedList(env, url);
      // Sites with flows (each site's flows work like a small tool set for that site), and one site's flows.
      if (p === '/api/sites') {
        const rows = (await env.DB.prepare('SELECT sites, runs, ok FROM flows WHERE hidden = 0').all()).results;
        const by = {};
        for (const r of rows) for (const s of JSON.parse(r.sites)) (by[s] ??= { site: s, flows: 0, runs: 0, ok: 0 }), by[s].flows++, (by[s].runs += r.runs), (by[s].ok += r.ok);
        return reply({ sites: Object.values(by).sort((a, b) => b.flows - a.flows) }, 200, { 'cache-control': 'public, max-age=60' });
      }
      let sm = /^\/api\/sites\/([a-z0-9.-]{3,100})$/.exec(p);
      if (sm) {
        const host = sm[1].replace(/^www\./, '');
        const rows = (await env.DB.prepare('SELECT * FROM flows WHERE hidden = 0 AND sites LIKE ?1 ORDER BY ok DESC, updated DESC LIMIT 100').bind('%' + host.split('.').slice(-2).join('.') + '%').all()).results;
        return reply({ site: host, flows: rows.filter((r) => JSON.parse(r.sites).some((s) => F.hostIn(host, s) || F.hostIn(s, host))).map(summary) }, 200, { 'cache-control': 'public, max-age=30' });
      }
      if (p === '/api/schema') return reply({ format: 'voice-agent-flow/' + F.VERSION, docs: url.origin + '/#for-agents', limits: F.LIMITS });
      let m = /^\/api\/flows\/([a-z][a-z0-9-]{1,63})(?:\/v\/(\d+))?$/.exec(p);
      if (m && req.method === 'GET') return getFlow(env, m[1], m[2] && Number(m[2]));
      if (m && req.method === 'DELETE') return remove(env, req, m[1]);
      m = /^\/api\/flows\/([a-z][a-z0-9-]{1,63})\/report$/.exec(p);
      if (m && req.method === 'POST') return report(env, req, m[1], ip);
      if (p.startsWith('/api/')) return bad('unknown endpoint', 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e && e.status) return bad(e.message, e.status);
      return bad('server error: ' + String((e && e.message) || e).slice(0, 200), 500);
    }
  },
};
