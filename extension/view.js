// A view the agent made (show_view): sections that show a saved flow's output (run when the page opens and on
// Refresh) or data from an earlier step, as cards, a table, a list, text, stats or a bar chart. Everything from the
// web is shown as text; links and images must be http(s).
const F = globalThis.VAFlows;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};
const id = new URL(location.href).searchParams.get('id');
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '');
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const fill = (tpl, scope) => (tpl === undefined ? '' : str(F.render(String(tpl), scope, 'text')).trim());
function scopeOf(item, index) {
  if (item && typeof item === 'object' && !Array.isArray(item)) return { ...item, item, index };
  return { value: item, text: item, item, index };
}
function listOf(data, path) {
  let d = data;
  if (path) for (const k of String(path).split('.')) d = d && typeof d === 'object' ? d[k] : undefined;
  if (d === undefined && Array.isArray(data)) d = data; // a path into a result that is already the list
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.items)) return d.items;
  return d === undefined || d === null ? [] : [d];
}
const link = (text, url) => {
  const u = safeUrl(url);
  if (!u) return el('span', '', text);
  const a = el('a', '', text || u);
  a.href = u;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
};
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[,\s]/g, '').replace(/^[^\d.-]+/, ''));
  return Number.isFinite(n) ? n : NaN;
};
// Text with light formatting: "- " bullets, **bold**, and links.
function richText(text) {
  const box = el('div', 'text');
  let ul = null;
  for (const line of String(text).split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const target = bullet ? (ul ||= box.appendChild(el('ul'))).appendChild(el('li')) : (ul = null, box.appendChild(el('div')));
    for (const part of (bullet ? bullet[1] : line).split(/(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g)) {
      if (!part) continue;
      if (/^\*\*.*\*\*$/.test(part)) target.append(el('strong', '', part.slice(2, -2)));
      else if (/^https?:\/\//.test(part)) target.append(link(part, part));
      else target.append(document.createTextNode(part));
    }
    if (!bullet && !line) target.append(document.createElement('br'));
  }
  return box;
}
function render(layout, data, path) {
  const L = layout || {};
  const items = listOf(data, path);
  switch (L.kind) {
    case 'cards': {
      const g = el('div', 'cards');
      items.slice(0, 60).forEach((it, i) => {
        const s = scopeOf(it, i);
        const c = el('div', 'card');
        const img = safeUrl(fill(L.image, s));
        if (img) {
          const im = el('img');
          im.src = img;
          im.loading = 'lazy';
          im.alt = '';
          c.append(im);
        }
        const inner = el('div', 'in');
        const t = el('div', 't');
        t.append(link(fill(L.title || '{{title}}', s), fill(L.link, s)));
        inner.append(t);
        if (L.subtitle) inner.append(el('div', 's', fill(L.subtitle, s)));
        if (L.body) inner.append(el('div', 'b', fill(L.body, s)));
        c.append(inner);
        g.append(c);
      });
      return g;
    }
    case 'table': {
      const cols = Array.isArray(L.columns) && L.columns.length ? L.columns : Object.keys(items.find((x) => x && typeof x === 'object') || { value: 1 }).filter((k) => k !== 'index').slice(0, 8).map((k) => ({ label: k, value: '{{' + k + '}}' }));
      const wrap = el('div', 'tablewrap');
      const t = el('table');
      const hr = el('tr');
      cols.forEach((c) => hr.append(el('th', '', c.label || '')));
      t.append(hr);
      items.slice(0, 200).forEach((it, i) => {
        const s = scopeOf(it, i);
        const tr = el('tr');
        cols.forEach((c, k) => {
          const td = el('td');
          const v = fill(c.value, s);
          td.append(k === 0 && L.link ? link(v, fill(L.link, s)) : document.createTextNode(v));
          tr.append(td);
        });
        t.append(tr);
      });
      wrap.append(t);
      return wrap;
    }
    case 'list': {
      const ul = el('ul', 'list');
      items.slice(0, 200).forEach((it, i) => {
        const s = scopeOf(it, i);
        const li = el('li');
        li.append(link(fill(L.text || '{{title}}', s), fill(L.link, s)));
        if (L.note) li.append(el('span', 'n', fill(L.note, s)));
        ul.append(li);
      });
      return ul;
    }
    case 'text': {
      const obj = path ? listOf(data, path)[0] : data;
      return richText(fill(L.text || '{{value}}', scopeOf(obj, 0)));
    }
    case 'stats': {
      const g = el('div', 'stats');
      const obj = path ? listOf(data, path)[0] : data;
      const s = scopeOf(obj, 0);
      s.count = items.length;
      for (const it of (L.items || []).slice(0, 12)) {
        const b = el('div', 'stat');
        b.append(el('div', 'k', it.label || ''), el('div', 'v', fill(it.value, s)));
        g.append(b);
      }
      return g;
    }
    case 'bar': {
      const rows = items.slice(0, 40).map((it, i) => {
        const s = scopeOf(it, i);
        return { label: fill(L.label || '{{title}}', s), shown: fill(L.value, s), n: num(fill(L.value, s)) };
      });
      const max = Math.max(...rows.map((r) => (Number.isFinite(r.n) ? r.n : 0)), 1);
      const g = el('div', 'bars');
      for (const r of rows) {
        const row = el('div', 'barrow');
        const track = el('div', 'track');
        const fillEl = el('div', 'fill');
        fillEl.style.width = Math.max(1, Math.round(((Number.isFinite(r.n) ? r.n : 0) / max) * 100)) + '%';
        track.append(fillEl);
        row.append(el('div', 'l', r.label), track, el('div', 'v', r.shown));
        row.title = r.label;
        g.append(row);
      }
      return g;
    }
  }
  return el('pre', '', JSON.stringify(data, null, 1).slice(0, 4000));
}
async function load(refresh) {
  const r = await chrome.storage.local.get(['va.views', 'va.viewCache']);
  const view = (r['va.views'] || {})[id];
  if (!view) {
    $('title').textContent = 'This view no longer exists';
    return;
  }
  document.title = view.title + ' · Voice Agent';
  $('title').textContent = view.title;
  const cache = (r['va.viewCache'] || {})[id] || {};
  const box = $('sections');
  box.textContent = '';
  const jobs = view.sections.map(async (s, i) => {
    const sec = el('section', 'sec');
    if (s.title) sec.append(el('h2', '', s.title));
    const body = el('div');
    sec.append(body);
    box.append(sec);
    if (s.data !== undefined) return body.append(render(s.layout, s.data, s.path));
    if (cache[i] && !refresh) body.append(render(s.layout, cache[i].output, s.path));
    const st = el('div', 'status', (cache[i] ? 'Updating' : 'Running') + ' “' + s.source.flow + '”…');
    sec.append(st);
    const res = await chrome.runtime.sendMessage({ type: 'va.viewRun', flow: s.source.flow, input: s.source.input || {} }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    st.remove();
    if (!res || !res.ok) return sec.append(el('div', 'err', 'Could not run “' + s.source.flow + '”: ' + ((res && res.error) || 'no answer')));
    body.textContent = '';
    body.append(render(s.layout, res.output, s.path));
    cache[i] = { output: res.output, at: new Date().toISOString() };
  });
  await Promise.all(jobs);
  const all = (await chrome.storage.local.get('va.viewCache'))['va.viewCache'] || {};
  all[id] = cache;
  const ids = Object.keys(all);
  if (ids.length > 40) for (const k of ids.slice(0, ids.length - 40)) delete all[k];
  await chrome.storage.local.set({ 'va.viewCache': all });
  $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
$('refresh').onclick = () => load(true);
load(false);
