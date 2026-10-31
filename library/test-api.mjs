// Quick check of a running flow library: node test-api.mjs <address>   (e.g. http://127.0.0.1:8787 with npm run dev)
const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = 'test-' + Math.random().toString(36).slice(2) + '-token-0000';
const j = async (path, opts = {}) => {
  const r = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', 'x-contributor': token, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ok = (name, cond, info) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(info)));
const flow = { id: 'api-test-flow', name: 'API test', description: 'A flow used only to test the library API.', sites: ['example.com'], inputs: { q: { type: 'string', required: true } }, steps: [{ do: 'open', url: 'https://example.com/?q={{q}}' }, { do: 'read', as: 'text' }], output: '{{text}}' };
let r = await j('/api/health');
ok('health', r.status === 200 && r.body.ok, r);
r = await j('/api/flows', { method: 'POST', body: JSON.stringify({ flow }) });
ok('publish', r.status === 201 && r.body.version >= 1, r);
const id = r.body && r.body.id;
r = await j('/api/flows', { method: 'POST', body: JSON.stringify({ flow: { ...flow, steps: [{ do: 'open', url: 'https://evil.example.net/' }] } }) });
ok('rejects a flow that opens a site it does not list', r.status === 422, r);
r = await j('/api/flows', { method: 'POST', body: JSON.stringify({ flow }), headers: { 'x-contributor': 'nope' } });
ok('needs a contributor token', r.status === 401, r);
r = await j('/api/flows?q=api+test');
ok('search finds it', r.body.flows.some((f) => f.id === id), r);
r = await j('/api/flows/' + id + '/report', { method: 'POST', body: JSON.stringify({ ok: true }) });
ok('report', r.status === 200, r);
r = await j('/api/flows/' + id);
ok('get with stats', r.body.flow.id === id && r.body.stats.ok >= 1, r);
r = await j('/api/flows/' + id, { method: 'DELETE' });
ok('remove own flow', r.status === 200, r);
