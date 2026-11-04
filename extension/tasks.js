// Voice Agent Tasks page (added): running tasks with their questions, recent tasks with why they ended and what they
// cost, total spending by model, the prices used, and the Windows-notification setting.
const $ = (id) => document.getElementById(id);
const ui = globalThis.vaUI;
const since = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
};
const plain = (s) => String(s || '').replace(/```[a-z]*\n?/gi, '').replace(/[*_#>`]+/g, '').replace(/\n{3,}/g, '\n\n').trim();
const ICON = { done: '✓', failed: '✕', skipped: '–', waiting: '?', running: '…' };
const STATUS = { done: 'Finished', failed: 'Stopped before finishing', stopped: 'Stopped by you', working: 'Running' };
const DEFAULT_PRICES = { 'muse-wonder': { in: 4, cached: 0.2, out: 20 }, 'muse-spark': { in: 1.25, cached: 0.15, out: 4.25 }, asrPerHour: 0.18 };
let state = { prompts: {}, cost: { usd: 0, byTask: {}, byModel: {} } };
let built = '';

async function render(force) {
  const r = await chrome.storage.local.get(['voice.activity', 'voice.pending-tasks', 'va.ui.osNotice', 'va.prompts', 'va.cost', 'va.taskEnds', 'va.prices', 'va.progress']);
  const acts = Array.isArray(r['voice.activity']) ? r['voice.activity'] : [];
  const names = r['voice.pending-tasks'] || {};
  const prompts = r['va.prompts'] || {};
  const cost = r['va.cost'] || { usd: 0, byTask: {}, byModel: {} };
  const ends = r['va.taskEnds'] || {};
  const progress = r['va.progress'] || {};
  state = { prompts, cost, progress };
  const name = (a) => (names[a.id] || a.text || 'A task').trim();
  const tabOf = (a) => a.taskTab ?? (a.tabs && a.tabs[0] && a.tabs[0].id);
  const running = acts.filter((a) => (a.status === 'working' && Date.now() - Date.parse(a.at) < 3 * 3600e3) || prompts[a.id]);
  const recent = acts.filter((a) => a.status !== 'working' && !prompts[a.id]).slice(0, 20);
  $('osNotice').checked = r['va.ui.osNotice'] === true;
  renderCost(cost, r['va.prices']);

  const sig = JSON.stringify([running.map((a) => [a.id, name(a)]), prompts, recent.map((a) => [a.id, a.status, ends[a.id] && ends[a.id].at, cost.byTask && cost.byTask[a.id] && cost.byTask[a.id].steps]), ui.state()]);
  if (!force && sig === built) return tick();
  built = sig;
  const active = document.activeElement;
  const focusKey = ui.takeFocus() || (active && active.dataset ? active.dataset.key : null);

  $('running').textContent = '';
  if (!running.length) $('running').append(ui.el('p', 'empty', 'Nothing is running. Hold the mouse on any page and speak to start a task.'));
  for (const a of running) {
    const tab = tabOf(a);
    const el = ui.el('div', 'task');
    el.append(ui.el('div', 'name', name(a)));
    const meta = ui.el('div', 'meta');
    meta.dataset.at = a.at;
    meta.dataset.id = a.id;
    el.append(meta);
    for (const p of prompts[a.id] || []) el.append(ui.promptCard(p));
    const steps = ui.el('ol', 'steps');
    steps.dataset.id = a.id;
    el.append(steps);
    const row = ui.el('div', 'row');
    const openB = ui.button('Open chat', 'primary', () => {
      // An extension page can open the side panel itself, inside the click.
      if (tab === undefined) return;
      chrome.sidePanel.setOptions({ tabId: tab, path: 'sidepanel.html', enabled: true });
      chrome.sidePanel.open({ tabId: tab }).catch(() => ui.send({ type: 'voice.openPanel', taskTabId: tab }));
      chrome.tabs.update(tab, { active: true }).catch(() => {});
    });
    const stopB = ui.button('Stop', 'stop', () => {
      stopB.textContent = 'Stopping…';
      stopB.disabled = true;
      ui.send({ type: 'voice.stopTask', taskTabId: tab });
    });
    row.append(openB, stopB);
    el.append(row);
    el.append(
      ui.textBox('t:' + a.id, {
        placeholder: 'Tell it something, or give it the next step',
        label: 'Message for this task',
        onSend: async (text, st) => {
          const res = await ui.send({ type: 'va.followUp', conversationId: a.id, taskTabId: tab, text });
          st.textContent = res && res.ok === false ? res.error || 'Could not send.' : 'Sent. It will read this at its next step.';
          setTimeout(() => (st.textContent = ''), 4000);
        },
      }),
    );
    $('running').append(el);
  }

  $('recent').textContent = '';
  if (!recent.length) $('recent').append(ui.el('p', 'empty', 'No finished tasks yet.'));
  for (const a of recent) {
    const el = ui.el('div', 'task');
    el.append(ui.el('div', 'name', name(a)));
    const meta = ui.el('div', 'meta');
    const badge = ui.el('span', 'badge', STATUS[a.status] || a.status);
    const t = cost.byTask && cost.byTask[a.id];
    meta.append(badge, ' ' + new Date(a.at).toLocaleString() + (t ? ' · ' + ui.usd(t.usd) + ' · ' + t.steps + ' steps' : ''));
    el.append(meta);
    const end = ends[a.id];
    if (end && (end.reason || end.summary)) {
      // Why it stopped (or what it answered), as plain text, folded to four lines.
      const text = [end.reason && a.status !== 'done' ? 'Why: ' + end.reason : '', end.summary ? (a.status === 'done' ? '' : 'The agent said: ') + plain(end.summary) : ''].filter(Boolean).join('\n\n');
      const why = ui.el('div', 'why', text);
      const toggle = ui.el('a', 'toggle', 'Show all');
      toggle.onclick = () => {
        why.classList.toggle('open');
        toggle.textContent = why.classList.contains('open') ? 'Show less' : 'Show all';
      };
      el.append(why);
      if (text.length > 260 || text.split('\n').length > 4) el.append(toggle);
    }
    $('recent').append(el);
  }
  tick();
  if (focusKey) {
    const input = [...document.querySelectorAll('input[type=text]')].find((i) => i.dataset.key === focusKey);
    if (input) input.focus();
  }
}

function tick() {
  for (const ol of document.querySelectorAll('#running ol.steps[data-id]')) {
    const p = state.progress && state.progress[ol.dataset.id];
    ol.textContent = '';
    for (const st of ((p && p.steps) || []).slice(-8)) {
      const li = ui.el('li', st.status || 'running');
      const lab = ui.el('span', 'lab', st.label);
      if (st.detail) lab.append(ui.el('span', 'det', st.detail));
      li.append(ui.el('span', 'ico', ICON[st.status] || '…'), lab);
      ol.append(li);
    }
  }
  for (const m of document.querySelectorAll('#running .meta[data-at]')) {
    const t = state.cost.byTask && state.cost.byTask[m.dataset.id];
    m.textContent = (state.prompts[m.dataset.id] ? 'Waiting for your answer · ' : 'Running for ' + since(m.dataset.at) + ' · ') + ui.usd(t ? t.usd : 0) + ' so far';
  }
}

// Today's numbers in the same terms as Meta's usage page (dev.meta.ai → Usage), so the two can be compared.
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
function renderToday(cost) {
  const d = new Date();
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const t = (cost.byDay || {})[key] || { usd: 0, calls: 0, in: 0, cached: 0, out: 0, reasoning: 0 };
  const box = $('today');
  box.textContent = '';
  const cell = (k, v) => {
    const c = ui.el('div');
    c.append(ui.el('div', 'k', k), ui.el('div', 'v', v));
    box.append(c);
  };
  cell('Today', ui.usd(t.usd));
  cell('Input tokens', fmt(t.in));
  cell('Cache hit rate', t.in ? Math.round((100 * t.cached) / t.in) + '%' : '–');
  cell('Output tokens', fmt(t.out));
  const w = ui.el('div', 'wide');
  w.append(t.calls + ' calls to Meta today' + (t.in && t.calls ? ', about ' + fmt(Math.round(t.in / t.calls)) + ' input tokens each' : '') + '. Meta\'s own numbers: ');
  const a = ui.el('a', 'link', 'dev.meta.ai → Usage');
  a.href = 'https://dev.meta.ai/usage';
  a.target = '_blank';
  w.append(a, ' (its days follow its own clock, so totals near midnight can differ).');
  box.append(w);
}
function renderCost(cost, savedPrices) {
  renderToday(cost);
  $('total').textContent = ui.usd(cost.usd || 0);
  $('since').textContent = cost.since ? 'Since ' + new Date(cost.since).toLocaleString() + ' · ' + (cost.calls || 0) + ' calls to Meta' : 'Nothing used yet.';
  const t = $('byModel');
  t.textContent = '';
  const rows = Object.entries(cost.byModel || {}).sort((a, b) => b[1].usd - a[1].usd);
  if (rows.length) {
    const h = t.insertRow();
    for (const [txt, n] of [['Model', 0], ['Calls', 1], ['Input tokens', 1], ['Output tokens', 1], ['Cost', 1]]) {
      const th = document.createElement('th');
      th.textContent = txt;
      if (n) th.className = 'n';
      h.append(th);
    }
    for (const [m, b] of rows) {
      const tr = t.insertRow();
      const cells = [m, String(b.calls), b.seconds ? Math.round(b.seconds) + ' s audio' : b.in.toLocaleString(), b.seconds ? '' : b.out.toLocaleString(), ui.usd(b.usd)];
      cells.forEach((v, i) => {
        const td = tr.insertCell();
        td.textContent = v;
        if (i) td.className = 'n';
      });
    }
  }
  if (!$('prices').childNodes.length || !document.querySelector('#prices input:focus')) renderPrices({ ...DEFAULT_PRICES, ...(savedPrices || {}) });
}

function renderPrices(p) {
  const box = $('prices');
  box.textContent = '';
  for (const h of ['', 'Input', 'Cached input', 'Output']) box.append(ui.el('strong', '', h));
  for (const [k, label] of [['muse-wonder', 'Muse Wonder ($ per million tokens)'], ['muse-spark', 'Muse Spark ($ per million tokens)']]) {
    box.append(ui.el('span', '', label));
    for (const f of ['in', 'cached', 'out']) {
      const i = document.createElement('input');
      i.type = 'number';
      i.min = '0';
      i.step = '0.01';
      i.value = String(p[k][f]);
      i.dataset.k = k;
      i.dataset.f = f;
      i.setAttribute('aria-label', label + ' ' + f);
      box.append(i);
    }
  }
  box.append(ui.el('span', '', 'Voice transcription ($ per hour of audio)'));
  const a = document.createElement('input');
  a.type = 'number';
  a.min = '0';
  a.step = '0.01';
  a.value = String(p.asrPerHour);
  a.dataset.k = 'asrPerHour';
  a.setAttribute('aria-label', 'Voice transcription price per hour');
  box.append(a, ui.el('span'), ui.el('span'));
}

$('savePrices').onclick = async () => {
  const p = JSON.parse(JSON.stringify(DEFAULT_PRICES));
  for (const i of document.querySelectorAll('#prices input')) {
    const v = Number(i.value);
    if (!Number.isFinite(v) || v < 0) continue;
    if (i.dataset.k === 'asrPerHour') p.asrPerHour = v;
    else p[i.dataset.k][i.dataset.f] = v;
  }
  await chrome.storage.local.set({ 'va.prices': p });
  $('savePrices').textContent = 'Saved (applies to new calls)';
  setTimeout(() => ($('savePrices').textContent = 'Save prices'), 2500);
};
$('resetPrices').onclick = async () => {
  await chrome.storage.local.remove('va.prices');
  renderPrices(DEFAULT_PRICES);
};
$('resetCost').onclick = async () => {
  await ui.send({ type: 'va.resetCost' });
  render(true);
};
for (const [id, key] of [['strongModel', 'va.ui.strongModel'], ['allTools', 'va.ui.allTools'], ['fullHistory', 'va.ui.fullHistory']]) {
  $(id).onchange = (e) => chrome.storage.local.set({ [key]: e.target.checked });
  chrome.storage.local.get(key).then((r) => ($(id).checked = r[key] === true));
}
$('suggestAutomate').onchange = (e) => chrome.storage.local.set({ 'va.ui.suggestAutomate': e.target.checked });
chrome.storage.local.get('va.ui.suggestAutomate').then((r) => ($('suggestAutomate').checked = r['va.ui.suggestAutomate'] !== false));
$('allowHistory').onchange = async (e) => {
  const on = e.target.checked;
  if (on) {
    const ok = await chrome.permissions.request({ permissions: ['history'] }).catch(() => false);
    if (!ok) {
      e.target.checked = false;
      $('histHint').textContent = 'Browser history needs permission; allow it to turn this on.';
      return;
    }
  }
  await chrome.storage.local.set({ 'va.allowHistory': on });
};
chrome.storage.local.get('va.allowHistory').then((r) => ($('allowHistory').checked = r['va.allowHistory'] === true));
$('osNotice').onchange = async (e) => {
  const on = e.target.checked;
  if (on) {
    // Asked inside the click, the only moment Chrome accepts it.
    const ok = await chrome.permissions.request({ permissions: ['notifications'] }).catch(() => false);
    if (!ok) {
      e.target.checked = false;
      $('osHint').textContent = 'Windows notifications need permission; allow it to turn this on.';
      return;
    }
  }
  await chrome.storage.local.set({ 'va.ui.osNotice': on });
  ui.send({ type: 'va.refreshRunningNotice' });
};
ui.setRerender((force) => render(force));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['voice.activity'] || ch['voice.pending-tasks'] || ch['va.prompts'] || ch['va.cost'] || ch['va.taskEnds'] || ch['va.progress'])) render();
});
render(true);
setInterval(tick, 1000);

// ---------- Flows ----------
async function renderFlows() {
  const r = await chrome.storage.local.get(['va.flows', 'va.flows.repo', 'va.flows.online', 'va.flows.author']);
  const flows = Object.values(r['va.flows'] || {}).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  const repo = r['va.flows.repo'] || '';
  if (document.activeElement !== $('repo')) $('repo').value = repo;
  if (document.activeElement !== $('author')) $('author').value = r['va.flows.author'] || '';
  $('flowsOnline').checked = r['va.flows.online'] !== false;
  $('repoState').textContent = repo ? '· ' + repo.replace(/^https?:\/\//, '') : '· not set up';
  const box = $('flows');
  box.textContent = '';
  if (!flows.length) box.append(ui.el('p', 'empty', 'No flows yet. After a task you repeat, say “make this a flow”.'));
  for (const rec of flows) {
    const f = rec.flow || {};
    const d = ui.el('div', 'flow');
    const top = ui.el('div', 'top');
    top.append(ui.el('strong', '', f.name || f.id), ui.el('span', 'id', f.id + ' · v' + (f.version || 1)));
    const chips = ui.el('div', 'row');
    const chip = (t, c) => chips.append(ui.el('span', 'chip' + (c ? ' ' + c : ''), t));
    chip((f.sites || []).join(', ') || 'no site');
    const ins = Object.keys(f.inputs || {});
    chip(ins.length ? 'inputs: ' + ins.join(', ') : 'no inputs');
    if (rec.source === 'online') chip('from the library');
    if (rec.shared) chip('shared ' + new Date(rec.shared.at).toLocaleDateString(), 'ok');
    if (rec.runs) chip(rec.ok + ' of ' + rec.runs + ' runs worked', rec.ok === rec.runs ? 'ok' : 'bad');
    else chip(rec.tested ? 'tested when saved' : 'not run yet');
    d.append(top, ui.el('div', 'meta', f.description || ''), chips);
    if (rec.lastError && rec.fail) d.append(ui.el('div', 'status', 'Last failure: ' + rec.lastError));
    const det = ui.el('details', '');
    det.append(ui.el('summary', 'link muted', 'Steps'), ui.el('pre', 'fjson', JSON.stringify(f, null, 1)));
    const acts = ui.el('div', 'acts');
    const sameShared = rec.shared && (rec.shared.localVersion || 1) === (f.version || 1);
    if (rec.source !== 'online' && sameShared) {
      const done = ui.button('Shared ✓', '', () => {});
      done.disabled = true;
      acts.append(done);
    } else if (rec.source !== 'online')
      acts.append(
        ui.button(rec.shared ? 'Share the new version' : 'Share online', '', async (b) => {
          if (!repo) return (b.textContent = 'Set the library address first');
          b.disabled = true;
          b.textContent = 'Sharing…';
          const res = await ui.send({ type: 'va.flowShare', id: f.id });
          b.textContent = res && res.ok ? 'Shared as ' + res.id + ' v' + res.version : 'Not shared: ' + ((res && res.error) || 'no answer');
        }),
      );
    acts.append(
      ui.button('Delete', 'stop', async (b) => {
        if (b.dataset.sure !== '1') return ((b.dataset.sure = '1'), (b.textContent = 'Press again to delete'));
        await ui.send({ type: 'va.flowDelete', id: f.id });
        renderFlows();
      }),
    );
    d.append(det, acts);
    box.append(d);
  }
}
$('saveRepo').onclick = async () => {
  const v = $('repo').value.trim().replace(/\/+$/, '');
  if (v && !/^https:\/\/[^\s/]+/.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(v)) return ($('repoMsg').textContent = 'Use an https:// address');
  if (v) {
    const ok = await chrome.permissions.contains({ origins: [new URL(v).origin + '/*'] }).catch(() => true);
    if (!ok) await chrome.permissions.request({ origins: [new URL(v).origin + '/*'] }).catch(() => false);
  }
  await chrome.storage.local.set({ 'va.flows.repo': v, 'va.flows.author': $('author').value.trim().slice(0, 40) });
  $('repoMsg').textContent = 'Saved';
};
$('testRepo').onclick = async () => {
  $('repoMsg').textContent = 'Checking…';
  const r = await ui.send({ type: 'va.flowTestRepo' });
  $('repoMsg').textContent = r && r.ok ? 'Connected: ' + (r.flows ?? '?') + ' flows in the library' : 'Not reachable: ' + ((r && r.error) || 'no answer');
};
$('flowsOnline').onchange = (e) => chrome.storage.local.set({ 'va.flows.online': e.target.checked });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['va.flows'] || ch['va.flows.repo'] || ch['va.flows.online'])) renderFlows();
});
renderFlows();

// ---------- Apps on this computer (MCP) ----------
const MCP_STATES = { off: 'off', 'needs-code': 'paste the pairing code', waiting: 'waiting for an app', connected: '● connected', 'wrong-code': 'pairing code does not match' };
async function renderMcp() {
  const r = await chrome.storage.local.get(['va.mcp.enabled', 'va.mcp.code', 'va.mcp.allowSave', 'va.mcp.state', 'va.mcp.log']);
  if (document.activeElement !== $('mcpCode')) $('mcpCode').value = r['va.mcp.code'] || '';
  $('mcpEnabled').checked = r['va.mcp.enabled'] === true;
  $('mcpAllowSave').checked = r['va.mcp.allowSave'] === true;
  const st = r['va.mcp.state'] || { state: 'off' };
  $('mcpState').textContent = '· ' + (MCP_STATES[st.state] || st.state);
  $('mcpMsg').textContent = st.state !== 'connected' && st.error ? st.error : '';
  // The server file ships in the extension's mcp folder; its full path depends on where the extension was unpacked.
  const folder = 'D:\\UserData\\Downloads\\voice-agent-test (3)\\mcp\\voice-agent-mcp.mjs';
  $('mcpHow').textContent =
    'Claude Code (any terminal):\n  claude mcp add voice-agent -- node "' + folder + '"\n\n' +
    'Claude Desktop (Settings → Developer → Edit config), inside "mcpServers":\n  "voice-agent": { "command": "node", "args": [' + JSON.stringify(folder) + '] }\n\n' +
    'Pairing code (paste above):\n  node "' + folder + '" --pairing-code\n\n' +
    'Other apps (HTTP): POST http://127.0.0.1:17345/mcp with header\n  Authorization: Bearer <pairing code>\n\n' +
    '(If the extension folder is somewhere else, use that path.)';
  const box = $('mcpLog');
  box.textContent = '';
  const log = Array.isArray(r['va.mcp.log']) ? r['va.mcp.log'] : [];
  if (log.length) {
    box.append(ui.el('div', 'meta', 'Recent requests from apps'));
    const t = document.createElement('table');
    for (const e of log.slice(0, 10)) {
      const tr = document.createElement('tr');
      for (const v of [new Date(e.at).toLocaleTimeString(), e.client, e.action + ' ' + (e.flow || ''), e.ok ? '✓ ' + Math.round(e.ms / 100) / 10 + ' s' : '✕ ' + String(e.error || '').replace(/^error:\s*/, '').replace(/^flow \S+ failed:\s*/, '').split('\n')[0].slice(0, 90)]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      t.append(tr);
    }
    box.append(t);
  }
}
$('mcpSave').onclick = async () => {
  const code = $('mcpCode').value.trim();
  if ($('mcpEnabled').checked && !/^va-[a-z0-9-]{10,}$/.test(code)) return ($('mcpMsg').textContent = 'Paste the pairing code first (it starts with va-).');
  await chrome.storage.local.set({ 'va.mcp.enabled': $('mcpEnabled').checked, 'va.mcp.code': code, 'va.mcp.allowSave': $('mcpAllowSave').checked });
  $('mcpMsg').textContent = 'Saved';
};
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['va.mcp.state'] || ch['va.mcp.log'] || ch['va.mcp.enabled'])) renderMcp();
});
renderMcp();

// ---------- Suggested flows, views, memory ----------
async function renderMore() {
  const r = await chrome.storage.local.get(['va.patterns', 'va.views', 'va.memory', 'va.memory.mode', 'va.flows.auto', 'va.flows.learn', 'va.autoFlows']);
  $('autoFlows').checked = r['va.flows.auto'] !== false;
  $('flowLearn').checked = r['va.flows.learn'] !== false;
  const made = (r['va.autoFlows'] || []).slice(-5).reverse();
  $('autoLog').textContent = made.length
    ? 'Recently: ' + made.map((x) => (x.how === 'library' ? '“' + x.kind + '” → ' + x.id + ' from the library' : '“' + x.kind + '” → an agent wrote a flow') + ' (' + new Date(x.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ')').join('; ')
    : '';
  const pats = Object.values(r['va.patterns'] || {}).filter((p) => p.suggest).sort((a, b) => b.count - a.count);
  const pb = $('patterns');
  pb.textContent = '';
  if (!pats.length) pb.append(ui.el('p', 'empty', 'Nothing yet. When you do the same kind of task a few times, it shows up here so the agent can make it a one-step flow.'));
  for (const p of pats) {
    const d = ui.el('div', 'flow');
    d.append(ui.el('strong', '', p.name), ui.el('div', 'meta', 'You did this ' + p.count + ' times' + (p.sites && p.sites.length ? ' on ' + p.sites.join(', ') : '') + '. For example: “' + (p.examples[0] || '') + '”'));
    const acts = ui.el('div', 'acts');
    acts.append(
      ui.button('Make it a flow', 'primary', async (b) => {
        b.disabled = true;
        b.textContent = 'Asking the agent…';
        const res = await ui.send({ type: 'va.patternFlow', kind: p.kind });
        b.textContent = res && res.ok ? 'The agent is making it (see Running now)' : 'Could not start: ' + ((res && res.error) || 'no answer');
      }),
      ui.button('Not now', 'ghost', () => ui.send({ type: 'va.patternDismiss', kind: p.kind })),
    );
    d.append(acts);
    pb.append(d);
  }
  const views = Object.values(r['va.views'] || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const vb = $('views');
  vb.textContent = '';
  if (!views.length) vb.append(ui.el('p', 'empty', 'No views yet.'));
  for (const v of views) {
    const d = ui.el('div', 'memrow');
    const a = ui.el('a', 'link', v.title);
    a.href = chrome.runtime.getURL('view.html?id=' + v.id);
    a.target = '_blank';
    const what = v.sections.map((s) => (s.source && s.source.flow ? s.source.flow : 'saved data') + ' as ' + (s.layout && s.layout.kind)).join(', ');
    d.append(a, ui.el('span', 'meta', what), ui.button('Delete', 'ghost', () => ui.send({ type: 'va.viewDelete', id: v.id })));
    vb.append(d);
  }
  if (document.activeElement !== $('memMode')) $('memMode').value = r['va.memory.mode'] || 'ask';
  const mb = $('memList');
  mb.textContent = '';
  const mem = Array.isArray(r['va.memory']) ? r['va.memory'] : [];
  if (!mem.length) mb.append(ui.el('p', 'empty', 'Nothing remembered yet.'));
  for (const m of mem) {
    const d = ui.el('div', 'memrow');
    d.append(ui.el('span', '', m.fact), ui.el('span', 'meta', m.from === 'you' ? 'added by you' : new Date(m.at).toLocaleDateString()), ui.button('Forget', 'ghost', () => ui.send({ type: 'va.memoryDelete', id: m.id })));
    mb.append(d);
  }
}
$('memMode').onchange = (e) => chrome.storage.local.set({ 'va.memory.mode': e.target.value });
$('memAdd').onsubmit = async (e) => {
  e.preventDefault();
  const v = $('memFact').value.trim();
  if (!v) return;
  const r = await ui.send({ type: 'va.memoryAdd', fact: v });
  $('memFact').value = '';
  if (r && r.saved === false) $('memFact').placeholder = r.reason || 'Not saved';
};
$('autoFlows').onchange = () => chrome.storage.local.set({ 'va.flows.auto': $('autoFlows').checked });
$('flowLearn').onchange = () => chrome.storage.local.set({ 'va.flows.learn': $('flowLearn').checked });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['va.patterns'] || ch['va.views'] || ch['va.memory'] || ch['va.memory.mode'] || ch['va.autoFlows'] || ch['va.flows.auto'] || ch['va.flows.learn'])) renderMore();
});
renderMore();
