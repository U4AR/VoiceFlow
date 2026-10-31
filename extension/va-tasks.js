// Voice Agent: your agents on every page (added).
//  - A round button always sits at the bottom right of every page. Its look says what is going on (idle; a spinning
//    ring while agents work; amber with a count when one needs your answer; green or red briefly when one ends) and
//    is the same on every tab.
//  - Clicking it opens the panel above it; clicking it again (it shows a ✕ while open) closes it. Open/closed and
//    which chat is showing are shared by all tabs, so switching tabs does not change it.
//  - The panel lists your agents (running, then earlier ones); click one for its chat: your messages, its replies,
//    its steps folded into one line, any question it is waiting on, and a box to talk to it (type, speak, or point at
//    something on the page as the answer). Finished tasks can show "Worth automating?" with Automate it.
//  - On a tab the agent is driving, the open panel lets clicks pass through (so it never blocks the agent) until the
//    agent needs you.
// The popup is in the page's top layer, hidden from the agent's page reading, and va-guard.js keeps the page from
// stealing its clicks and keys. Data: voice.activity, va.progress, va.prompts, va.cost, va.taskEnds, va.agentTabs,
// va.ui.panel; chats come from the worker (va.chat). Cards and the answer box come from va-prompt-ui.js.
(() => {
  if (window.top !== window || globalThis.__vaTasks || !globalThis.vaUI) return;
  globalThis.__vaTasks = true;
  const ui = globalThis.vaUI;
  const el = ui.el;
  const span = (cls, text) => el('span', cls, text);
  const STALE_MS = 3 * 3600e3;
  const EARLIER_MS = 12 * 3600e3;
  const FLASH_MS = 15000;

  const host = document.createElement('voice-agent-tasks');
  host.style.cssText = 'position:fixed;inset:auto;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647;display:block;';
  const topLayer = typeof host.showPopover === 'function';
  if (topLayer) host.setAttribute('popover', 'manual');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    .ui { --bg: #ffffff; --bg2: #f3f5f4; --bg3: #e7ecea; --ink: #17222a; --muted: #5b6a71; --faint: #8d999e; --line: #e2e7e5;
          --accent: #0f7b6c; --accent-ink: #fff; --me: #0f7b6c; --me-ink: #fff; --warn: #b4472f; --ask: #fff6e3; --ask-line: #e8b25a;
          --ask-ink: #7a4d00; --ok: #1f8f4e; --gold: #b07800; --shadow: 0 18px 50px rgba(15, 28, 36, .22), 0 2px 8px rgba(15, 28, 36, .08);
          font: 13.5px/1.45 system-ui, 'Segoe UI', Roboto, sans-serif; color: var(--ink); }
    @media (prefers-color-scheme: dark) {
      .ui { --bg: #172229; --bg2: #1f2d35; --bg3: #2a3b45; --ink: #e7eeeb; --muted: #a2b1b6; --faint: #7b8b91; --line: #2c3d46;
            --accent: #36b9a4; --accent-ink: #062520; --me: #1e6f62; --me-ink: #eafffa; --warn: #ff9b80; --ask: #33290f;
            --ask-line: #a8812e; --ask-ink: #ffd88f; --ok: #6fd69a; --gold: #ffcf6b; --shadow: 0 18px 50px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 50% { opacity: .35; } }

    /* The round button, bottom right */
    .fab { position: fixed; right: 20px; bottom: 20px; width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--line);
           background: var(--bg); box-shadow: var(--shadow); cursor: pointer; display: grid; place-items: center; padding: 0; color: var(--accent);
           transition: transform .12s ease; }
    .fab:hover { transform: scale(1.05); }
    .fab svg.ring { position: absolute; inset: -4px; width: 60px; height: 60px; }
    .fab .ring circle { fill: none; stroke-width: 3; }
    .fab .ring .arc { stroke: transparent; transform-origin: 30px 30px; stroke-linecap: round; }
    .fab.run .ring .arc { stroke: var(--accent); stroke-dasharray: 46 140; animation: spin 1.1s linear infinite; }
    .fab.wait { background: var(--ask); border-color: var(--ask-line); color: var(--ask-ink); }
    .fab.wait .ring .arc { stroke: #e9a23b; stroke-dasharray: 200 0; animation: pulse 1.2s ease-in-out infinite; }
    .fab.ok .ring .arc { stroke: var(--ok); stroke-dasharray: 200 0; }
    .fab.bad .ring .arc { stroke: var(--warn); stroke-dasharray: 200 0; }
    .fab .glyph { width: 24px; height: 24px; }
    .fab.open { background: var(--ink); color: var(--bg); border-color: var(--ink); }
    .fab .count { position: absolute; top: -5px; right: -5px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px; background: var(--accent);
                  color: var(--accent-ink); font: 700 11px/20px system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px var(--bg); }
    .fab.wait .count { background: #e9a23b; color: #2b1d00; }

    /* The panel above it */
    .panel { position: fixed; right: 20px; bottom: 84px; width: 380px; max-width: calc(100vw - 40px); height: min(600px, calc(100vh - 110px));
             display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden; }
    .panel.passive { pointer-events: none; opacity: .72; }
    .passive-note { padding: 6px 14px; font-size: 12px; color: var(--muted); background: var(--bg2); border-bottom: 1px solid var(--line); }
    .bar { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--line); min-height: 56px; }
    .bar .tt { flex: 1; min-width: 0; padding-left: 4px; }
    .bar .h { font-weight: 650; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar .s { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    .back { width: 32px; height: 32px; border-radius: 10px; border: 0; background: transparent; color: var(--muted); cursor: pointer; display: grid; place-items: center; font: 600 20px/1 system-ui, sans-serif; flex: none; }
    .back:hover { background: var(--bg2); color: var(--ink); }
    .scroll { flex: 1; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
    .foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    .grow { flex: 1; }
    a, .link { color: var(--accent); cursor: pointer; text-decoration: none; font-weight: 600; font-size: 12.5px; }
    a:hover { text-decoration: underline; }
    .link.muted { color: var(--muted); font-weight: 500; }

    /* List of agents */
    .sec { padding: 14px 16px 4px; color: var(--faint); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .row { display: grid; grid-template-columns: 34px 1fr auto; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line) !important; cursor: pointer; border: 0;
           background: transparent; width: 100%; text-align: left; color: inherit; font: inherit; }
    .row:hover { background: var(--bg2); }
    /* Each task has its own badge: a number and a colour, the same in the list and in its chat */
    .badge { position: relative; width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; flex: none;
             font: 700 14px/1 system-ui, sans-serif; color: #fff; background: hsl(var(--h) 52% 42%); }
    .badge .dot { position: absolute; right: -3px; bottom: -3px; width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--bg); background: var(--faint); }
    .badge .dot.run { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
    .badge .dot.wait { background: #e9a23b; }
    .badge .dot.ok { background: var(--ok); }
    .badge .dot.bad { background: var(--warn); }
    .bar .badge { width: 30px; height: 30px; font-size: 13px; }
    .row > div { min-width: 0; }
    .row .t { font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .row .d { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .d.wait { color: var(--ask-ink); font-weight: 600; }
    .row .r { color: var(--faint); font-size: 11.5px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .bolt { color: var(--gold); font-weight: 700; }
    .empty { padding: 36px 24px; color: var(--muted); text-align: center; line-height: 1.6; }
    .empty b { color: var(--ink); }

    /* Status marks */
    .st { width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; font: 700 10px/1 system-ui, sans-serif; flex: none; }
    .st.run { border: 2px solid var(--bg3); border-top-color: var(--accent); animation: spin .9s linear infinite; }
    .st.wait { background: #e9a23b; color: #2b1d00; }
    .st.done, .st.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
    .st.failed, .st.bad { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
    .st.skipped { background: var(--bg2); color: var(--faint); }

    /* Chat */
    .chat { padding: 14px 14px 8px; display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 86%; padding: 9px 12px; border-radius: 16px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
    .msg.user { align-self: flex-end; background: var(--me); color: var(--me-ink); border-bottom-right-radius: 6px; }
    .msg.assistant { align-self: flex-start; background: var(--bg2); border-bottom-left-radius: 6px; }
    .msg.live { color: var(--muted); }
    .steps { align-self: stretch; display: grid; gap: 2px; min-width: 0; }
    .chat > *, .asks > *, .prompt > *, .tbwrap > *, .auto > * { min-width: 0; }
    .asks { min-width: 0; }
    .sum { width: 100%; min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12.5px; padding: 2px 2px; cursor: pointer; border: 0; background: transparent; font: inherit; text-align: left; }
    .sum:hover { color: var(--ink); }
    .sum .lab { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .sum .chev { color: var(--faint); font-size: 11px; flex: none; }
    .step { display: grid; grid-template-columns: 18px 1fr; gap: 8px; align-items: start; color: var(--muted); font-size: 12.5px; padding: 1px 2px 1px 24px; }
    .step .st, .sum .st { width: 15px; height: 15px; font-size: 9px; margin-top: 2px; }
    .step .det { display: block; color: var(--warn); font-size: 12px; }
    .dots::after { content: '…'; animation: pulse 1s infinite; }
    .notice { align-self: stretch; font-size: 12.5px; padding: 9px 11px; border-radius: 12px; background: var(--bg2); color: var(--muted); }
    .notice.bad { background: color-mix(in srgb, var(--warn) 10%, var(--bg)); color: var(--ink); }
    .auto { align-self: stretch; display: grid; gap: 8px; padding: 12px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--gold) 45%, var(--line));
            background: color-mix(in srgb, var(--gold) 8%, var(--bg)); }
    .auto .k { font-weight: 700; color: var(--gold); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; }
    .auto .n { font-weight: 650; }
    .auto .w { color: var(--muted); font-size: 12.5px; }
    .nope { align-self: flex-start; color: var(--faint); font-size: 12px; }
    .asks { padding: 0 14px 10px; display: grid; gap: 8px; }
    .composer { padding: 10px 12px 12px; border-top: 1px solid var(--line); }

    /* Answer box, question cards, buttons */
    form.tb { min-width: 0; display: flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 14px; background: var(--bg); padding: 4px 4px 4px 12px; }
    form.tb:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
    form.tb input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 13.5px/1.3 system-ui, sans-serif; padding: 7px 0; }
    .tbwrap { display: grid; gap: 5px; }
    .ib { width: 34px; height: 34px; border-radius: 10px; border: 0; background: transparent; color: var(--muted); cursor: pointer; display: grid; place-items: center; flex: none; }
    .ib:hover:not(:disabled) { background: var(--bg2); color: var(--ink); }
    .ib:disabled { opacity: .4; cursor: default; }
    .ib.go { background: var(--accent); color: var(--accent-ink); }
    .ib.go:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); color: var(--accent-ink); }
    .ib.rec { background: #c0392b; color: #fff; animation: pulse 1.2s ease-in-out infinite; }
    .status { color: var(--ask-ink); font-size: 12px; padding-left: 4px; } .status:empty { display: none; }
    .prompt { display: grid; gap: 9px; padding: 12px; border-radius: 14px; background: var(--ask); border: 1px solid var(--ask-line); }
    .phead { display: flex; align-items: center; gap: 8px; }
    .ptitle { font-weight: 700; color: var(--ask-ink); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; flex: 1; }
    .pmsg { white-space: pre-wrap; overflow-wrap: anywhere; }
    .pnote { color: var(--muted); font-size: 12px; }
    .fjson { max-height: 180px; overflow: auto; font: 11px/1.4 ui-monospace, Consolas, monospace; background: var(--bg); border-radius: 8px; padding: 8px; white-space: pre-wrap; margin: 6px 0 0; }
    .acts { display: flex; gap: 8px; flex-wrap: wrap; }
    button.b { font: 600 12.5px/1 system-ui, sans-serif; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--ink);
               padding: 8px 12px; cursor: pointer; white-space: nowrap; }
    button.b:hover:not(:disabled) { background: var(--bg2); }
    button.b:disabled { opacity: .5; cursor: default; }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
    button.ghost { background: transparent; }
    button.stop { color: var(--warn); }

    /* Pointing at the page */
    .pickbox { position: fixed; pointer-events: none; border: 2px solid var(--accent); border-radius: 6px; background: color-mix(in srgb, var(--accent) 12%, transparent); transition: all .06s; }
    .picktip { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); pointer-events: none; padding: 8px 14px; border-radius: 999px; background: var(--ink); color: var(--bg); font-size: 12.5px; box-shadow: var(--shadow); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .ring .arc, .st.run, .ib.rec, .dots::after { animation: none !important; } }
  </style>
  <div class="ui">
    <section class="panel" hidden role="dialog" aria-label="Voice Agent"></section>
    <button class="fab" type="button" aria-haspopup="dialog">
      <svg class="ring" viewBox="0 0 60 60" aria-hidden="true"><circle class="arc" cx="30" cy="30" r="27"/></svg>
      <svg class="glyph wave" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="3" y="9" width="2.6" height="6" rx="1.3"/><rect x="7.4" y="5.5" width="2.6" height="13" rx="1.3"/><rect x="11.8" y="3" width="2.6" height="18" rx="1.3"/><rect x="16.2" y="6.5" width="2.6" height="11" rx="1.3"/><rect x="20.4" y="10" width="2.2" height="4" rx="1.1"/></svg>
      <svg class="glyph close" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="display:none"><path d="M6 6l12 12M18 6L6 18"/></svg>
      <span class="count" hidden></span>
    </button>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const fab = $('.fab');
  const panel = $('.panel');
  const uiRoot = $('.ui');

  // ---------- State ----------
  let acts = [];
  let names = {};
  let running = [];
  let prompts = {};
  let cost = { usd: 0, byTask: {} };
  let progress = {};
  let agentTabs = {};
  let ends = {};
  let agentName = 'Voice Agent';
  let myTab = null;
  let open = false;
  let view = { kind: 'list' };
  let flash = null; // { status, at } of a task that just ended
  const seenPrompts = new Set();
  const chats = {};
  const expanded = {};
  let stick = true;

  ui.send({ type: 'va.whoami' }).then((r) => {
    myTab = r && Number.isInteger(r.tabId) ? r.tabId : null;
    render();
  });

  const clock = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 3600 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  };
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  };
  const taskCost = (id) => (cost.byTask && cost.byTask[id] ? cost.byTask[id].usd : 0);
  const waiting = () => Object.values(prompts).reduce((n, l) => n + l.length, 0);
  const plain = (s) => String(s || '').replace(/```[a-z]*\n?/gi, '').replace(/\*\*|__|^#+\s*/gm, '').replace(/`/g, '').replace(/\n{3,}/g, '\n\n').trim();
  let titles = {};
  // A task keeps the name of what was first asked, even after follow-up messages.
  const nameOf = (a) => String(titles[a.id] || names[a.id] || a.text || 'A task').replace(/\s+/g, ' ').trim();
  const tabOf = (a) => a.taskTab ?? (a.tabs && a.tabs[0] && a.tabs[0].id);
  const lastStep = (id) => {
    const p = progress[id];
    return p && p.steps && p.steps.length ? p.steps[p.steps.length - 1] : null;
  };
  const endInfo = (a) => {
    const e = ends[a.id] || {};
    if (!a || a.status === 'working') return null;
    if (e.status === 'capped') return { label: 'Paused at the step limit', bad: true, capped: true, said: e.summary, automate: e.automate };
    if (a.status === 'done') return { label: 'Finished', said: e.summary || (progress[a.id] && progress[a.id].thought), automate: e.automate };
    if (a.status === 'stopped') return { label: 'Stopped by you', bad: true, said: e.summary };
    return { label: 'Stopped before finishing', bad: true, why: e.reason, said: e.summary };
  };
  const drivenHere = () =>
    myTab !== null && running.some((t) => !prompts[t.id] && (agentTabs[myTab] === t.id || t.tab === myTab || (progress[t.id] && progress[t.id].tab === myTab)));

  // ---------- Shared open/closed and view (same on every tab) ----------
  function saveUi() {
    chrome.storage.local.set({ 'va.ui.panel': { open, view, at: Date.now() } }).catch(() => {});
  }
  function setOpen(v, nextView) {
    open = v;
    if (nextView) view = nextView;
    if (view.kind === 'chat') loadChat(view.id, true);
    saveUi();
    render(true);
  }
  function show(v) {
    view = v;
    stick = true;
    if (v.kind === 'chat') loadChat(v.id, true);
    saveUi();
    render(true);
  }

  // ---------- Render ----------
  let built = '';
  function render(force) {
    const nRun = running.length;
    const nWait = waiting();
    const flashing = !nRun && flash && Date.now() - flash.at < FLASH_MS;
    fab.className = 'fab' + (open ? ' open' : '') + (nWait ? ' wait' : nRun ? ' run' : flashing ? (flash.status === 'done' ? ' ok' : ' bad') : '');
    $('.wave').style.display = open ? 'none' : '';
    $('.close').style.display = open ? '' : 'none';
    const count = $('.count');
    count.hidden = open || !(nWait || nRun > 1);
    count.textContent = String(nWait || nRun);
    fab.title = open ? 'Close' : nWait ? agentName + ' needs your answer' : nRun ? agentName + ': ' + (nRun > 1 ? nRun + ' agents working' : 'working') : agentName + ': your agents';
    fab.setAttribute('aria-label', fab.title);
    fab.setAttribute('aria-expanded', String(open));
    // The agent reads pages through the accessibility tree; on its tabs the popup is left out of it.
    const agentTab = myTab !== null && (agentTabs[myTab] !== undefined || running.some((t) => t.tab === myTab));
    if (agentTab) host.setAttribute('aria-hidden', 'true');
    else host.removeAttribute('aria-hidden');
    panel.hidden = !open;
    const passive = open && nWait === 0 && nRun > 0 && drivenHere();
    panel.classList.toggle('passive', passive);
    if (open) {
      const sig = JSON.stringify([view, passive]);
      if (force || sig !== built) {
        built = sig;
        panel.textContent = '';
        chatShell = null;
        if (passive) panel.append(el('div', 'passive-note', agentName + ' is working in this tab, so clicks pass through this panel. Use the button to close it.'));
      }
      (view.kind === 'chat' ? renderChat : renderList)(force);
    }
    keepOnTop();
  }

  // ---------- Task badges ----------
  // A task's number is its order of starting among the tasks shown (1 = oldest); its colour comes from its id.
  const order = new Map();
  const numberOf = (id) => {
    if (!order.has(id)) {
      const all = [...acts].reverse().map((a) => a.id);
      all.forEach((x, i) => order.set(x, i + 1));
      if (!order.has(id)) order.set(id, order.size + 1);
    }
    return order.get(id);
  };
  const hueOf = (id) => {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  };
  function badge(id, state) {
    const b = el('span', 'badge', String(numberOf(id) % 100));
    b.style.setProperty('--h', String(hueOf(id)));
    b.append(span('dot ' + state));
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  // ---------- List of agents ----------
  let listEl = null;
  let listSig = '';
  function renderList(force) {
    const earlier = acts.filter((a) => a.status !== 'working' && !prompts[a.id] && Date.now() - Date.parse(a.at) < EARLIER_MS).slice(0, 8);
    const sig = JSON.stringify([running, prompts, earlier.map((a) => [a.id, a.status, ends[a.id] && ends[a.id].automate]), agentName]);
    if (!force && listEl && listEl.isConnected && sig === listSig) return tickList();
    listSig = sig;
    if (listEl) listEl.remove();
    listEl = el('div');
    listEl.style.cssText = 'display:flex;flex-direction:column;min-height:0;flex:1';
    const bar = el('div', 'bar');
    const tt = el('div', 'tt');
    const nW = waiting();
    tt.append(el('div', 'h', agentName), el('div', 's', running.length ? running.length + (running.length > 1 ? ' agents working' : ' agent working') + (nW ? ' · ' + nW + ' waiting for you' : '') : 'Nothing running'));
    bar.append(tt);
    const sc = el('div', 'scroll');
    if (running.length) {
      sc.append(el('div', 'sec', 'Working now'));
      for (const t of running) sc.append(agentRow(t, null));
    }
    if (earlier.length) {
      sc.append(el('div', 'sec', 'Earlier'));
      for (const a of earlier) sc.append(agentRow({ id: a.id, at: a.at, tab: tabOf(a), name: nameOf(a) }, a));
    }
    if (!running.length && !earlier.length) {
      const e = el('div', 'empty');
      e.append(el('b', '', 'No agents yet.'), el('br'), 'Hold the mouse anywhere on a page and say what you need. Your agents show up here.');
      sc.append(e);
    }
    const f = el('div', 'foot');
    const all = el('a', '', 'All tasks & costs');
    all.onclick = (e) => e.isTrusted && ui.send({ type: 'va.openTasksPage' });
    f.append(all, span('grow'), span('total', ui.usd(cost.usd) + ' spent'));
    listEl.append(bar, sc, f);
    panel.append(listEl);
    tickList();
  }
  function agentRow(t, finished) {
    const row = el('button', 'row');
    row.type = 'button';
    row.dataset.id = t.id;
    const p = prompts[t.id];
    const info = finished ? endInfo(finished) : null;
    row.append(badge(t.id, p ? 'wait' : !finished ? 'run' : info.bad ? 'bad' : 'ok'));
    const mid = el('div');
    mid.append(el('div', 't', t.name));
    const d = el('div', 'd' + (p ? ' wait' : ''));
    if (finished) {
      if (info.automate && info.automate.worth && !info.automate.dismissed) d.append(span('bolt', '⚡ Worth automating · '));
      d.append(info.label + (info.said ? ' — ' + plain(info.said).split('\n')[0] : ''));
    } else d.dataset.live = '1';
    mid.append(d);
    const r = el('div', 'r');
    r.dataset.at = t.at;
    r.dataset.fin = finished ? '1' : '';
    row.append(mid, r);
    row.onclick = (e) => e.isTrusted && show({ kind: 'chat', id: t.id });
    return row;
  }
  function tickList() {
    for (const row of panel.querySelectorAll('.row[data-id]')) {
      const id = row.dataset.id;
      const d = row.querySelector('.d');
      if (d && d.dataset.live) {
        const p = prompts[id];
        const s = lastStep(id);
        d.textContent = p ? 'Needs your answer — ' + plain((p[0].data && p[0].data.message) || 'a decision') : s ? s.label : 'Getting started…';
      }
      const r = row.querySelector('.r');
      if (r) r.textContent = (r.dataset.fin ? ago(r.dataset.at) : clock(r.dataset.at)) + ' · ' + ui.usd(taskCost(id));
    }
    const tot = panel.querySelector('.total');
    if (tot) tot.textContent = ui.usd(cost.usd) + ' spent';
  }

  // ---------- One agent's chat ----------
  let chatTimer = null;
  function loadChat(id, now) {
    clearTimeout(chatTimer);
    const go = async () => {
      const c = (chats[id] ??= { items: [] });
      if (c.loading) return;
      c.loading = true;
      const r = await ui.send({ type: 'va.chat', conversationId: id });
      c.loading = false;
      if (r && r.ok) {
        c.items = r.items;
        c.at = Date.now();
        if (open && view.kind === 'chat' && view.id === id) renderChat();
      }
    };
    if (now) go();
    else chatTimer = setTimeout(go, 600);
  }
  function chatTask(id) {
    const t = running.find((x) => x.id === id);
    if (t) return { t, finished: null };
    const a = acts.find((x) => x.id === id);
    return { t: a ? { id, at: a.at, tab: tabOf(a), name: nameOf(a) } : { id, at: new Date().toISOString(), name: 'A task' }, finished: a && a.status !== 'working' ? a : null };
  }
  let chatShell = null;
  function renderChat() {
    const id = view.id;
    const { t, finished } = chatTask(id);
    const info = finished ? endInfo(finished) : null;
    if (!chatShell || chatShell.id !== id || !chatShell.box.isConnected) {
      const box = el('div');
      box.style.cssText = 'display:flex;flex-direction:column;min-height:0;flex:1';
      const bar = el('div', 'bar');
      const body = el('div', 'scroll');
      body.addEventListener('scroll', () => (stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40));
      const asks = el('div', 'asks');
      const composer = el('div', 'composer');
      composer.append(
        ui.textBox('c:' + id, {
          placeholder: 'Message ' + agentName + '…',
          label: 'Message for this agent',
          onSend: async (text, st) => {
            const { t: tk } = chatTask(id);
            const r = await ui.send({ type: 'va.followUp', conversationId: id, taskTabId: tk.tab, text });
            if (r && r.ok === false) st.textContent = r.error || 'Could not send.';
            const c = (chats[id] ??= { items: [] });
            c.items = [...c.items, { role: 'user', text }];
            stick = true;
            renderChat();
            loadChat(id);
          },
        }),
      );
      box.append(bar, body, asks, composer);
      panel.append(box);
      chatShell = { id, box, bar, body, asks, composer, sigBar: '', sigBody: '', sigAsks: '' };
    }
    const s = chatShell;
    // Header
    const sigBar = JSON.stringify([t.name, !!prompts[id], info && info.label, t.tab]);
    if (sigBar !== s.sigBar) {
      s.sigBar = sigBar;
      s.bar.textContent = '';
      const back = el('button', 'back', '‹');
      back.type = 'button';
      back.title = 'All agents';
      back.setAttribute('aria-label', 'All agents');
      back.onclick = (e) => e.isTrusted && show({ kind: 'list' });
      const tt = el('div', 'tt');
      tt.title = t.name;
      tt.append(el('div', 'h', t.name), el('div', 's'));
      s.bar.append(back, badge(id, prompts[id] ? 'wait' : !finished ? 'run' : info.bad ? 'bad' : 'ok'), tt);
      if (!finished && Number.isInteger(t.tab))
        s.bar.append(ui.button('Stop', 'stop', (b) => {
          b.textContent = 'Stopping…';
          b.disabled = true;
          ui.send({ type: 'voice.stopTask', taskTabId: t.tab });
        }));
      if (info && info.capped && Number.isInteger(t.tab))
        s.bar.append(ui.button('Continue', 'primary', async (b) => {
          b.disabled = true;
          b.textContent = 'Continuing…';
          const r = await ui.send({ type: 'va.continue', conversationId: id, taskTabId: t.tab });
          if (!r || !r.ok) {
            b.disabled = false;
            b.textContent = 'Continue';
          }
        }));
    }
    const sub = s.bar.querySelector('.s');
    if (sub) {
      const p = progress[id] || {};
      sub.textContent = prompts[id]
        ? 'Waiting for your answer · ' + ui.usd(taskCost(id))
        : finished
          ? info.label + ' · ' + ago(finished.at) + ' · ' + ui.usd(taskCost(id))
          : 'Working · ' + clock(t.at) + ' · ' + (p.count || 0) + ' steps · ' + ui.usd(taskCost(id));
    }
    // Questions it is waiting on
    const sigAsks = JSON.stringify([prompts[id] || [], ui.state()]);
    if (sigAsks !== s.sigAsks) {
      s.sigAsks = sigAsks;
      const active = root.activeElement;
      const key = active && active.dataset ? active.dataset.key : null;
      s.asks.textContent = '';
      for (const p of prompts[id] || []) s.asks.append(ui.promptCard(p, agentName));
      s.asks.hidden = !(prompts[id] || []).length;
      // While a question is open, its own box is the one to answer in.
      s.composer.hidden = !!(prompts[id] || []).length;
      const fk = ui.takeFocus() || key;
      const inp = fk && [...panel.querySelectorAll('input')].find((i) => i.dataset.key === fk);
      if (inp && root.activeElement !== inp) inp.focus();
    }
    // The conversation
    const c = chats[id] || { items: [] };
    const p = progress[id] || {};
    const live = !finished && !prompts[id] && p.thought ? p.thought : '';
    const now = !finished ? (p.steps || []).filter((x) => x.status === 'running').slice(-1)[0] : null;
    const sigBody = JSON.stringify([c.items.length, c.items.slice(-1), live, now && now.label, info, expanded]);
    if (sigBody === s.sigBody) return;
    s.sigBody = sigBody;
    const chat = el('div', 'chat');
    if (!c.items.length && !c.at) chat.append(el('div', 'notice', 'Loading the conversation…'));
    let group = null;
    let gi = 0;
    const flush = (current) => {
      if (!group && !current) return;
      const list = group || [];
      const key = id + ':' + gi++;
      const box = el('div', 'steps');
      const fails = list.filter((x) => x.status === 'failed').length;
      const last = current || list[list.length - 1];
      const sum = el('button', 'sum');
      sum.type = 'button';
      sum.append(span('st ' + (current ? 'run' : fails ? 'bad' : 'ok'), current ? '' : fails ? '!' : '✓'));
      const n = list.length + (current ? 1 : 0);
      sum.append(span('lab', (n > 1 ? n + ' steps' + (fails ? ', ' + fails + ' failed' : '') + ' · ' : '') + (current ? current.label : last.text || last.label)));
      if (list.length > 1 || fails) sum.append(span('chev', expanded[key] ? '▾' : '▸'));
      sum.onclick = (e) => {
        if (!e.isTrusted) return;
        expanded[key] = !expanded[key];
        renderChat();
      };
      box.append(sum);
      if (expanded[key]) for (const x of list) box.append(stepRow(x.text, x.status || 'done', x.detail));
      chat.append(box);
      group = null;
    };
    for (const it of c.items) {
      if (it.role === 'step') {
        (group ??= []).push(it);
        continue;
      }
      flush();
      chat.append(el('div', 'msg ' + it.role, it.role === 'assistant' ? plain(it.text) : it.text));
    }
    flush(now ? { label: now.label } : null);
    if (live) chat.append(el('div', 'msg assistant live', plain(live)));
    else if (!finished && !prompts[id] && !now) {
      const w = el('div', 'msg assistant live');
      w.append(span('dots', 'Working'));
      chat.append(w);
    }
    if (info && info.capped) chat.append(el('div', 'notice bad', 'It used all its steps for this run. Press Continue to let it carry on, or send it a message.'));
    else if (info && info.why) chat.append(el('div', 'notice bad', 'Why it stopped: ' + plain(info.why)));
    if (info && info.automate) chat.append(automateCard(id, t, info.automate));
    s.body.textContent = '';
    s.body.append(chat);
    if (stick) s.body.scrollTop = s.body.scrollHeight;
  }
  function stepRow(text, status, detail) {
    const r = el('div', 'step');
    const lab = span('', text);
    if (detail) lab.append(span('det', detail));
    r.append(span('st ' + (status === 'running' ? 'run' : status), { done: '✓', failed: '✕', skipped: '–', waiting: '?' }[status] || ''), lab);
    return r;
  }
  function automateCard(id, t, a) {
    if (!a.worth) return el('div', 'nope', 'Not worth automating — ' + a.reason);
    if (a.dismissed) return el('div', 'nope', '⚡ Could be automated: ' + (a.name || 'this task'));
    const c = el('div', 'auto');
    c.append(el('div', 'k', '⚡ Worth automating'), el('div', 'n', a.name || 'This task'), el('div', 'w', a.reason));
    const row = el('div', 'acts');
    row.append(
      ui.button('Automate it', 'primary', async (b) => {
        b.disabled = true;
        b.textContent = 'Asking ' + agentName + '…';
        const text = 'Please turn what you just did into a reusable flow' + (a.name ? ' called "' + a.name + '"' : '') + ': open the page again, use inspect_page for selectors, then save_flow with the parts that change as inputs and a test input. Then tell me how to run it next time, and whether it is fit to share online.';
        await ui.send({ type: 'va.followUp', conversationId: id, taskTabId: t.tab, text });
        ui.send({ type: 'va.automateDismiss', conversationId: id });
        loadChat(id);
      }),
      ui.button('Not now', 'ghost', () => ui.send({ type: 'va.automateDismiss', conversationId: id })),
    );
    c.append(row);
    return c;
  }

  // ---------- Pointing at something on the page as an answer ----------
  ui.setPicker((done) => {
    const box = el('div', 'pickbox');
    const tip = el('div', 'picktip', 'Click the thing you mean · Esc cancels');
    uiRoot.append(box, tip);
    box.hidden = true;
    let cur = null;
    const ours = (e) => e.target === host;
    const move = (e) => {
      if (ours(e)) return (box.hidden = true);
      cur = e.target;
      const r = cur.getBoundingClientRect();
      Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
      box.hidden = false;
    };
    const swallow = (e) => {
      if (ours(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const click = (e) => {
      if (ours(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(globalThis.__vaPointed ? globalThis.__vaPointed(e.target) : { tag: e.target.tagName.toLowerCase(), text: (e.target.innerText || '').slice(0, 300) });
    };
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(null);
    };
    const opts = { capture: true };
    addEventListener('mousemove', move, opts);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) addEventListener(t, swallow, opts);
    addEventListener('click', click, opts);
    addEventListener('keydown', key, opts);
    function finish(d) {
      removeEventListener('mousemove', move, opts);
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) removeEventListener(t, swallow, opts);
      removeEventListener('click', click, opts);
      removeEventListener('keydown', key, opts);
      box.remove();
      tip.remove();
      done(d ? { ...d, page: location.host + location.pathname.slice(0, 60) } : null);
    }
  });

  // ---------- Button, keys, keeping it on top ----------
  fab.onclick = (e) => {
    if (!e.isTrusted) return;
    if (open) return setOpen(false);
    // Open where it is most useful: a waiting question, else the only running agent, else the list.
    const ask = Object.keys(prompts)[0];
    setOpen(true, ask ? { kind: 'chat', id: ask } : running.length === 1 ? { kind: 'chat', id: running[0].id } : view.kind === 'chat' && chatTask(view.id).t ? view : { kind: 'list' });
  };
  globalThis.__vaKey = (e) => {
    if (e.key !== 'Escape') return;
    if (view.kind === 'chat') show({ kind: 'list' });
    else setOpen(false);
  };
  function keepOnTop() {
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    if (topLayer) {
      try {
        if (!host.matches(':popover-open')) host.showPopover();
      } catch {}
    }
  }

  // ---------- Data ----------
  async function load(first) {
    const r = await chrome.storage.local
      .get(['voice.activity', 'voice.pending-tasks', 'voice.agentName', 'va.prompts', 'va.cost', 'va.taskEnds', 'va.progress', 'va.agentTabs', 'va.ui.panel', 'va.titles'])
      .catch(() => ({}));
    const before = new Set(running.map((t) => t.id));
    acts = Array.isArray(r['voice.activity']) ? r['voice.activity'] : [];
    names = r['voice.pending-tasks'] || {};
    titles = r['va.titles'] || {};
    prompts = r['va.prompts'] && typeof r['va.prompts'] === 'object' ? r['va.prompts'] : {};
    cost = r['va.cost'] && typeof r['va.cost'] === 'object' ? r['va.cost'] : { usd: 0, byTask: {} };
    progress = r['va.progress'] || {};
    agentTabs = r['va.agentTabs'] || {};
    ends = r['va.taskEnds'] || {};
    if (typeof r['voice.agentName'] === 'string' && r['voice.agentName'].trim()) agentName = r['voice.agentName'].trim();
    if (first && r['va.ui.panel']) {
      open = !!r['va.ui.panel'].open;
      view = r['va.ui.panel'].view || { kind: 'list' };
    }
    running = acts
      .filter((a) => (a.status === 'working' && Date.now() - Date.parse(a.at) < STALE_MS) || prompts[a.id])
      .map((a) => ({ id: a.id, at: (progress[a.id] && progress[a.id].startedAt) || a.at, tab: tabOf(a), name: nameOf(a) }));
    for (const id of Object.keys(prompts))
      if (!running.some((t) => t.id === id)) running.push({ id, at: new Date().toISOString(), tab: prompts[id][0] && prompts[id][0].tabId, name: 'A task' });
    for (const id of before)
      if (!running.some((t) => t.id === id)) {
        const a = acts.find((x) => x.id === id);
        flash = { status: a ? a.status : 'done', at: Date.now() };
        setTimeout(render, FLASH_MS + 100);
      }
    // A new question opens that agent's chat (on every tab, through the shared state).
    for (const [id, list] of Object.entries(prompts))
      for (const p of list)
        if (!seenPrompts.has(p.id)) {
          seenPrompts.add(p.id);
          if (!first || !(open && view.kind === 'chat' && view.id === id)) {
            open = true;
            view = { kind: 'chat', id };
            if (!first) saveUi();
          }
        }
    if (open && view.kind === 'chat') loadChat(view.id, first);
    render(first);
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch['va.ui.panel']) {
      const v = ch['va.ui.panel'].newValue || {};
      const changed = v.open !== open || JSON.stringify(v.view) !== JSON.stringify(view);
      open = !!v.open;
      view = v.view || { kind: 'list' };
      if (changed) {
        if (open && view.kind === 'chat') loadChat(view.id, true);
        render(true);
      }
    }
    if (ch['voice.activity'] || ch['voice.pending-tasks'] || ch['voice.agentName'] || ch['va.prompts'] || ch['va.taskEnds'] || ch['va.agentTabs'] || ch['va.titles']) return load(false);
    if (ch['va.cost']) cost = ch['va.cost'].newValue || { usd: 0, byTask: {} };
    if (ch['va.progress']) {
      progress = ch['va.progress'].newValue || {};
      if (open && view.kind === 'chat') loadChat(view.id);
    }
    if (ch['va.cost'] || ch['va.progress']) render();
  });
  // A tab brought back to the front shows the current shared state.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load(true));
  setInterval(() => render(), 1000);
  ui.setRerender(() => render());
  const mount = () => {
    (document.documentElement || document.body).appendChild(host);
    keepOnTop();
  };
  if (document.documentElement) mount();
  else addEventListener('DOMContentLoaded', mount, { once: true });
  load(true);
})();
