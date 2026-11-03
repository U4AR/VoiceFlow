(async () => {
  const B64 = '__B64__';
  const bytes = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0));
  const txt = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const { base, showView } = JSON.parse(txt);
  const R = (window.__R = window.__R || { runs: [] });
  R.base = base; R.showView = showView;
  const flows = ['youtube-feed', 'amazon-search', 'ask-chatgpt', 'ask-claude', 'flipkart-search', 'price-compare'];
  const KINDS = ['cards', 'table', 'list', 'text', 'stats', 'bar'];
  const stub = (name, a, tools, st) => {
    switch (name) {
      case 'run_flow':
        if (a.id === 'ask-claude') return JSON.stringify({ ok: true, output: { answer: 'Gold (24K) is about ₹7,950 per gram in India today, 3 Nov 2026.', link: 'https://claude.ai/chat/abc' }, ms: 9000 });
        if (a.id === 'ask-chatgpt') return JSON.stringify({ ok: true, output: { answer: 'Thrissur today: 29°C, humid, evening showers likely.', link: 'https://chatgpt.com/c/abc' }, ms: 11000 });
        if (a.id === 'youtube-feed') return JSON.stringify({ ok: true, output: [{ title: 'ARC Prize 2026 explained', channel: 'Two Minute Papers', link: 'https://www.youtube.com/watch?v=a1', meta: '12K views · 2 days ago' }, { title: 'Learn Flutter in 1 hour', channel: 'freeCodeCamp.org', link: 'https://www.youtube.com/watch?v=a2', meta: '90K views · 1 week ago' }] });
        return 'error: there is no flow "' + a.id + '"';
      case 'navigate': st.url = a.url; return 'navigate ok · now on ' + a.url + ' · "' + (/claude/.test(a.url) ? 'New chat - Claude' : /chatgpt/.test(a.url) ? 'ChatGPT' : 'page') + '"\n[r1] textbox "' + (/claude/.test(a.url) ? 'Write your prompt to Claude' : 'Ask anything') + '"\n[r2] button "Send"';
      case 'type': return 'typed' + (a.submit || a.enter || a.pressEnter ? ' and submitted' : '') + ' · page changed: a reply is being written';
      case 'press': return 'pressed ' + (a.key || '') + ' · page changed: a reply is being written';
      case 'wait': return 'ok · condition met after 8.2 s';
      case 'read': case 'snapshot': return (/claude/.test(st.url || '') ? 'Claude: ' : 'Assistant: ') + 'Gold (24K) is about ₹7,950 per gram in India today.';
      case 'click': case 'set': return 'ok';
      case 'open_tabs': return JSON.stringify({ count: 3, tabs: [{ tabId: 11, title: 'YouTube', url: 'https://www.youtube.com/' }] });
      case 'remember': return 'the user is being asked whether to remember this (a card on the page); carry on with the task without waiting';
      case 'find_flows': return JSON.stringify({ saved: flows.map((id) => ({ id })) });
      case 'load_tools': if ((a.names || []).includes('show_view') && !tools.some((t) => t.function.name === 'show_view')) tools.push(showView); return 'loaded: ' + (a.names || []).join(', ');
      case 'show_view': {
        const errs = [];
        if (!a.title) errs.push('title');
        if (!Array.isArray(a.sections) || !a.sections.length) errs.push('sections');
        for (const s of a.sections || []) {
          if (!(s.source && flows.includes(s.source.flow)) && s.data === undefined) errs.push('source');
          if (!s.layout || !KINDS.includes(s.layout.kind)) errs.push('layout.kind');
        }
        st.view = { ok: !errs.length, errs, spec: a };
        return errs.length ? 'error: the view was not made: ' + errs.join(', ') : JSON.stringify({ shown: true, viewId: 'v1' });
      }
      case 'done': return 'ok';
    }
    return 'ok';
  };
  R.run = async (name, userText, opts = {}) => {
    const req = structuredClone(base);
    if (opts.noFlows) req.messages[0].content = req.messages[0].content.replace(/- ask-chatgpt: [^\n]*\n/, '').replace(/- ask-claude: [^\n]*\n/, '');
    const um = req.messages.find((m) => m.role === 'user');
    um.content[0].text = userText;
    const tools = req.tools.slice();
    if (!tools.some((t) => t.function.name === 'show_view') && opts.deferShowView === false) tools.push(showView);
    const log = [];
    const st = {};
    const t0 = Date.now();
    let calls = 0, inTok = 0, outTok = 0, modelMs = 0;
    for (let i = 0; i < 14; i++) {
      const t1 = Date.now();
      const r = await fetch('https://api.meta.ai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + R.key }, body: JSON.stringify({ ...req, tools }) });
      const j = await r.json();
      calls++;
      modelMs += Date.now() - t1;
      if (!r.ok) { log.push('ERR ' + JSON.stringify(j).slice(0, 200)); break; }
      inTok += (j.usage && j.usage.prompt_tokens) || 0;
      outTok += (j.usage && j.usage.completion_tokens) || 0;
      const m = j.choices[0].message;
      req.messages.push({ role: 'assistant', content: m.content || '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
      if (!m.tool_calls || !m.tool_calls.length) { log.push({ final: (m.content || '').slice(0, 300) }); break; }
      let end = false;
      for (const c of m.tool_calls) {
        let a = {};
        try { a = JSON.parse(c.function.arguments || '{}'); } catch {}
        const out = stub(c.function.name, a, tools, st);
        log.push({ tool: c.function.name, args: JSON.stringify(a).slice(0, 220), result: out.slice(0, 90) });
        req.messages.push({ role: 'tool', tool_call_id: c.id, content: out });
        if (c.function.name === 'done') { end = true; log.push({ final: String(a.text || a.summary || a.answer || JSON.stringify(a)).slice(0, 300) }); }
      }
      if (end) break;
    }
    const run = { name, calls, modelSecs: +(modelMs / 1000).toFixed(1), usd: +((inTok * 1.25 + outTok * 4.25) / 1e6).toFixed(4), inTok, outTok, log, view: st.view };
    R.runs.push(run);
    return run;
  };
  return 'ready: ' + base.tools.length + ' tools, model ' + base.model;
})();
