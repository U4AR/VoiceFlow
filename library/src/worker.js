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
import './flows-core.js';

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
  return reply({ id, version }, 201);
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
  return r.meta.changes ? reply({ ok: true }) : bad('not found', 404);
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    try {
      const p = url.pathname.replace(/\/+$/, '');
      if (p === '/api/health') {
        const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM flows WHERE hidden = 0').first();
        return reply({ ok: true, flows: r ? r.n : 0, format: 'voice-agent-flow/' + F.VERSION });
      }
      if (p === '/api/flows' && req.method === 'GET') {
        if (!(await allow(env, 'get:' + ip, 3000))) return bad('too many requests this hour', 429);
        return search(env, url);
      }
      if (p === '/api/flows' && req.method === 'POST') return publish(env, req, ip);
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
      return bad('server error: ' + String((e && e.message) || e).slice(0, 200), 500);
    }
  },
};
