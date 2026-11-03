// Voice Agent add-ons in the background worker (added). Kept in one block so it can be replaced as a whole.
//  - Cost meter: prices every Meta API call (from the logger's meter) and every agent step (per task) at Meta's list
//    prices, kept in va.cost. The prices can be changed on the Tasks page (va.prices).
//  - Why a task ended: the agent's own end status, reason and last summary per task, in va.taskEnds and the log.
//  - Questions and approvals the agent is waiting on, mirrored to va.prompts so the on-page popup and the Tasks page
//    can show them and answer them (the answering itself is next to the run manager, further down this file).
//  - The optional Windows notification that lists running tasks (off by default).
(() => {
  const clip = (v, n = 400) => String(v ?? '').slice(0, n);

  // ---------- Prices (US$ per million tokens; transcription per hour of audio) ----------
  const DEFAULT_PRICES = {
    'muse-wonder': { in: 4, cached: 0.2, out: 20 },
    'muse-spark': { in: 1.25, cached: 0.15, out: 4.25 },
    asrPerHour: 0.18,
  };
  let prices = DEFAULT_PRICES;
  const setPrices = (p) => {
    prices = p && typeof p === 'object' ? { ...DEFAULT_PRICES, ...p } : DEFAULT_PRICES;
  };
  chrome.storage.local.get('va.prices').then((r) => setPrices(r['va.prices'])).catch(() => {});
  const priceOf = (model) => {
    const m = String(model || '');
    for (const k of Object.keys(prices)) if (k !== 'asrPerHour' && m.startsWith(k)) return prices[k];
    return null;
  };
  const tokenCost = (p, input, cached, output) =>
    p ? (Math.max(0, input - cached) * p.in + cached * p.cached + output * p.out) / 1e6 : 0;

  // ---------- Cost record ----------
  const fresh = () => ({ since: new Date().toISOString(), usd: 0, calls: 0, byModel: {}, byTask: {}, byDay: {} });
  // The day as the user's calendar shows it, for the per-day totals (compare with Meta's usage page).
  const dayOf = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  let cost = null;
  let loading = null;
  let saveTimer = null;
  const costState = () =>
    cost
      ? Promise.resolve(cost)
      : (loading ??= chrome.storage.local.get('va.cost').then((r) => {
          const c = r['va.cost'];
          cost = c && typeof c === 'object' && c.byModel ? c : fresh();
          return cost;
        }));
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!cost) return;
      cost.updatedAt = new Date().toISOString();
      const tasks = Object.entries(cost.byTask);
      if (tasks.length > 300)
        cost.byTask = Object.fromEntries(tasks.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 200));
      chrome.storage.local.set({ 'va.cost': cost }).catch(() => {});
    }, 400);
  }

  // One Meta API call, from the logger's fetch meter (this worker, or forwarded by the offscreen page).
  globalThis.__vaMeter = async (rec) => {
    try {
      const c = await costState();
      const asr = /asr/.test(rec.path);
      const model = rec.model || (asr ? 'muse-voice-transcribe' : 'unknown model');
      const b = (c.byModel[model] ??= { usd: 0, calls: 0, in: 0, cached: 0, out: 0, seconds: 0 });
      let usd = 0;
      if (asr) {
        const sec = Number(rec.seconds) || 0;
        usd = (sec / 3600) * (prices.asrPerHour ?? DEFAULT_PRICES.asrPerHour);
        b.seconds += sec;
      } else if (rec.usage) {
        const u = rec.usage;
        const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
        const output = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
        const cached =
          Number((u.input_tokens_details && u.input_tokens_details.cached_tokens) ??
            (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? 0) || 0;
        const reasoning =
          Number((u.output_tokens_details && u.output_tokens_details.reasoning_tokens) ??
            (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) ?? 0) || 0;
        usd = tokenCost(priceOf(model), input, cached, output);
        b.in += input;
        b.out += output;
        b.cached += cached;
        b.reasoning = (b.reasoning || 0) + reasoning;
        const d = ((c.byDay ??= {})[dayOf()] ??= { usd: 0, calls: 0, in: 0, cached: 0, out: 0, reasoning: 0, models: {} });
        d.in += input;
        d.cached += cached;
        d.out += output;
        d.reasoning += reasoning;
        d.models[model] = (d.models[model] || 0) + 1;
      }
      if (!asr || usd) {
        const d = ((c.byDay ??= {})[dayOf()] ??= { usd: 0, calls: 0, in: 0, cached: 0, out: 0, reasoning: 0, models: {} });
        d.usd += usd;
        d.calls++;
        const days = Object.keys(c.byDay).sort();
        if (days.length > 60) for (const k of days.slice(0, days.length - 60)) delete c.byDay[k];
      }
      b.usd += usd;
      b.calls++;
      c.usd += usd;
      c.calls++;
      save();
    } catch (e) {
      console.warn('[va] cost meter failed', e);
    }
  };

  // One agent step of one task (called from the agent loop with the AI SDK's usage for that step).
  globalThis.__vaTaskCost = async (conversationId, model, u) => {
    try {
      if (!conversationId || !u) return;
      const c = await costState();
      const input = Number(u.input) || 0;
      const output = Number(u.output) || 0;
      const cached = Number(u.cacheRead) || 0;
      const t = (c.byTask[conversationId] ??= { usd: 0, in: 0, out: 0, steps: 0 });
      t.usd += tokenCost(priceOf(model), input, cached, output);
      t.in += input;
      t.cached = (t.cached || 0) + cached;
      t.out += output;
      t.lastInput = input;
      t.steps++;
      t.model = model;
      t.at = new Date().toISOString();
      save();
    } catch {}
  };

  // ---------- Why a task ended ----------
  let endsWrite = Promise.resolve();
  globalThis.__vaRunEnd = (conversationId, l) => {
    const info = {
      status: clip(l && l.status, 40),
      outcome: clip(l && l.outcome, 40),
      reason: clip(l && l.reason, 400),
      // The agent's final words: its done() summary, or else the last message it wrote (its answer).
      summary: clip((l && l.summary) || (progress[conversationId] && progress[conversationId].thought), 1500),
      turns: (l && l.turns) || 0,
      at: new Date().toISOString(),
    };
    endsWrite = endsWrite
      .then(async () => {
        // The task's own record gets its name a moment later (when its notification is made).
        await new Promise((ok) => setTimeout(ok, 1500));
        const r = await chrome.storage.local.get(['va.taskEnds', 'voice.activity']);
        const all = r['va.taskEnds'] || {};
        // Keep the earlier "worth automating" verdict; follow-up runs in the same chat do not ask again.
        all[conversationId] = all[conversationId] && all[conversationId].automate ? { ...info, automate: all[conversationId].automate } : info;
        const keep = Object.entries(all).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 100);
        await chrome.storage.local.set({ 'va.taskEnds': Object.fromEntries(keep) });
        if (info.status === 'done') globalThis.__vaJudge?.(conversationId);
        const act = (Array.isArray(r['voice.activity']) ? r['voice.activity'] : []).find((a) => a.id === conversationId);
        console.info(
          '[va] run ended:',
          info.status + (info.outcome ? '/' + info.outcome : ''),
          'after',
          info.turns,
          'steps.',
          act ? 'Task: "' + clip(act.text, 160) + '".' : '',
          info.reason ? 'Reason: ' + info.reason + '.' : '',
          info.summary ? 'Agent said: ' + clip(info.summary, 300) : '',
        );
        // What it used: tokens per step is what grows when old page content is re-sent.
        const t = cost && cost.byTask && cost.byTask[conversationId];
        if (t)
          console.info('[va] task usage:', t.steps, 'model calls,', t.in, 'input tokens (' + Math.round((100 * (t.cached || 0)) / Math.max(1, t.in)) + '% cached),', t.out, 'output tokens,', '$' + t.usd.toFixed(4), '(' + (t.model || '') + ', about ' + Math.round(t.in / Math.max(1, t.steps)) + ' input tokens per step)');
      })
      .catch(() => {});
  };

  // One agent step: the tool and whether it worked (not its inputs, which can hold page or personal data).
  globalThis.__vaStep = (conversationId, e) => {
    try {
      const r = e && e.result;
      const name = e && e.call && e.call.toolName;
      // Built-in tools return {ok, error}; the agent's own tools (flows, recall, ...) return {text, isError}.
      const ok = !r || (r.ok !== false && r.isError !== true);
      const why = !r ? '' : r.isError ? clip(String(r.text || '').replace(/^error:\s*/, ''), 220) : clip(r.error && r.error.code, 60) + ' ' + clip(r.error && r.error.message, 160);
      console.info('[va] step', name, ok ? 'ok' : 'error ' + why);
    } catch {}
  };

  // ---------- Questions and approvals waiting for the user ----------
  const PICK = {
    'write-card': ['category', 'action', 'target', 'site', 'intent', 'reason', 'canRemember'],
    handover: ['reason', 'site', 'notice', 'restarted'],
    'ask-input': ['message', 'site'],
    'ask-takeover': ['message', 'site'],
    confirm: ['question', 'title'],
    'save-file': ['filename', 'mimeType', 'bytes'],
  };
  // The broker's prompts live in memory, so a new worker starts with none; a resumed run asks again.
  let promptsWrite = chrome.storage.local.remove('va.prompts').catch(() => {});
  const brokerPrompts = new Map(); // conversation -> the broker's open prompts (flow cards are added on write)
  globalThis.__vaPrompts = (conversationId, list) => {
    brokerPrompts.set(conversationId, list || []);
    writePrompts(conversationId);
  };
  function writePrompts(conversationId) {
    const list = brokerPrompts.get(conversationId) || [];
    const items = list.map((p) => ({
      id: p.id,
      kind: p.kind,
      tabId: p.tabId,
      openedAt: p.openedAt,
      data: Object.fromEntries(
        (PICK[p.kind] || [])
          .filter((k) => p.data && p.data[k] !== undefined)
          .map((k) => [k, typeof p.data[k] === 'string' ? p.data[k].slice(0, 800) : p.data[k]]),
      ),
    }));
    items.push(...(globalThis.__vaFlowAsks?.(conversationId) || []));
    promptsWrite = promptsWrite
      .then(async () => {
        const r = await chrome.storage.local.get('va.prompts');
        const all = r['va.prompts'] || {};
        if (items.length) all[conversationId] = items;
        else delete all[conversationId];
        await chrome.storage.local.set({ 'va.prompts': all });
      })
      .catch(() => {});
    if (items.length)
      console.info('[va] waiting for you:', items.map((p) => p.kind + (p.data.message ? ' "' + clip(p.data.message, 160) + '"' : '')).join('; '));
  }
  globalThis.__vaWritePrompts = writePrompts;

  // ---------- Live progress (for the side panel on the page) ----------
  // Built from the agent's own events: each tool step (with its "intent" when the agent gave one), the text it is
  // writing, and the tabs it works in. Kept in va.progress for the last few tasks.
  const TOOL = {
    snapshot: 'Looking at the page',
    screenshot: 'Taking a screenshot',
    find: 'Searching the page',
    read: 'Reading the page',
    click: 'Clicking',
    type: 'Typing',
    fill_form: 'Filling in a form',
    select: 'Choosing an option',
    press: 'Pressing a key',
    scroll: 'Scrolling',
    hover: 'Pointing at something',
    navigate: 'Opening a page',
    tabs: 'Switching tabs',
    wait: 'Waiting for the page',
    ask_user: 'Asking you',
    done: 'Wrapping up',
    find_flows: 'Looking for a saved flow',
    run_flow: 'Running a flow',
    inspect_page: 'Studying the page layout',
    save_flow: 'Saving a reusable flow',
    share_flow: 'Offering a flow to the online library',
    save_file: 'Saving a file',
    read_attachment: 'Reading an attachment',
    upload: 'Uploading a file',
    handle_dialog: 'Answering a page dialog',
    open_tabs: 'Checking your open tabs',
    use_tab: 'Using one of your open tabs',
    recall: 'Looking at your earlier tasks',
    look_back: 'Looking back at an earlier page',
    load_tools: 'Getting another tool ready',
    remember: 'Remembering something about you',
    show_view: 'Making a page to show the results',
  };
  const tidy = (s, n) => clip(String(s || '').replace(/\s+/g, ' ').trim(), n);
  function describe(tool, a) {
    a = a || {};
    if (a.intent) return tidy(a.intent, 110);
    if (tool === 'navigate' && a.url) {
      try {
        return 'Opening ' + new URL(a.url).host.replace(/^www\./, '');
      } catch {}
    }
    if (tool === 'find' && (a.text || a.name)) return 'Looking for “' + tidy(a.text || a.name, 40) + '”';
    if (tool === 'run_flow' && a.id) return 'Running flow “' + tidy(a.id, 40) + '”';
    if (tool === 'save_flow' && a.flow) return 'Saving flow “' + tidy((a.flow && (a.flow.name || a.flow.id)) || '', 40) + '”';
    if (tool === 'find_flows' && (a.query || a.site)) return 'Looking for a flow for “' + tidy(a.query || a.site, 40) + '”';
    if (tool === 'share_flow' && a.id) return 'Offering “' + tidy(a.id, 40) + '” to the online library';
    if (tool === 'recall' && a.source === 'browser') return 'Searching your browser history' + (a.query ? ' for “' + tidy(a.query, 40) + '”' : '');
    if (tool === 'recall' && a.id) return 'Reading an earlier conversation';
    if (tool === 'look_back' && a.query) return 'Looking back for “' + tidy(a.query, 40) + '”';
    if (tool === 'load_tools' && Array.isArray(a.names)) return 'Getting ' + a.names.slice(0, 3).join(', ') + ' ready';
    if (tool === 'open_tabs' && a.query) return 'Looking for “' + tidy(a.query, 40) + '” in your open tabs';
    if (tool === 'ask_user' && a.message) return 'Asked you: ' + tidy(a.message, 90);
    if (tool === 'done') return a.outcome === 'success' ? 'Finished' : 'Wrapping up';
    return TOOL[tool] || String(tool || 'Working').replace(/_/g, ' ');
  }
  // A failed step's first line, without the internal error code ("error OBSCURED link «x» is covered…").
  const why = (text) => tidy(String(text || '').split('\n')[0].replace(/^error\s+[A-Z_]+\s*/, ''), 160);
  const progress = {};
  const progressReady = chrome.storage.local
    .get('va.progress')
    .then((r) => Object.assign(progress, r['va.progress'] || {}))
    .catch(() => {});
  let progressTimer = null;
  const saveProgress = () => {
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      const keep = Object.entries(progress)
        .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
        .slice(0, 12);
      for (const k of Object.keys(progress)) if (!keep.some(([id]) => id === k)) delete progress[k];
      chrome.storage.local.set({ 'va.progress': progress }).catch(() => {});
    }, 250);
  };
  globalThis.__vaEvent = (conversationId, ev) => {
    progressReady.then(() => {
      try {
        if (!ev || typeof ev.type !== 'string') return;
        const now = new Date().toISOString();
        const p = (progress[conversationId] ??= { steps: [], count: 0, thought: '', startedAt: now });
        if (ev.type === 'agent_start') {
          p.state = 'running';
          p.runStartedAt = now;
        } else if (ev.type === 'message_start') p.thought = '';
        else if (ev.type === 'message_update' && typeof ev.text === 'string') p.thought = clip(ev.text.trim(), 1500);
        else if (ev.type.startsWith('tool_execution_') && ev.row) {
          const r = ev.row;
          let s = p.steps.find((x) => x.id === r.toolCallId);
          if (!s) {
            s = { id: r.toolCallId, tool: r.tool, label: describe(r.tool, r.args), at: now };
            p.steps.push(s);
            p.count = (p.count || 0) + 1;
            if (p.steps.length > 60) p.steps.splice(0, p.steps.length - 60);
          }
          s.status = r.status;
          if (r.status === 'failed' && r.text) s.detail = why(r.text);
          if (r.args && Number.isInteger(r.args.tabId)) p.tab = r.args.tabId;
        } else if (ev.type === 'agent_end') p.state = 'ended';
        else return;
        p.updatedAt = now;
        saveProgress();
      } catch {}
    });
  };
  // The tabs each conversation works in (the same tabs that get the glowing border), so the page popup knows when
  // it is on a tab the agent is driving and must not cover what the agent clicks.
  let scopeWrite = Promise.resolve();
  globalThis.__vaScope = (conversationId, added, removed) => {
    scopeWrite = scopeWrite
      .then(async () => {
        const r = await chrome.storage.local.get('va.agentTabs');
        const all = r['va.agentTabs'] || {};
        for (const t of added || []) all[t] = conversationId;
        for (const t of removed || []) if (all[t] === conversationId) delete all[t];
        await chrome.storage.local.set({ 'va.agentTabs': all });
      })
      .catch(() => {});
  };
  chrome.tabs.onRemoved.addListener((tabId) => {
    scopeWrite = scopeWrite
      .then(async () => {
        const r = await chrome.storage.local.get('va.agentTabs');
        const all = r['va.agentTabs'] || {};
        if (all[tabId] === undefined) return;
        delete all[tabId];
        await chrome.storage.local.set({ 'va.agentTabs': all });
      })
      .catch(() => {});
  });

  // ---------- Keeping each request small (cost) ----------
  // Every agent step re-sends its instructions, its tools and the whole task so far. Three things keep that small:
  //  1. Only the tools most tasks need are sent in full; the rest are named in load_tools and loaded when wanted.
  //     The tool schemas also lose their meaningless ±9007199254740991 number limits.
  //  2. Page observations and long tool results older than the newest two are replaced by a one-line note (what it
  //     was, how long, how it began, and its id). This happens in blocks of four, so the start of the request stays
  //     identical between steps and Meta keeps charging it at the cached rate. look_back reopens or searches them.
  //  3. The page outline attached to the first request is capped at 12,000 characters (it was up to 30,000).
  // Settings (Tasks page → Advanced): va.ui.strongModel (Muse Wonder for complex tasks), va.ui.allTools, va.ui.fullHistory.
  const flags = { strongModel: false, allTools: false, fullHistory: false };
  const applyFlags = (r) => {
    flags.strongModel = r['va.ui.strongModel'] === true;
    flags.allTools = r['va.ui.allTools'] === true;
    flags.fullHistory = r['va.ui.fullHistory'] === true;
    globalThis.__vaStrong = flags.strongModel;
  };
  chrome.storage.local.get(['va.ui.strongModel', 'va.ui.allTools', 'va.ui.fullHistory']).then(applyFlags).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch['va.ui.strongModel'] || ch['va.ui.allTools'] || ch['va.ui.fullHistory']))
      chrome.storage.local.get(['va.ui.strongModel', 'va.ui.allTools', 'va.ui.fullHistory']).then(applyFlags);
  });
  globalThis.__vaFirstSnapChars = 12000;

  // type and wait stay loaded: quick actions (ask a chat site, search a form) need them, and loading costs a model call.
  const DEFERRED = new Set(['screenshot', 'fill_form', 'hover', 'upload', 'handle_dialog', 'read_attachment', 'save_file', 'inspect_page', 'save_flow', 'share_flow', 'show_view']);
  // The build's own flow tools (create_flow asked a second model to guess a site's selectors without seeing the page,
  // and usually saved nothing) are replaced by find_flows / run_flow / inspect_page / save_flow / share_flow.
  const RETIRED = new Set(['list_flows', 'create_flow', 'call_flow']);
  const loaded = new Map(); // conversation -> tools it loaded
  const compact = (x) => {
    if (Array.isArray(x)) return x.map(compact);
    if (!x || typeof x !== 'object') return x;
    const o = {};
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'minimum' || k === 'maximum') && typeof v === 'number' && Math.abs(v) >= 9e15) continue;
      o[k] = compact(v);
    }
    return o;
  };
  globalThis.__vaToolFilter = (conversationId, tools) => {
    const mine = loaded.get(conversationId);
    const memOff = globalThis.__vaMemoryContext && !globalThis.__vaMemoryContext();
    const keep = (flags.allTools ? tools : tools.filter((t) => !DEFERRED.has(t.name) || (mine && mine.has(t.name)))).filter((t) => !RETIRED.has(t.name) && !(memOff && t.name === 'remember'));
    return keep.map((t) => (t.name === 'load_tools' && flags.allTools ? null : { ...t, parameters: compact(t.parameters) })).filter(Boolean);
  };
  // The extension's own panel (task button, cards, answer box) is on every page in a closed shadow root, which the
  // accessibility tree still shows. It is left out of the agent's snapshots: it is not part of the page, costs tokens,
  // and the agent must not click its own Send button or read its own progress as page text.
  const OWN_UI = 'Voice Agent panel';
  globalThis.__vaDropOwnUi = (nodes) => {
    if (!Array.isArray(nodes)) return nodes;
    const roots = nodes.filter((x) => x && x.name && x.name.value === OWN_UI && x.role && x.role.value === 'complementary');
    if (!roots.length) return nodes;
    const byId = new Map(nodes.map((x) => [x.nodeId, x]));
    const drop = new Set();
    const stack = roots.map((x) => x.nodeId);
    while (stack.length) {
      const id = stack.pop();
      if (drop.has(id)) continue;
      drop.add(id);
      for (const c of (byId.get(id) && byId.get(id).childIds) || []) stack.push(c);
    }
    return nodes.filter((x) => !drop.has(x.nodeId)).map((x) => (x.childIds && x.childIds.some((c) => drop.has(c)) ? { ...x, childIds: x.childIds.filter((c) => !drop.has(c)) } : x));
  };
  // The same panel in the layout pass of a snapshot (which adds clickable elements the accessibility tree missed).
  globalThis.__vaInOwnUi = (doc, el) => {
    for (let x = el, n = 0; x && n < 80; x = doc.byIndex[x.parent], n++) if (x.tag === 'voice-agent-tasks') return true;
    return false;
  };
  // The "You have:" line of the instructions: the tools sent with every step, then the ones load_tools adds.
  globalThis.__vaToolsLine = (names) => {
    const memOff = globalThis.__vaMemoryContext && !globalThis.__vaMemoryContext();
    const all = names.filter((n) => !RETIRED.has(n) && !(memOff && n === 'remember'));
    if (flags.allTools) return 'You have: ' + all.join(', ') + '.';
    const later = all.filter((n) => DEFERRED.has(n));
    return 'You have: ' + all.filter((n) => !DEFERRED.has(n)).join(', ') + '.' + (later.length ? ' Call load_tools first for: ' + later.join(', ') + '.' : '');
  };
  // The model called a tool it has not loaded: load it so its next call works.
  globalThis.__vaNotLoaded = (conversationId, name) => {
    if (flags.allTools || !DEFERRED.has(name)) return false;
    const mine = loaded.get(conversationId) || new Set();
    if (mine.has(name)) return false;
    mine.add(name);
    loaded.set(conversationId, mine);
    console.info('[va] tool loaded on first use:', name);
    return true;
  };

  const KEEP_FULL = 2;
  const BLOCK = 4;
  const LONG = 900;
  const headline = (t) =>
    '"' +
    tidy(
      String(t)
        .split('\n')
        .filter((l) => l && !/^<<<|^The text between the page-content markers/.test(l))
        .slice(0, 3)
        .join(' · '),
      200,
    ) +
    '"';
  const trimStats = new Map();
  globalThis.__vaPrune = (conversationId, msgs) => {
    if (flags.fullHistory || !Array.isArray(msgs)) return msgs;
    const cands = [];
    msgs.forEach((m, mi) => {
      if (!Array.isArray(m.content)) return;
      m.content.forEach((p, pi) => {
        if (m.role === 'tool' && p.type === 'tool-result') {
          const v = p.output && p.output.value;
          if (typeof v === 'string' && v.length > LONG) cands.push({ mi, pi, tool: true, name: p.toolName, id: p.toolCallId, text: v });
        } else if (m.role === 'user' && p.type === 'text' && typeof p.text === 'string' && p.text.length > LONG && /<<<page-content/.test(p.text))
          cands.push({ mi, pi, tool: false, text: p.text });
      });
    });
    const cut = Math.floor(Math.max(0, cands.length - KEEP_FULL) / BLOCK) * BLOCK;
    if (!cut) return msgs;
    const out = msgs.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.slice() } : m));
    let saved = 0;
    for (const c of cands.slice(0, cut)) {
      const p = out[c.mi].content[c.pi];
      const note = c.tool
        ? '[Shortened to save space: the ' + c.name + ' result from earlier in this task (' + c.text.length + ' characters). It began: ' + headline(c.text) + '. look_back with id "' + c.id + '" shows it in full; look_back with a query searches everything shortened.]'
        : '[Shortened to save space: page content attached earlier in this task (' + c.text.length + ' characters). It began: ' + headline(c.text) + '. look_back with a query searches it.]';
      saved += c.text.length - note.length;
      out[c.mi].content[c.pi] = c.tool ? { ...p, output: { ...p.output, value: note } } : { ...p, text: note };
    }
    const last = trimStats.get(conversationId);
    if (!last || last.cut !== cut) {
      trimStats.set(conversationId, { cut });
      console.info('[va] context: shortened', cut, 'older observations, about', Math.round(saved / 4), 'tokens less per step');
    }
    return out;
  };

  // ---------- Memory of earlier tasks, open tabs and browser history (agent tools) ----------
  // The agent gets three tools (declared next to its other tools further down this file): open_tabs, use_tab and
  // recall. And every run's instructions carry a short note of the user's current tab and their recent tasks, so a
  // new request such as "did we finish?" is understood.
  globalThis.__vaTools = new Set(['open_tabs', 'use_tab', 'recall', 'look_back', 'load_tools', 'find_flows', 'run_flow', 'inspect_page', 'save_flow', 'share_flow', 'remember', 'show_view']);
  const hhmm = (iso) => {
    try {
      return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
      return String(iso || '');
    }
  };
  const ENDED = { done: 'finished', failed: 'stopped before finishing', stopped: 'stopped by the user', working: 'still running' };
  const endedHow = (a, end) =>
    end && end.status === 'capped' ? 'stopped at the step limit (the user can press Continue)' : ENDED[a.status] || a.status;
  async function taskList(query, limit, exclude) {
    const r = await chrome.storage.local.get(['voice.activity', 'va.taskEnds', 'voice.pending-tasks', 'va.titles']);
    const acts = Array.isArray(r['voice.activity']) ? r['voice.activity'] : [];
    const ends = r['va.taskEnds'] || {};
    const names = { ...(r['voice.pending-tasks'] || {}), ...(r['va.titles'] || {}) };
    const seen = new Set();
    let items = acts
      .filter((a) => a.id !== exclude && !seen.has(a.id) && seen.add(a.id))
      .map((a) => {
        const end = ends[a.id] || {};
        return {
          id: a.id,
          when: a.at,
          request: tidy(names[a.id] || a.text || '', 400),
          status: endedHow(a, end),
          why: end.reason ? tidy(end.reason, 200) : undefined,
          answer: end.summary ? clip(end.summary, 900) : undefined,
          pages: (a.tabs || []).slice(0, 4).map((t) => ({ title: tidy(t.title, 100), url: clip(t.url, 200) })),
        };
      });
    // Chats started in the side panel are conversations too.
    try {
      const convs = await globalThis.__vaDB.q5();
      for (const c of convs.slice(0, 60))
        if (c.id !== exclude && !seen.has(c.id)) {
          seen.add(c.id);
          items.push({ id: c.id, when: c.updatedAt || c.createdAt, request: tidy(c.title, 200), status: 'chat in the side panel' });
        }
    } catch {}
    items.sort((a, b) => String(b.when).localeCompare(String(a.when)));
    if (query) {
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((t) => words.every((w) => [t.request, t.answer, t.why, ...(t.pages || []).map((p) => p.title + ' ' + p.url)].join(' ').toLowerCase().includes(w)));
    }
    return items.slice(0, Math.max(1, Math.min(Number(limit) || 8, 25)));
  }
  // A conversation as readable lines: the user's messages, the agent's replies, and one line per step.
  // What the user typed or said in a conversation (its last few messages).
  globalThis.__vaUserSaid = async (id) => (await transcript(id, 6000)).items.filter((x) => x.role === 'user').slice(-3).map((x) => tidy(x.text, 400)).join(' | ').slice(0, 1500);
  async function transcript(id, maxChars = 14000) {
    const entries = await globalThis.__vaDB.Q5(id);
    const out = [];
    for (const en of entries) {
      if (en.type !== 'message' || !en.message) continue;
      const m = en.message;
      if (en.appOwned) continue;
      for (const p of m.parts || []) {
        // The user's own words only: the page context and snapshots the extension attaches to a message are left out.
        if (p.type === 'text' && p.text && (m.role === 'user' || m.role === 'assistant')) {
          const text = String(p.text);
          if (m.role === 'user' && (/<<<page-content|<browser-state>|^\[Nanobrowser note/.test(text) || out.some((x) => x.role === 'user' && x.at === en.at && x.text === text))) continue;
          out.push({ role: m.role, text, at: en.at });
        }
        else if (p.type === 'tool-call') out.push({ role: 'step', text: describe(p.toolName, p.input), tool: p.toolName, id: p.toolCallId, at: en.at });
        else if (p.type === 'tool-result') {
          const step = out.find((x) => x.role === 'step' && x.id === p.toolCallId);
          if (step) {
            step.status = p.isError ? 'failed' : 'done';
            if (p.isError) step.detail = why(p.text);
          }
        }
      }
    }
    let size = 0;
    const keep = [];
    for (let i = out.length - 1; i >= 0; i--) {
      size += out[i].text.length + 20;
      if (size > maxChars) break;
      keep.unshift(out[i]);
    }
    return { items: keep, truncated: keep.length < out.length };
  }
  globalThis.__vaAgentTool = async (conversationId, call, signal) => {
    const a = (call && call.input) || {};
    const name = call && call.toolName;
    if (globalThis.__vaMoreTools && globalThis.__vaMoreTools.names.includes(name)) {
      console.info('[va] tool', name, clip(a.fact || a.title || '', 60));
      return globalThis.__vaMoreTools.run(conversationId, name, a);
    }
    if (globalThis.__vaFlowTools && globalThis.__vaFlowTools.names.includes(name)) {
      console.info('[va] tool', name, a.id || clip(a.query || a.sample || '', 60) || (a.flow && a.flow.id) || '');
      return globalThis.__vaFlowTools.run(conversationId, name, a, signal);
    }
    console.info('[va] tool', name, a.query ? '"' + clip(a.query, 60) + '"' : a.id ? a.id.slice(0, 8) : a.tabId ?? '');
    if (name === 'open_tabs') {
      const [tabs, [current], r] = await Promise.all([
        chrome.tabs.query({}),
        chrome.tabs.query({ active: true, lastFocusedWindow: true }),
        chrome.storage.local.get('va.agentTabs'),
      ]);
      const used = r['va.agentTabs'] || {};
      const q = String(a.query || '').toLowerCase();
      const list = tabs
        .filter((t) => !q || (String(t.title) + ' ' + String(t.url)).toLowerCase().includes(q))
        .slice(0, 60)
        .map((t) => ({
          tabId: t.id,
          title: tidy(t.title, 120),
          url: clip(t.url, 240),
          ...(current && t.id === current.id ? { userIsLookingAtThis: true } : {}),
          ...(used[t.id] === conversationId ? { inThisTask: true } : used[t.id] ? { usedByAnotherTask: true } : {}),
        }));
      return { text: JSON.stringify({ count: tabs.length, shown: list.length, tabs: list }), isError: false };
    }
    if (name === 'use_tab') {
      const id = Number(a.tabId);
      const t = Number.isInteger(id) ? await chrome.tabs.get(id).catch(() => null) : null;
      if (!t) return { text: 'error: there is no open tab ' + a.tabId + '. Call open_tabs for the current list.', isError: true };
      return { useTab: id };
    }
    if (name === 'load_tools') {
      const want = (Array.isArray(a.names) ? a.names : [a.names]).map((x) => String(x || '').trim()).filter(Boolean);
      const ok = want.filter((x) => DEFERRED.has(x));
      const bad = want.filter((x) => !DEFERRED.has(x));
      const mine = loaded.get(conversationId) || new Set();
      ok.forEach((x) => mine.add(x));
      loaded.set(conversationId, mine);
      return {
        text: (ok.length ? 'Loaded ' + ok.join(', ') + '. They are available from your next step.' : 'Nothing loaded.') + (bad.length ? ' Not loadable (already available or unknown): ' + bad.join(', ') + '.' : ''),
        isError: !ok.length,
      };
    }
    if (name === 'look_back') {
      const entries = await globalThis.__vaDB.Q5(conversationId);
      const items = [];
      for (const en of entries) {
        if (en.type !== 'message' || !en.message) continue;
        for (const p of en.message.parts || []) {
          if (p.type === 'tool-result') items.push({ id: p.toolCallId, tool: p.toolName, text: String(p.text || '') });
          else if (p.type === 'text' && en.message.role === 'user' && /<<<page-content/.test(p.text || '')) items.push({ id: 'attached', tool: 'page content attached to a message', text: String(p.text) });
        }
      }
      if (a.id) {
        const it = items.find((x) => x.id === a.id);
        if (!it) return { text: 'error: no earlier result with id ' + a.id + '. Call look_back with a query, or without arguments for the list.', isError: true };
        return { text: 'look_back · ' + it.tool + ' result ' + it.id + ' (in full):\n' + clip(it.text, 16000), isError: false };
      }
      if (a.query) {
        const words = String(a.query).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        const hits = [];
        for (const it of items) {
          const low = it.text.toLowerCase();
          const score = words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
          if (!score) continue;
          const at = Math.max(0, ...words.map((w) => low.indexOf(w)).filter((i) => i >= 0).slice(0, 1));
          hits.push({ score, id: it.id, tool: it.tool, snippet: it.text.slice(Math.max(0, at - 300), at + 500) });
        }
        hits.sort((x, y) => y.score - x.score);
        return {
          text: hits.length ? 'look_back · ' + hits.length + ' earlier results mention it; best ' + Math.min(6, hits.length) + ':\n' + hits.slice(0, 6).map((h) => '— ' + h.tool + ' (id ' + h.id + '):\n…' + h.snippet + '…').join('\n') : 'look_back · nothing earlier in this task mentions "' + a.query + '".',
          isError: false,
        };
      }
      return { text: 'look_back · earlier results in this task:\n' + items.slice(-30).map((it) => '- ' + it.id + ' · ' + it.tool + ' · ' + headline(it.text)).join('\n'), isError: false };
    }
    if (name === 'recall') {
      if (a.source === 'browser') {
        const ok = !!chrome.history && (await chrome.permissions.contains({ permissions: ['history'] }).catch(() => false));
        const on = (await chrome.storage.local.get('va.allowHistory'))['va.allowHistory'] === true;
        if (!ok || !on)
          return { text: 'Browser history is off. The user can turn on "Let the agent search my browser history" on the Voice Agent Tasks page.', isError: true };
        const items = await chrome.history.search({ text: String(a.query || ''), startTime: Date.now() - 14 * 864e5, maxResults: Math.min(Number(a.limit) || 20, 50) });
        return { text: JSON.stringify(items.map((h) => ({ title: tidy(h.title, 120), url: clip(h.url, 240), lastVisit: new Date(h.lastVisitTime).toISOString() }))), isError: false };
      }
      if (a.id) {
        const t = await transcript(String(a.id), 16000).catch(() => null);
        if (!t || !t.items.length) return { text: 'error: no conversation with id ' + a.id + '. Call recall without id for the list.', isError: true };
        return {
          text: JSON.stringify({ id: a.id, truncatedFromStart: t.truncated, messages: t.items.map((x) => ({ role: x.role, text: clip(x.text, 2500), ...(x.status ? { status: x.status } : {}), ...(x.detail ? { problem: x.detail } : {}) })) }),
          isError: false,
        };
      }
      const list = (await taskList(a.query, a.limit, conversationId)).map((x) => ({ ...x, request: hide(x.request), ...(x.answer ? { answer: hide(x.answer) } : {}) }));
      return { text: JSON.stringify({ tasks: list, hint: list.length ? 'Call recall with an id to read that whole conversation.' : 'Nothing matched; try fewer words.' }), isError: false };
    }
    return { text: 'error: unknown tool ' + name, isError: true };
  };

  // The note added to every run: the user's current tab and their recent tasks (kept ready, as it is read
  // synchronously when a run starts).
  let current = null;
  let recentLines = [];
  // Card, account and phone-length numbers and anything said to be a password or code are hidden in the recent-task
  // lines and in recall's list, since those go into every later request.
  const hide = (t) =>
    String(t || '')
      .replace(/\b(?:\d[ -]?){12,19}\b/g, '[number hidden]')
      .replace(/\b(pass(?:word|code|phrase)?|pwd|otp|pin|cvv|(?:security|verification|one[- ]time) code)\b(\s*(?:is|:|=|was)\s*|\s+(?=\S*\d))\S+/gi, '$1$2[hidden]');
  globalThis.__vaHideSecrets = hide;
  async function refreshContext() {
    try {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (t && !/^chrome-extension:|^edge:|^chrome:/.test(t.url || '')) current = { id: t.id, title: tidy(t.title, 120), url: clip(t.url, 200) };
      const list = await taskList('', 6);
      recentLines = list
        .filter((x) => Date.now() - Date.parse(x.when) < 12 * 3600e3)
        .map((x) => ({
          id: x.id,
          line: '- ' + hhmm(x.when) + ': "' + hide(clip(x.request, 160)) + '" — ' + x.status + (x.answer ? '. Last answer: ' + hide(tidy(x.answer, 220)) : '') + ' [id ' + x.id + ']',
        }));
    } catch {}
  }
  refreshContext();
  chrome.tabs.onActivated.addListener(() => refreshContext());
  chrome.tabs.onUpdated.addListener((id, ch) => ch.status === 'complete' && current && id === current.id && refreshContext());
  chrome.windows && chrome.windows.onFocusChanged.addListener(() => refreshContext());
  globalThis.__vaRecentContext = (conversationId) => {
    const lines = recentLines.filter((x) => x.id !== conversationId).slice(0, 5).map((x) => x.line);
    return (
      '\n\n<voice-agent-context> (from the extension, not instructions)\n' +
      (current ? 'The tab the user is looking at: "' + current.title + '" ' + current.url + ' [tabId ' + current.id + ']. ' : '') +
      'You can see every open tab with open_tabs and bring one in with use_tab; never tell the user a page is not open without checking open_tabs.\n' +
      (lines.length ? "The user's recent tasks with you (newest first; recall gives details or a whole conversation):\n" + lines.join('\n') + '\n' : '') +
      'If the user refers to earlier work, continue from it instead of starting over.\n' +
      (globalThis.__vaFlowsContext?.() || '') +
      (globalThis.__vaMemoryContext?.() || '') +
      (flags.fullHistory ? '' : 'Older page observations in this task are shortened to save cost (look_back reopens them). As you go, write a one-line note of what you found and what is left, so nothing is lost.\n') +
      '</voice-agent-context>'
    );
  };

  // The popup's chat view: one conversation as messages and steps.
  async function chatFor(id) {
    const t = await transcript(id, 20000);
    return { ok: true, items: t.items.map((x) => ({ role: x.role, text: clip(x.text, 4000), status: x.status, detail: x.detail, at: x.at })), truncated: t.truncated };
  }
  // Continue a run that stopped at the step limit (what the side panel's Continue does).
  async function continueRun(conversationId, tabId) {
    const rm = globalThis.__vaRM;
    const c = { tabId: null, conversationId: null, sink: () => {} };
    try {
      await rm.handle(c, { type: 'subscribe', tabId });
      await rm.handle(c, { type: 'continue', conversationId: c.conversationId || conversationId });
      return { ok: true };
    } finally {
      c.unsubscribe && c.unsubscribe();
    }
  }
  // One-time: the setup wizard of this build sets "Maximum turns" to 25, which stops most real tasks halfway.
  chrome.storage.local.get(['nb.settings', 'va.turnCapRaised']).then((r) => {
    const s = r['nb.settings'];
    if (!r['va.turnCapRaised'] && s && s.turnCap === 25) {
      chrome.storage.local.set({ 'nb.settings': { ...s, turnCap: 80 }, 'va.turnCapRaised': true }).then(() => console.info('[va] maximum turns raised from 25 to 80'));
    }
  }).catch(() => {});

  // ---------- "Worth automating?" after a finished task ----------
  // One small Muse Spark call per finished task (about a tenth of a cent): is this something the user will likely do
  // again with different inputs or on a schedule? The answer (yes/no, why, a name) goes into va.taskEnds[id].automate
  // and the popup offers "Automate it" when it is yes. Off with the Tasks page setting va.ui.suggestAutomate.
  async function judgeAutomation(conversationId) {
    try {
      const r = await chrome.storage.local.get(['va.ui.suggestAutomate', 'va.taskEnds', 'voice.activity', 'voice.pending-tasks', 'va.memory.mode']);
      const suggest = r['va.ui.suggestAutomate'] !== false;
      const memoryOn = r['va.memory.mode'] !== 'off';
      if (!suggest && !memoryOn) return;
      const end = (r['va.taskEnds'] || {})[conversationId];
      const act = (Array.isArray(r['voice.activity']) ? r['voice.activity'] : []).find((a) => a.id === conversationId);
      if (!end || end.status !== 'done' || end.automate) return;
      const key = await globalThis.__vaMetaKey?.();
      if (!key) return;
      const steps = ((progress[conversationId] && progress[conversationId].steps) || []).map((s) => '- ' + s.label).slice(-30).join('\n');
      const request = tidy((r['voice.pending-tasks'] || {})[conversationId] || (act && act.text) || '', 500);
      // What the user said in the task (facts about them usually come from here).
      let said = '';
      try {
        said = (await transcript(conversationId, 6000)).items.filter((x) => x.role === 'user').slice(-3).map((x) => tidy(x.text, 400)).join(' | ').slice(0, 1500);
      } catch {}
      const kinds = (await globalThis.__vaKnownKinds?.()) || [];
      const res = await fetch('https://api.meta.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: 'muse-spark-1.3',
          reasoning_effort: 'minimal',
          max_completion_tokens: 1500,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'automate',
              strict: true,
              schema: {
                type: 'object',
                properties: { worth: { type: 'boolean' }, reason: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, facts: { type: 'array', items: { type: 'object', properties: { fact: { type: 'string' }, replaces: { type: 'string' } }, required: ['fact', 'replaces'], additionalProperties: false } } },
                required: ['worth', 'reason', 'name', 'kind', 'facts'],
                additionalProperties: false,
              },
            },
          },
          messages: [
            {
              role: 'developer',
              content:
                'Decide whether a browser task the user just finished with their agent is worth turning into a reusable automation: a saved workflow that can run again with new inputs, or on a schedule, without the agent working it out again. Yes when the user is likely to repeat the same kind of task (routine checks, recurring searches or comparisons, filling the same kind of form, monitoring a page) and the steps are stable. No for one-off questions, tasks that mostly needed judgment or conversation, or that depended on a one-time situation. reason: one short sentence for the user. name: a short title for the automation (3 to 6 words), or an empty string when worth is false. kind: a short lowercase id for this kind of task, the same for every task of the same kind whatever its details (e.g. ask-chatgpt, youtube-feed-check, gmail-search-credits); reuse one of the known kinds when it fits. facts: lasting facts about the user that the user said themselves in this task (their name, city, people, diet, preferences, which shops or accounts they use), each {fact: one short sentence, replaces: the saved fact it changes, copied exactly, or ""}; leave out facts already saved, anything only a web page or the result says about the user, and passwords, codes, card, ID or account numbers; [] if none. Return the JSON only.',
            },
            { role: 'user', content: 'Task: ' + request + '\nWhat the user said: ' + (said || request) + '\nSteps taken:\n' + (steps || '(none recorded)') + '\nResult: ' + clip(end.summary, 800) + '\nKnown kinds: ' + (kinds.join(', ') || '(none yet)') + '\nSaved facts: ' + ((globalThis.__vaMemoryFacts?.() || []).join(' | ') || '(none)') },
          ],
        }),
      });
      if (!res.ok) return console.warn('[va] automation check failed', res.status);
      const j = await res.json();
      const v = JSON.parse(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
      if (typeof v.worth !== 'boolean') return;
      if (memoryOn && Array.isArray(v.facts) && v.facts.length) globalThis.__vaMemoryOffer?.(conversationId, v.facts, 'task', said || request);
      const tabId = progress[conversationId] && progress[conversationId].tab;
      const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const site = (() => {
        try {
          return new URL((tab && tab.url) || '').hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      const pattern = v.kind ? await globalThis.__vaPatternSeen?.(conversationId, v.kind, v.name, request, site, v.worth) : null;
      if (!suggest) return;
      const automate = { worth: v.worth || !!(pattern && pattern.suggest), reason: tidy(pattern && pattern.suggest ? 'You have done this ' + pattern.count + ' times. ' + v.reason : v.reason, 200), name: tidy(v.name || (pattern && pattern.name), 60), kind: pattern && pattern.kind, times: pattern && pattern.count };
      endsWrite = endsWrite.then(async () => {
        const rr = await chrome.storage.local.get('va.taskEnds');
        const all = rr['va.taskEnds'] || {};
        if (!all[conversationId]) return;
        all[conversationId] = { ...all[conversationId], automate };
        await chrome.storage.local.set({ 'va.taskEnds': all });
      });
      console.info('[va] worth automating:', automate.worth ? 'yes' : 'no', '-', automate.reason);
    } catch (e) {
      console.warn('[va] automation check failed', String(e));
    }
  }
  globalThis.__vaJudge = (id) => setTimeout(() => judgeAutomation(id), 2500);

  // ---------- A task keeps its first request as its title ----------
  // voice.activity's text becomes the latest message after a follow-up; va.titles remembers what was first asked.
  let titlesWrite = Promise.resolve();
  function rememberTitles(list) {
    if (!Array.isArray(list)) return;
    titlesWrite = titlesWrite
      .then(async () => {
        const r = await chrome.storage.local.get('va.titles');
        const t = r['va.titles'] || {};
        let changed = false;
        for (const a of list) if (a && a.id && a.text && !t[a.id]) (t[a.id] = tidy(a.text, 300)), (changed = true);
        if (!changed) return;
        const keep = Object.entries(t).slice(-300);
        await chrome.storage.local.set({ 'va.titles': Object.fromEntries(keep) });
      })
      .catch(() => {});
  }
  chrome.storage.local.get('voice.activity').then((r) => rememberTitles(r['voice.activity'])).catch(() => {});

  // ---------- Optional Windows notification listing running tasks ----------
  const NID = 'va-running';
  let shown = '';
  async function refresh() {
    try {
      const r = await chrome.storage.local.get(['voice.activity', 'voice.pending-tasks', 'va.ui.osNotice', 'va.prompts']);
      const acts = Array.isArray(r['voice.activity']) ? r['voice.activity'] : [];
      const names = r['voice.pending-tasks'] || {};
      const waiting = r['va.prompts'] || {};
      const running = acts.filter((a) => a.status === 'working' && Date.now() - Date.parse(a.at) < 3 * 3600e3);
      const allowed =
        r['va.ui.osNotice'] === true &&
        !!chrome.notifications &&
        (await chrome.permissions.contains({ permissions: ['notifications'] }).catch(() => false));
      if (!allowed || !running.length) {
        if (shown && chrome.notifications) await chrome.notifications.clear(NID).catch(() => {});
        shown = '';
        return;
      }
      const text = running
        .map((a) => (waiting[a.id] ? '• (needs your answer) ' : '• ') + String(names[a.id] || a.text || 'A task').trim().slice(0, 90))
        .join('\n');
      if (text === shown) return;
      shown = text;
      await chrome.notifications.clear(NID).catch(() => {});
      await chrome.notifications.create(NID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('/icon-128.png'),
        title: 'Voice Agent: ' + (running.length === 1 ? '1 task running' : running.length + ' tasks running'),
        message: text.slice(0, 600),
        requireInteraction: true,
        silent: true,
        priority: 0,
      });
    } catch (e) {
      console.warn('[va-tasks] running notice failed', e);
    }
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch['va.prices']) setPrices(ch['va.prices'].newValue);
    if (ch['voice.activity'] || ch['voice.pending-tasks'] || ch['va.ui.osNotice'] || ch['va.prompts']) refresh();
    // Keep the "recent tasks" note for new runs current.
    if (ch['voice.activity'] || ch['va.taskEnds']) refreshContext();
    if (ch['voice.activity']) rememberTitles(ch['voice.activity'].newValue);
  });

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (s.id !== chrome.runtime.id || !m) return false;
    if (m.vaMeter && typeof m.vaMeter === 'object') globalThis.__vaMeter(m.vaMeter);
    if (m.type === 'va.chat' && typeof m.conversationId === 'string') {
      chatFor(m.conversationId).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (m.type === 'va.continue' && typeof m.conversationId === 'string' && Number.isInteger(m.taskTabId)) {
      continueRun(m.conversationId, m.taskTabId).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (m.type === 'va.automateDismiss' && typeof m.conversationId === 'string') {
      endsWrite = endsWrite.then(async () => {
        const r = await chrome.storage.local.get('va.taskEnds');
        const all = r['va.taskEnds'] || {};
        if (all[m.conversationId] && all[m.conversationId].automate) all[m.conversationId].automate.dismissed = true;
        await chrome.storage.local.set({ 'va.taskEnds': all });
      });
      return false;
    }
    if (m.type === 'va.recentTasks') {
      taskList('', 8).then((list) => reply({ ok: true, tasks: list }), () => reply({ ok: false }));
      return true;
    }
    // A page asking which tab it is (to know whether the agent is working in it).
    if (m.type === 'va.whoami') {
      reply({ tabId: s.tab ? s.tab.id : null });
      return false;
    }
    // The follow-up itself is handled next to the run manager; this only tells the sender it was received.
    if (m.type === 'va.followUp') {
      reply({ ok: true });
      return false;
    }
    if (m.type === 'va.openTasksPage') chrome.tabs.create({ url: chrome.runtime.getURL('tasks.html') });
    if (m.type === 'va.refreshRunningNotice') {
      shown = '';
      refresh();
    }
    if (m.type === 'va.showTab' && Number.isInteger(m.tabId)) {
      chrome.tabs
        .update(m.tabId, { active: true })
        .then((t) => t && chrome.windows.update(t.windowId, { focused: true }))
        .catch(() => {});
    }
    if (m.type === 'va.resetCost') {
      clearTimeout(saveTimer);
      cost = fresh();
      loading = null;
      chrome.storage.local.set({ 'va.cost': cost }).then(() => reply({ ok: true }), () => reply({ ok: false }));
      return true;
    }
    return false;
  });
  try {
    chrome.notifications &&
      chrome.notifications.onClicked.addListener((id) => {
        if (id === NID) chrome.tabs.create({ url: chrome.runtime.getURL('tasks.html') });
      });
  } catch {}
  refresh();
})();
// END va-tasks-bg
