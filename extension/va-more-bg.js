// Voice Agent: memory about the user, views (pages that show results), and spotting tasks worth a flow.
//
//  - Memory (va.memory: [{id, fact, at, from}], va.memory.mode: 'ask' (default) | 'auto' | 'off'). The agent calls
//    remember when it learns a lasting fact about the user; after each finished task the "worth automating?" check
//    also lists facts it saw (no extra model call). In "ask" mode a card asks the user first (the task does not wait
//    for the answer); in "auto" mode facts are saved at once. Saved facts go into every task's instructions.
//    Secrets (passwords, codes, card/ID/account numbers) are never saved.
//  - Views (va.views): the agent's show_view tool makes a page (view.html?id=...) with sections that show a flow's
//    output (run when the page opens, with Refresh) or data from earlier steps, as cards, a table, a list, stats,
//    text or a bar chart. Several sections can come from different flows (a small dashboard).
//  - Common tasks (va.patterns): the same check names each finished task's kind ("ask-chatgpt", "youtube-feed-
//    summary"). When a kind comes back (2 times by default) and no flow covers it, the Tasks page suggests making one.
(() => {
  const F = globalThis.VAFlows;
  const clip = (v, n = 400) => String(v ?? '').slice(0, n);
  const tidy = (v, n) => clip(String(v ?? '').replace(/\s+/g, ' ').trim(), n);
  const uid = () => Math.random().toString(36).slice(2, 10);
  let chain = Promise.resolve();
  const edit = (key, fallback, fn) =>
    (chain = chain.then(async () => {
      const r = await chrome.storage.local.get(key);
      const v = r[key] ?? fallback;
      const out = await fn(v);
      await chrome.storage.local.set({ [key]: v });
      return out;
    }));

  // ---------- Memory ----------
  let memory = [];
  let mode = 'ask';
  const loadMemory = async () => {
    const r = await chrome.storage.local.get(['va.memory', 'va.memory.mode']);
    memory = Array.isArray(r['va.memory']) ? r['va.memory'] : [];
    mode = ['ask', 'auto', 'off'].includes(r['va.memory.mode']) ? r['va.memory.mode'] : 'ask';
  };
  loadMemory();
  chrome.storage.onChanged.addListener((ch, area) => area === 'local' && (ch['va.memory'] || ch['va.memory.mode']) && loadMemory());
  const SECRET = /\b(pass(word|code|phrase)?|pwd|otp|one[- ]time|pin\b|cvv|cvc|security code|api[ -]?key|token|secret|aadhaar|pan (card|number)|ssn|social security)\b|\b(?:\d[ -]?){12,19}\b|\bLLM_[A-Za-z0-9_-]{10,}/i;
  const norm = (s) => tidy(s, 200).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  function similar(a, b) {
    const A = new Set(norm(a).split(' ').filter((w) => w.length > 2));
    const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
    if (!A.size || !B.size) return false;
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n / Math.min(A.size, B.size) >= 0.8;
  }
  async function saveFact(fact, from) {
    fact = tidy(fact, 200);
    if (!fact || SECRET.test(fact)) return { saved: false, reason: 'not saved: it looks like a secret or account number' };
    return edit('va.memory', [], (list) => {
      const dup = list.find((m) => similar(m.fact, fact));
      if (dup) {
        dup.fact = fact;
        dup.at = new Date().toISOString();
        return { saved: true, updated: true };
      }
      list.unshift({ id: uid(), fact, at: new Date().toISOString(), from: from || 'agent' });
      if (list.length > 150) list.length = 150;
      return { saved: true };
    });
  }
  // Offer facts: saved now (auto), asked about (ask, without making the task wait), or ignored (off).
  const pending = []; // facts the user is being asked about (so the same fact is not asked twice)
  async function offerFacts(conversationId, facts, from) {
    facts = (facts || []).map((f) => tidy(f, 200)).filter((f) => f && !SECRET.test(f) && !memory.some((m) => similar(m.fact, f)) && !pending.some((x) => similar(x, f)));
    if (!facts.length || mode === 'off') return { saved: [], asked: [] };
    if (mode === 'auto') {
      for (const f of facts) await saveFact(f, from);
      console.info('[va] memory: saved', facts.length, 'fact(s)');
      return { saved: facts, asked: [] };
    }
    for (const f of facts.slice(0, 3)) {
      pending.push(f);
      globalThis.__vaAskUser?.(conversationId, { title: 'Remember this about you?', message: f, yes: 'Remember', no: 'Don’t', memory: true }, 24 * 3600 * 1000).then((a) => {
        pending.splice(pending.indexOf(f), 1);
        if (a === 'yes') saveFact(f, from).then(() => console.info('[va] memory: saved after you said yes'));
      });
    }
    console.info('[va] memory: asking about', facts.length, 'fact(s)');
    return { saved: [], asked: facts.slice(0, 3) };
  }
  globalThis.__vaMemoryOffer = offerFacts;
  globalThis.__vaMemoryContext = () => {
    if (mode === 'off') return '';
    const facts = memory.slice(0, 40).map((m) => '- ' + m.fact);
    const how =
      'When you learn a lasting fact about the user (their name, where they live, people they mention, preferences, the accounts or shops they use), call remember once with one short sentence' +
      (mode === 'ask' ? ' (the user is asked before it is kept; carry on with the task)' : '') +
      '. Never remember passwords, codes, card, ID or account numbers.\n';
    return (facts.length ? 'What you know about the user (saved memory; use it instead of asking again):\n' + facts.join('\n') + '\n' : '') + how;
  };

  // ---------- Views ----------
  const KINDS = ['cards', 'table', 'list', 'text', 'stats', 'bar'];
  // A layout without a kind: tell it from the fields it has, so a near-miss is not a wasted step.
  function guessKind(L) {
    if (Array.isArray(L.columns)) return 'table';
    if (Array.isArray(L.items)) return 'stats';
    if (L.value !== undefined && L.label !== undefined) return 'bar';
    if (L.image !== undefined || L.subtitle !== undefined || L.body !== undefined) return 'cards';
    if (L.note !== undefined) return 'list';
    if (L.text !== undefined) return 'text';
    if (L.title !== undefined || L.link !== undefined) return 'cards';
    return undefined;
  }
  function checkView(v) {
    const errs = [];
    if (!v || typeof v !== 'object') return ['give {title, sections:[...]}'];
    if (!v.title || String(v.title).length > 80) errs.push('title: a short title');
    const secs = Array.isArray(v.sections) ? v.sections : v.layout ? [{ source: v.source, data: v.data, layout: v.layout, path: v.path }] : null;
    if (!secs || !secs.length || secs.length > 6) errs.push('sections: 1 to 6 sections');
    for (const [i, s] of (secs || []).entries()) {
      const w = 'sections[' + i + ']';
      if (!s || typeof s !== 'object') {
        errs.push(w + ': an object');
        continue;
      }
      if (!(s.source && s.source.flow) && s.data === undefined) errs.push(w + ': give source {flow, input} (shown live) or data (from an earlier step)');
      if (s.data !== undefined && JSON.stringify(s.data).length > 60000) errs.push(w + '.data: too large; show a flow instead');
      if (s.layout && typeof s.layout === 'object' && !s.layout.kind) s.layout.kind = guessKind(s.layout);
      if (!s.layout || !KINDS.includes(s.layout.kind)) errs.push(w + '.layout.kind: one of ' + KINDS.join(', '));
      if (JSON.stringify(s.layout || {}).length > 3000) errs.push(w + '.layout: too large');
    }
    return errs.length ? errs : null;
  }
  async function showView(conversationId, a) {
    const spec = a.view || a;
    const errs = checkView(spec);
    if (errs) return { text: 'error: the view was not made: ' + errs.join('; ') + '. ' + VIEW_HELP, isError: true };
    const sections = Array.isArray(spec.sections) ? spec.sections : [{ source: spec.source, data: spec.data, layout: spec.layout, path: spec.path }];
    const flows = (await chrome.storage.local.get('va.flows'))['va.flows'] || {};
    for (const s of sections) if (s.source && s.source.flow && !flows[s.source.flow]) return { text: 'error: there is no saved flow "' + s.source.flow + '"', isError: true };
    const id = spec.id && /^[a-z0-9-]{3,40}$/.test(spec.id) ? spec.id : uid();
    const view = { id, title: tidy(spec.title, 80), sections: sections.map((s) => ({ title: s.title ? tidy(s.title, 80) : '', source: s.source, data: s.data, path: s.path ? String(s.path).slice(0, 80) : '', layout: s.layout })), conversationId, createdAt: new Date().toISOString() };
    await edit('va.views', {}, (all) => {
      all[id] = view;
      const ids = Object.keys(all);
      if (ids.length > 40) for (const k of ids.sort((x, y) => String(all[x].createdAt).localeCompare(String(all[y].createdAt))).slice(0, ids.length - 40)) delete all[k];
    });
    const url = chrome.runtime.getURL('view.html?id=' + id);
    if (a.open !== false) await chrome.tabs.create({ url, active: true }).catch(() => {});
    console.info('[va] view made:', view.title, '(' + view.sections.length + ' section(s))');
    return { text: JSON.stringify({ shown: true, viewId: id, title: view.title, note: 'The page is open in a new tab and stays on the Tasks page under Views; flow sections refresh each time it opens.' }), isError: false };
  }
  const VIEW_HELP =
    'Format: {title, sections:[{title?, source:{flow:"youtube-feed", input:{}} or data:[...], path?:"items", layout:{kind:"cards", title:"{{title}}", subtitle:"{{channel}}", link:"{{link}}", image:"{{thumb}}"}}]}. Layout kinds: cards {title, subtitle, body, link, image}; table {columns:[{label, value:"{{price}}"}], link}; list {text, note, link}; text {text:"{{briefing}}"}; stats {items:[{label, value}]}; bar {label:"{{title}}", value:"{{price}}"}.';
  // The view page asks the worker to run a section's flow.
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || m.type !== 'va.viewRun' || sender.id !== chrome.runtime.id || !(sender.url || '').startsWith(chrome.runtime.getURL('view.html'))) return;
    (async () => {
      const r = await globalThis.__vaFlowTools.run('view', 'run_flow', { id: String(m.flow), input: m.input || {} });
      if (r.isError) return { ok: false, error: r.text.replace(/^error:\s*/, '').split('\nSteps:')[0] };
      const j = JSON.parse(r.text);
      return { ok: true, output: j.output, ms: j.ms };
    })().then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  // ---------- Common tasks worth a flow ----------
  const THRESHOLD = 2;
  globalThis.__vaKnownKinds = async () => {
    const p = (await chrome.storage.local.get('va.patterns'))['va.patterns'] || {};
    return Object.values(p)
      .sort((a, b) => b.count - a.count)
      .slice(0, 30)
      .map((x) => x.kind + ' (' + x.name + ')');
  };
  const VAGUE = new Set(['one-off', 'other', 'unknown', 'misc', 'chat', 'question', 'conversation', 'none', 'general', 'personal-intro']);
  globalThis.__vaPatternSeen = async (conversationId, kind, name, request, site, worth) => {
    kind = String(kind || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    if (!kind || kind.length < 3 || VAGUE.has(kind)) return;
    const flows = (await chrome.storage.local.get('va.flows'))['va.flows'] || {};
    const words = kind.split('-').filter((w) => w.length > 2);
    const covered = Object.values(flows).some((r) => {
      const hay = (r.flow.id + ' ' + r.flow.name + ' ' + (r.flow.tags || []).join(' ')).toLowerCase();
      return words.length && words.filter((w) => hay.includes(w)).length / words.length >= 0.67;
    });
    const p = await edit('va.patterns', {}, (all) => {
      const x = (all[kind] ??= { kind, name: tidy(name || kind, 60), count: 0, examples: [], sites: [], firstAt: new Date().toISOString() });
      if (x.tasks && x.tasks.includes(conversationId)) return x;
      x.tasks = [...(x.tasks || []), conversationId].slice(-20);
      x.count++;
      x.lastAt = new Date().toISOString();
      if (name) x.name = tidy(name, 60);
      if (request && !x.examples.includes(tidy(request, 200))) x.examples = [tidy(request, 200), ...x.examples].slice(0, 5);
      if (site && !x.sites.includes(site)) x.sites = [...x.sites, site].slice(0, 5);
      x.covered = covered;
      // Repeated, and judged repeatable at least once (one-off chats that happen to recur are not suggested).
      if (worth) x.worthy = true;
      x.suggest = x.count >= THRESHOLD && !!x.worthy && !covered && !x.dismissed && !x.flowRequested;
      return { ...x };
    });
    if (p.suggest) console.info('[va] common task:', p.kind, '(' + p.count + ' times) could be a flow');
    return p;
  };
  // Tasks page: make a flow for a common task, or dismiss the suggestion.
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || !['va.patternFlow', 'va.patternDismiss', 'va.memoryAdd', 'va.memoryDelete', 'va.viewDelete'].includes(m.type)) return;
    if (sender.id !== chrome.runtime.id || !(sender.url || '').startsWith(chrome.runtime.getURL(''))) return;
    (async () => {
      if (m.type === 'va.memoryAdd') return saveFact(m.fact, 'you');
      if (m.type === 'va.memoryDelete') return edit('va.memory', [], (list) => void list.splice(0, list.length, ...list.filter((x) => x.id !== m.id))).then(() => ({ ok: true }));
      if (m.type === 'va.viewDelete') return edit('va.views', {}, (all) => void delete all[m.id]).then(() => ({ ok: true }));
      if (m.type === 'va.patternDismiss') return edit('va.patterns', {}, (all) => void (all[m.kind] && ((all[m.kind].dismissed = true), (all[m.kind].suggest = false)))).then(() => ({ ok: true }));
      const p = ((await chrome.storage.local.get('va.patterns'))['va.patterns'] || {})[m.kind];
      if (!p) return { ok: false, error: 'unknown task kind' };
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const text =
        'Make a reusable flow for a task I keep doing: ' + p.name + '. What I asked before: ' + p.examples.map((e) => '"' + e + '"').join('; ') +
        '. Open the site' + (p.sites.length ? ' (' + p.sites.join(', ') + ')' : '') + ', use inspect_page for selectors, make the parts that change inputs, add a notify step if it waits for a result, and test it with save_flow. Then tell me how to run it.';
      await edit('va.patterns', {}, (all) => void (all[m.kind] && ((all[m.kind].flowRequested = true), (all[m.kind].suggest = false))));
      const r = await globalThis.__vaStartTask?.(tab && tab.id, text);
      return { ok: true, started: !!r };
    })().then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  // ---------- Starter flows ----------
  // Quick actions that come with the extension, so "ask ChatGPT ..." or "ask Claude ..." is one run_flow step from the
  // first use. Each one is added once; if the user deletes it, it is not added again.
  const STARTERS = {"ask-chatgpt":{"id":"ask-chatgpt","name":"Ask ChatGPT","description":"Ask ChatGPT a question in the user's browser (normal chat, not Codex), wait for the whole answer and return it with the chat's link. Alerts the user when the answer arrives.","sites":["chatgpt.com"],"tags":["chatgpt","openai","ask","ai","chat","question"],"model":"none","inputs":{"question":{"type":"string","required":true,"description":"what to ask"},"alert":{"type":"boolean","default":true,"description":"show an alert when the answer arrives"}},"steps":[{"do":"open","url":"https://chatgpt.com/"},{"do":"extract","sel":":root","attr":"location","as":"start"},{"do":"assert","that":"{{start}}","op":"not","value":"/codex","message":"ChatGPT opened in Codex mode, not the normal chat"},{"do":"wait","for":"#prompt-textarea, textarea[name=\"prompt\"]","timeout":20000},{"do":"type","sel":"#prompt-textarea, textarea[name=\"prompt\"]","text":"{{question}}","enter":true},{"do":"wait","for":"[data-message-author-role=\"assistant\"], li[data-message-role=\"assistant\"]","timeout":60000},{"do":"wait","for":"[data-testid=\"stop-button\"], button[aria-label*=\"Stop\"]","gone":true,"timeout":180000},{"do":"wait","for":"[data-message-author-role=\"assistant\"] .markdown, li[data-message-role=\"assistant\"] [data-assistant-markdown]","stable":1500,"last":true,"timeout":60000},{"do":"extract","sel":"[data-message-author-role=\"assistant\"] .markdown, li[data-message-role=\"assistant\"] [data-assistant-markdown]","last":true,"as":"answer"},{"do":"extract","sel":":root","attr":"location","as":"link"},{"do":"notify","if":"{{alert}}","title":"ChatGPT answered","message":"{{answer}}"}],"output":{"answer":"{{answer}}","link":"{{link}}"},"notes":"Checked on chatgpt.com (Nov 2026, signed out; works signed in too): the box is #prompt-textarea (wide window) or textarea[name=prompt] (narrow). Enter sends. Run with keepOpen true to leave the chat open."},"ask-claude":{"id":"ask-claude","name":"Ask Claude","description":"Ask Claude (claude.ai) a question in the user's browser, wait for the whole answer and return it with the chat's link. Alerts the user when the answer arrives. Needs the user signed in to claude.ai.","sites":["claude.ai"],"tags":["claude","anthropic","ask","ai","chat","question"],"model":"none","inputs":{"question":{"type":"string","required":true,"description":"what to ask"},"alert":{"type":"boolean","default":true,"description":"show an alert when the answer arrives"}},"steps":[{"do":"open","url":"https://claude.ai/new"},{"do":"wait","for":"[data-testid=\"chat-input\"], div.ProseMirror[contenteditable=\"true\"]","timeout":25000},{"do":"type","sel":"[data-testid=\"chat-input\"], div.ProseMirror[contenteditable=\"true\"]","text":"{{question}}","enter":true},{"do":"wait","for":"[data-is-streaming]","timeout":60000},{"do":"wait","for":"[data-is-streaming=\"true\"]","gone":true,"timeout":180000},{"do":"wait","for":"[data-is-streaming=\"false\"] .standard-markdown","stable":1200,"last":true,"timeout":30000},{"do":"extract","sel":"[data-is-streaming=\"false\"] .standard-markdown","last":true,"as":"answer"},{"do":"extract","sel":":root","attr":"location","as":"link"},{"do":"notify","if":"{{alert}}","title":"Claude answered","message":"{{answer}}"}],"output":{"answer":"{{answer}}","link":"{{link}}"},"notes":"Checked on claude.ai (Nov 2026): the box is [data-testid=chat-input] (ProseMirror), Enter sends; a reply is [data-is-streaming] and becomes \"false\" when done. If not signed in, the box never appears."}};
  async function seedStarters() {
    const r = await chrome.storage.local.get(['va.flows', 'va.starters']);
    const done = new Set(r['va.starters'] || []);
    const todo = Object.keys(STARTERS).filter((id) => !done.has(id));
    if (!todo.length) return;
    const all = r['va.flows'] || {};
    const now = new Date().toISOString();
    for (const id of todo) {
      if (!all[id] && globalThis.VAFlows && globalThis.VAFlows.validate(STARTERS[id]).ok) all[id] = { flow: STARTERS[id], source: 'local', starter: true, approved: true, tested: true, savedAt: now, runs: 0, ok: 0, fail: 0 };
      done.add(id);
    }
    await chrome.storage.local.set({ 'va.flows': all, 'va.starters': [...done] });
    console.info('[va] starter flows added:', todo.join(', '));
  }
  seedStarters().catch((e) => console.warn('[va] starter flows:', e && e.message));

  // ---------- The agent's tools ----------
  const NAMES = ['remember', 'show_view'];
  globalThis.__vaMoreTools = {
    names: NAMES,
    async run(conversationId, name, a) {
      if (name === 'remember') {
        if (mode === 'off') return { text: 'memory is off in the user’s settings; nothing was saved', isError: false };
        const fact = tidy(a.fact, 200);
        if (!fact) return { text: 'error: give the fact as one short sentence', isError: true };
        if (SECRET.test(fact)) return { text: 'error: not saved: it looks like a password, code or account number, which are never remembered', isError: true };
        const r = await offerFacts(conversationId, [fact], 'agent');
        if (r.saved.length) return { text: 'remembered: ' + fact, isError: false };
        if (r.asked.length) return { text: 'the user is being asked whether to remember this (a card on the page); carry on with the task without waiting', isError: false };
        return { text: 'already remembered', isError: false };
      }
      if (name === 'show_view') return showView(conversationId, a);
      return { text: 'error: unknown tool ' + name, isError: true };
    },
  };
})();
