// Voice Agent flows: small, tested functions for the browser that the agent (or another agent) can save, share
// and run in one step instead of working a site out again.
//
// A flow is plain JSON (no code): inputs, a list of steps and an output. Steps act on a page (open, wait, extract,
// read, click, type, press, scroll, back), work on data deterministically (set, filter, sort, take, format), ask an
// AI model (ai, with a recommended model class: fast or strong), loop (each) or call another flow (flow). The same
// file is used by the extension's worker and by the online library (Cloudflare Worker), so a flow that validates in
// one validates in the other.
//
// Safety: a flow can only open pages on the sites it declares (the origin of every URL is fixed, inputs only fill
// the path or query), cannot type into password fields, and refuses to click anything that pays, orders, sends,
// submits, posts, deletes or subscribes; those stay with the agent, whose normal tools ask the user.
(function (root) {
  'use strict';
  const ID = /^[a-z][a-z0-9-]{1,63}$/;
  const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
  const PATH = /^[A-Za-z_][A-Za-z0-9_]{0,31}(\.[A-Za-z0-9_]{1,32}){0,4}$/;
  const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
  const PAGE = ['open', 'wait', 'extract', 'read', 'click', 'type', 'press', 'scroll', 'back', 'sleep'];
  const DATA = ['set', 'filter', 'sort', 'take', 'format', 'map', 'concat', 'unique'];
  const KINDS = new Set([...PAGE, ...DATA, 'ai', 'each', 'flow', 'return', 'notify', 'assert']);
  const ACTS = new Set(['click', 'type', 'press']);
  const MODELS = { fast: 'muse-spark-1.3', strong: 'muse-wonder-1.0' };
  const RISKY = /\b(buy|pay|payment|place (your )?order|check ?out|purchase|send|submit|delete|remove|discard|trash|post|publish|tweet|reply|transfer|confirm|subscribe|unsubscribe|follow|unfollow|sign ?out|log ?out|archive|report|block)\b/i;
  const LIMITS = { steps: 40, depth: 3, eachMax: 50, json: 20000, notes: 2000, outChars: 20000 };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v, n) => typeof v === 'string' && v.length <= n;

  // ---------- Validation ----------
  function validate(flow) {
    const errors = [];
    const err = (where, msg) => errors.length < 25 && errors.push(where + ': ' + msg);
    if (!isObj(flow)) return { ok: false, errors: ['the flow must be a JSON object'] };
    let size = 0;
    try {
      size = JSON.stringify(flow).length;
    } catch {
      return { ok: false, errors: ['the flow is not plain JSON'] };
    }
    if (size > LIMITS.json) err('flow', 'too large (' + size + ' characters, at most ' + LIMITS.json + ')');
    const allowedTop = new Set(['id', 'name', 'description', 'version', 'sites', 'tags', 'model', 'inputs', 'steps', 'output', 'notes', 'author', 'source', 'tested']);
    for (const k of Object.keys(flow)) if (!allowedTop.has(k)) err('flow', 'unknown field "' + k + '"');
    if (!ID.test(flow.id || '')) err('id', 'use lowercase letters, digits and dashes, starting with a letter (e.g. "gmail-search")');
    if (!str(flow.name, 80) || !flow.name.trim()) err('name', 'a short title (1 to 80 characters)');
    if (!str(flow.description, 500) || flow.description.trim().length < 10) err('description', 'what it does, its inputs and what it returns (10 to 500 characters)');
    if (flow.version !== undefined && !(Number.isInteger(flow.version) && flow.version >= 1 && flow.version < 1e6)) err('version', 'a whole number from 1');
    if (flow.model !== undefined && !['none', 'fast', 'strong'].includes(flow.model)) err('model', 'none, fast or strong');
    if (flow.notes !== undefined && !str(flow.notes, LIMITS.notes)) err('notes', 'text up to ' + LIMITS.notes + ' characters');
    if (flow.tags !== undefined && !(Array.isArray(flow.tags) && flow.tags.length <= 10 && flow.tags.every((t) => str(t, 30)))) err('tags', 'up to 10 short words');
    const sites = Array.isArray(flow.sites) ? flow.sites.map((s) => String(s).toLowerCase().replace(/^www\./, '')) : [];
    if (!Array.isArray(flow.sites) || flow.sites.length > 10 || !sites.every((s) => HOST.test(s))) err('sites', 'a list of up to 10 host names the flow opens, e.g. ["mail.google.com"] (no https://, no paths)');
    const inputs = flow.inputs === undefined ? {} : flow.inputs;
    if (!isObj(inputs) || Object.keys(inputs).length > 10) err('inputs', 'an object of up to 10 named inputs');
    else
      for (const [k, v] of Object.entries(inputs)) {
        if (!NAME.test(k) || k === 'input' || k === 'item' || k === 'index') err('inputs.' + k, 'input names are letters, digits and _ (not input, item or index)');
        else if (!isObj(v) || !['string', 'number', 'boolean'].includes(v.type)) err('inputs.' + k, 'give {"type":"string"|"number"|"boolean","description":"...","required":true|false,"default":...}');
        else if (v.description !== undefined && !str(v.description, 200)) err('inputs.' + k + '.description', 'up to 200 characters');
      }
    const ctx = { err, sites, steps: 0, acts: false, ai: false, calls: new Set(), declared: new Set(Object.keys(isObj(inputs) ? inputs : {})) };
    if (!Array.isArray(flow.steps) || !flow.steps.length) err('steps', 'a non-empty list of steps');
    else checkSteps(flow.steps, 'steps', ctx, 0);
    if (ctx.steps > LIMITS.steps) err('steps', 'at most ' + LIMITS.steps + ' steps in total (counting steps inside each)');
    if (flow.output !== undefined && typeof flow.output !== 'string' && !isObj(flow.output)) err('output', 'a template such as "{{mails}}" or an object of templates');
    const pageSteps = countKinds(flow.steps || [], (k) => PAGE.includes(k));
    if (pageSteps && !countKinds(flow.steps || [], (k) => k === 'open')) err('steps', 'a flow that works on pages must start by opening one (a step {"do":"open","url":"https://..."})');
    if (pageSteps && !sites.length) err('sites', 'list the sites the flow opens');
    const tips = [];
    const opens = [];
    (function walk(st) {
      for (const x of st || []) if (isObj(x)) (x.do === 'open' && typeof x.url === 'string' && opens.push(x.url), Array.isArray(x.steps) && walk(x.steps));
    })(flow.steps);
    if (opens.some((u) => /[?&][^=&]+=[^&{]*[A-Za-z0-9][^&{]*(&|$)/.test(u.replace(/\{\{[^}]*\}\}/g, ''))) && !Object.keys(isObj(inputs) ? inputs : {}).length)
      tips.push('this flow has no inputs but its address has fixed search words or filters; make the parts that change inputs (e.g. https://site/s?k={{query}}) so it works for the next request too');
    return {
      ok: !errors.length,
      errors,
      tips,
      acts: ctx.acts,
      usesAI: ctx.ai,
      calls: [...ctx.calls],
      stepCount: ctx.steps,
    };
  }
  function countKinds(steps, test) {
    let n = 0;
    for (const s of steps || []) {
      if (!isObj(s)) continue;
      if (test(s.do)) n++;
      if (Array.isArray(s.steps)) n += countKinds(s.steps, test);
    }
    return n;
  }
  function checkTemplateRefs(v, where, ctx) {
    const scan = (x) => {
      if (typeof x === 'string') {
        for (const m of x.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!PATH.test(m[1]) && !/^[A-Za-z_][A-Za-z0-9_]*(\.\d+|\.[A-Za-z0-9_]+)*$/.test(m[1])) ctx.err(where, 'bad placeholder {{' + m[1] + '}} (use names like {{query}} or {{mails.0.subject}})');
      } else if (Array.isArray(x)) x.forEach(scan);
      else if (isObj(x)) Object.values(x).forEach(scan);
    };
    scan(v);
  }
  function checkSteps(steps, where, ctx, depth) {
    if (depth > 2) return ctx.err(where, 'each can be nested at most twice');
    steps.forEach((s, i) => {
      const w = where + '[' + i + ']';
      ctx.steps++;
      if (!isObj(s) || !KINDS.has(s.do)) return ctx.err(w, 'each step needs "do": one of ' + [...KINDS].join(', '));
      if (s.as !== undefined && !(typeof s.as === 'string' && PATH.test(s.as))) ctx.err(w + '.as', 'a variable name such as "mails" or "item.body"');
      if (s.if !== undefined && typeof s.if !== 'string') ctx.err(w + '.if', 'a template such as "{{query}}"');
      if (s.optional !== undefined && typeof s.optional !== 'boolean') ctx.err(w + '.optional', 'true or false');
      checkTemplateRefs(s, w, ctx);
      const need = (k, test, msg) => (test(s[k]) ? true : (ctx.err(w + '.' + k, msg), false));
      const sel = (v) => typeof v === 'string' && v.length > 0 && v.length <= 300;
      switch (s.do) {
        case 'open': {
          if (!need('url', (v) => str(v, 2000), 'the address to open, e.g. "https://www.amazon.in/s?k={{query}}"')) break;
          const m = /^https:\/\/([^/?#{}]+)(?=[/?#]|$)/i.exec(s.url);
          if (!m) {
            ctx.err(w + '.url', 'must start with https:// and a fixed host name (inputs may only fill the path or query)');
            break;
          }
          const host = m[1].toLowerCase().replace(/^www\./, '');
          if (!ctx.sites.some((x) => hostIn(host, x))) ctx.err(w + '.url', 'host ' + host + ' is not in "sites"');
          break;
        }
        case 'wait':
          if (s.for === undefined && s.text === undefined) ctx.err(w, 'give "for" (a CSS selector) or "text" to wait for');
          if (s.for !== undefined && !sel(s.for)) ctx.err(w + '.for', 'a CSS selector');
          if (s.timeout !== undefined && !(Number.isFinite(s.timeout) && s.timeout >= 100 && s.timeout <= 180000)) ctx.err(w + '.timeout', '100 to 180000 ms');
          if (s.gone !== undefined && typeof s.gone !== 'boolean') ctx.err(w + '.gone', 'true to wait until nothing matches "for" (e.g. a stop or loading button)');
          if (s.stable !== undefined && !(Number.isFinite(s.stable) && s.stable >= 200 && s.stable <= 20000)) ctx.err(w + '.stable', 'ms the text of "for" must stay unchanged (200 to 20000), e.g. for a streaming answer');
          break;
        case 'assert':
          need('that', (v) => typeof v === 'string', 'the value to check, e.g. "{{url}}"');
          need('op', (v) => ['contains', 'equals', 'not', 'gt', 'lt', 'gte', 'lte', 'matches', 'exists'].includes(v), 'contains, equals, not, gt, lt, gte, lte, matches or exists');
          need('message', (v) => str(v, 300), 'what went wrong if the check fails (shown to the agent)');
          break;
        case 'notify':
          need('title', (v) => str(v, 120), 'a short title, e.g. "ChatGPT answered"');
          if (s.message !== undefined && !str(s.message, 2000)) ctx.err(w + '.message', 'up to 2000 characters (templates allowed)');
          break;
        case 'extract':
          if (!s.as) ctx.err(w + '.as', 'name the result, e.g. "mails"');
          if (s.items !== undefined) {
            need('items', sel, 'a CSS selector matching each item (e.g. "tr.zA")');
            if (!isObj(s.fields) || !Object.keys(s.fields).length || Object.keys(s.fields).length > 15) ctx.err(w + '.fields', 'an object of up to 15 fields: {"subject": "span.bog", "link": {"sel": "a", "attr": "href"}}');
            else
              for (const [k, f] of Object.entries(s.fields)) {
                if (!NAME.test(k)) ctx.err(w + '.fields.' + k, 'field names are letters, digits and _');
                if (!(typeof f === 'string' ? f.length <= 300 : isObj(f) && (f.sel === undefined || typeof f.sel === 'string') && (f.attr === undefined || /^[a-zA-Z][a-zA-Z0-9_:-]{0,40}$/.test(f.attr))))
                  ctx.err(w + '.fields.' + k, 'a selector string, or {"sel": "...", "attr": "text"|"href"|"src"|"title"|any attribute}');
              }
            if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit >= 1 && s.limit <= 100)) ctx.err(w + '.limit', '1 to 100');
          } else need('sel', sel, 'give "items" + "fields" for a list, or "sel" (+ "attr") for one value');
          break;
        case 'read':
          if (!s.as) ctx.err(w + '.as', 'name the result');
          if (s.sel !== undefined && !sel(s.sel)) ctx.err(w + '.sel', 'a CSS selector');
          if (s.max !== undefined && !(Number.isInteger(s.max) && s.max >= 100 && s.max <= 20000)) ctx.err(w + '.max', '100 to 20000 characters');
          break;
        case 'click':
          ctx.acts = true;
          if (s.sel === undefined && s.text === undefined) ctx.err(w, 'give "sel" (CSS selector) or "text" (the visible label)');
          if (s.sel !== undefined && !sel(s.sel)) ctx.err(w + '.sel', 'a CSS selector');
          if (s.text !== undefined && !str(s.text, 200)) ctx.err(w + '.text', 'up to 200 characters');
          if (s.nth !== undefined && !(typeof s.nth === 'string' || (Number.isInteger(s.nth) && s.nth >= 0 && s.nth < 500))) ctx.err(w + '.nth', '0-based position, or a template such as "{{index}}"');
          break;
        case 'type':
          ctx.acts = true;
          need('sel', sel, 'the CSS selector of the box to type into');
          need('text', (v) => str(v, 2000), 'what to type (templates allowed, e.g. "{{query}}")');
          break;
        case 'press':
          ctx.acts = true;
          need('key', (v) => ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'End', 'Home'].includes(v), 'Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, PageUp, End or Home');
          break;
        case 'scroll':
          if (s.times !== undefined && !(Number.isInteger(s.times) && s.times >= 1 && s.times <= 10)) ctx.err(w + '.times', '1 to 10');
          break;
        case 'sleep':
          need('ms', (v) => Number.isFinite(v) && v >= 0 && v <= 10000, '0 to 10000');
          break;
        case 'back':
          break;
        case 'set':
          if (!s.as) ctx.err(w + '.as', 'name the result');
          if (!('value' in s)) ctx.err(w + '.value', 'the value or template to store');
          break;
        case 'filter':
          need('in', (v) => typeof v === 'string', 'the list, e.g. "{{mails}}"');
          need('field', (v) => typeof v === 'string' && v.length <= 64, 'the field to compare');
          need('op', (v) => ['contains', 'equals', 'not', 'gt', 'lt', 'gte', 'lte', 'matches', 'exists'].includes(v), 'contains, equals, not, gt, lt, gte, lte, matches or exists');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          if (s.op === 'matches') try { new RegExp(String(s.value)); } catch { ctx.err(w + '.value', 'not a valid regular expression'); }
          break;
        case 'sort':
          need('in', (v) => typeof v === 'string', 'the list');
          need('by', (v) => typeof v === 'string', 'the field to sort by');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'take':
          need('in', (v) => typeof v === 'string', 'the list');
          need('n', (v) => (Number.isInteger(v) && v >= 0 && v <= 100) || typeof v === 'string', '0 to 100');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'format':
          need('template', (v) => str(v, 4000), 'text with placeholders');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'map':
          need('in', (v) => typeof v === 'string', 'the list, e.g. "{{products}}"');
          if (s.item !== undefined && !NAME.test(s.item)) ctx.err(w + '.item', 'the item variable name (default "item")');
          if (s.value === undefined && !isObj(s.set)) ctx.err(w, 'give "set" (fields to add to each item, e.g. {"source": "amazon"}) or "value" (what each item becomes, e.g. {"name": "{{item.title}}"})');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'concat':
          need('in', (v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => typeof x === 'string'), 'a list of 1 to 10 lists to join, e.g. ["{{amazon}}", "{{flipkart}}"]');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'unique':
          need('in', (v) => typeof v === 'string', 'the list');
          need('by', (v) => typeof v === 'string' && v.length <= 64, 'the field that identifies an item (e.g. "link")');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'ai':
          ctx.ai = true;
          need('prompt', (v) => str(v, 4000) && v.trim().length > 5, 'the instruction for the model (templates allowed)');
          if (s.model !== undefined && !['fast', 'strong'].includes(s.model)) ctx.err(w + '.model', 'fast (Muse Spark, cheap) or strong (Muse Wonder)');
          if (s.json !== undefined && typeof s.json !== 'boolean' && !isObj(s.json)) ctx.err(w + '.json', 'true, or an example object of the JSON to return');
          if (s.max !== undefined && !(Number.isInteger(s.max) && s.max >= 50 && s.max <= 4000)) ctx.err(w + '.max', '50 to 4000 output tokens');
          if (!s.as) ctx.err(w + '.as', 'name the result');
          break;
        case 'each':
          need('in', (v) => typeof v === 'string', 'the list to go through, e.g. "{{mails}}"');
          if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit >= 1 && s.limit <= LIMITS.eachMax)) ctx.err(w + '.limit', '1 to ' + LIMITS.eachMax);
          if (s.item !== undefined && !NAME.test(s.item)) ctx.err(w + '.item', 'the loop variable name (default "item")');
          if (!Array.isArray(s.steps) || !s.steps.length) ctx.err(w + '.steps', 'the steps to run for each item');
          else checkSteps(s.steps, w + '.steps', ctx, depth + 1);
          break;
        case 'flow':
          if (need('id', (v) => typeof v === 'string' && ID.test(v), 'the id of the flow to call')) ctx.calls.add(s.id);
          if (s.input !== undefined && !isObj(s.input)) ctx.err(w + '.input', 'an object of input values (templates allowed)');
          break;
        case 'return':
          if (!('value' in s)) ctx.err(w + '.value', 'what to return, e.g. "{{mails}}"');
          break;
      }
    });
  }
  function hostIn(host, site) {
    const s = site.replace(/^\*\./, '');
    return host === s || host.endsWith('.' + s);
  }

  // ---------- Templates ----------
  function get(scope, path) {
    let v = scope;
    for (const k of String(path).split('.')) {
      if (v === null || v === undefined) return undefined;
      if (typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
      v = v[k];
    }
    return v;
  }
  function setPath(scope, path, value) {
    const ks = String(path).split('.');
    let o = scope;
    for (const k of ks.slice(0, -1)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      if (!isObj(o[k]) && !Array.isArray(o[k])) o[k] = {};
      o = o[k];
    }
    const last = ks[ks.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
    o[last] = value;
  }
  // "{{x}}" alone gives x itself (a list stays a list); inside text it is written out. In URLs values are encoded.
  function render(t, scope, mode) {
    if (typeof t === 'string') {
      const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(t);
      if (whole && mode !== 'url') return get(scope, whole[1]);
      return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => {
        const v = get(scope, p);
        const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return mode === 'url' ? encodeURIComponent(s) : s;
      });
    }
    if (Array.isArray(t)) return t.map((x) => render(x, scope, mode));
    if (isObj(t)) return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, render(v, scope, mode)]));
    return t;
  }
  function truthy(v) {
    return !(v === undefined || v === null || v === false || v === '' || v === 0 || (Array.isArray(v) && !v.length));
  }

  // ---------- Page operations (run inside the page by chrome.scripting; they must stay self-contained) ----------
  function pageOp(step) {
    const RISKY_RE = new RegExp(step.__risky, 'i');
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const valueOf = (e, attr) => {
      if (!e) return null;
      if (!attr || attr === 'text') return clean(e.innerText || e.textContent).slice(0, 2000);
      if (attr === 'href') return e.href || (e.closest('a') && e.closest('a').href) || e.getAttribute('href');
      if (attr === 'src') return e.currentSrc || e.src || e.getAttribute('src');
      if (attr === 'value') return e.value;
      if (attr === 'location') return location.href;
      if (attr === 'url') {
        // A link without its tracking: the address the link leads to, minus ?query and #part (and unwrapped from
        // redirect links that carry it in a url= parameter).
        const h = e.href || (e.closest('a') && e.closest('a').href) || e.getAttribute('href');
        if (!h) return null;
        try {
          let u = new URL(h, location.href);
          const inner = u.searchParams.get('url') || u.searchParams.get('uddg') || u.searchParams.get('u') || u.searchParams.get('q') || u.searchParams.get('dest');
          if (inner && /^(https?:)?\/\//.test(inner) || (inner && inner.startsWith('/'))) u = new URL(inner, u.origin);
          const keep = u.hostname.endsWith('youtube.com') && u.searchParams.get('v') ? '?v=' + u.searchParams.get('v') : '';
          return u.origin + u.pathname.replace(/\/ref=[^/]*$/, '') + keep;
        } catch {
          return h;
        }
      }
      if (attr === 'html') return null;
      return e.getAttribute(attr);
    };
    const pick = (base, sel) => (!sel || sel === '.' || sel === ':scope' ? base : base.querySelector(sel));
    // Sites such as Gmail keep hidden copies of lists and views: prefer the first match that is on screen.
    const firstShown = (sel) => {
      const all = document.querySelectorAll(sel);
      for (let i = 0; i < all.length && i < 300; i++) if (visible(all[i])) return all[i];
      return all[0] || null;
    };
    const lastShown = (sel) => {
      const all = [...document.querySelectorAll(sel)];
      for (let i = all.length - 1; i >= 0; i--) if (visible(all[i])) return all[i];
      return all[all.length - 1] || null;
    };
    const byText = (text, sel) => {
      const want = clean(text).toLowerCase();
      const pool = [...document.querySelectorAll(sel || 'a,button,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],input[type=submit],input[type=button],summary,label,li,td,span,div')];
      const hits = pool.filter((e) => visible(e) && clean(e.innerText || e.value || e.getAttribute('aria-label')).toLowerCase().includes(want));
      // Shortest label first; for the same label, the innermost element (the button, not the box around it).
      const depth = (e) => {
        let d = 0;
        for (let x = e; x; x = x.parentElement) d++;
        return d;
      };
      hits.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length || depth(b) - depth(a));
      return hits;
    };
    try {
      switch (step.do) {
        case 'wait': {
          if (step.for) {
            if (step.gone) {
              const any = [...document.querySelectorAll(step.for)].some((x) => visible(x));
              return { ok: !any };
            }
            const e = step.last ? lastShown(step.for) : step.visible === false ? document.querySelector(step.for) : firstShown(step.for);
            if (step.stable) return { ok: !!e, value: e ? clean(e.innerText || e.textContent) : null };
            return { ok: !!e && (step.visible === false || visible(e)) };
          }
          return { ok: clean(document.body && document.body.innerText).toLowerCase().includes(clean(step.text).toLowerCase()) };
        }
        case 'extract': {
          if (step.items) {
            const rows = [...document.querySelectorAll(step.items)].filter((e) => step.hidden || visible(e)).slice(0, step.limit || 20);
            const out = rows.map((row, i) => {
              const o = {};
              for (const [k, f] of Object.entries(step.fields)) {
                const spec = typeof f === 'string' ? { sel: f } : f;
                if (spec.all) o[k] = [...row.querySelectorAll(spec.sel)].map((e) => valueOf(e, spec.attr)).filter((x) => x).slice(0, 20);
                else o[k] = valueOf(pick(row, spec.sel), spec.attr);
              }
              o.index = i;
              return o;
            });
            return { ok: true, value: out, found: document.querySelectorAll(step.items).length };
          }
          if (step.all) return { ok: true, value: [...document.querySelectorAll(step.sel)].slice(0, step.limit || 50).map((e) => valueOf(e, step.attr)) };
          const e = step.last ? lastShown(step.sel) : firstShown(step.sel);
          return { ok: true, value: valueOf(e, step.attr), found: e ? 1 : 0 };
        }
        case 'read': {
          const e = step.sel ? firstShown(step.sel) : firstShown('main,[role=main]') || document.body;
          if (!e) return { ok: false, error: 'nothing matches ' + step.sel };
          return { ok: true, value: clean(e.innerText).slice(0, step.max || 6000) };
        }
        case 'click': {
          let list = step.text ? byText(step.text, step.sel) : [...document.querySelectorAll(step.sel)].filter(visible);
          const e = list[Number(step.nth) || 0];
          if (!e) return { ok: false, error: 'nothing to click: ' + (step.text ? '"' + step.text + '"' : step.sel) + (list.length ? ' (only ' + list.length + ' found)' : '') };
          const label = clean(e.innerText || e.value || e.getAttribute('aria-label') || e.title).slice(0, 80);
          const isButtonLike = e.matches('button,[role=button],input[type=submit],input[type=button],a');
          if ((isButtonLike || label.length <= 30) && RISKY_RE.test(label)) return { ok: false, error: 'flows do not press "' + label + '" (it could pay, send, post or delete); leave that step to the agent, which asks you' };
          if (e.closest('form') && e.matches('[type=submit]') && e.closest('form').querySelector('input[type=password]')) return { ok: false, error: 'flows do not submit sign-in forms' };
          e.scrollIntoView({ block: 'center' });
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
          e.click();
          return { ok: true, value: label };
        }
        case 'type': {
          const e = firstShown(step.sel);
          if (!e) return { ok: false, error: 'no box matches ' + step.sel };
          if (e.type === 'password' || /pass|otp|cvv|card/i.test(e.name + ' ' + e.id + ' ' + e.autocomplete)) return { ok: false, error: 'flows do not type into password, code or card fields' };
          e.focus();
          if (e.isContentEditable) {
            if (step.clear !== false) document.execCommand('selectAll');
            document.execCommand('insertText', false, step.text);
          } else {
            const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(e, step.clear === false ? e.value + step.text : step.text);
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (step.enter) {
            const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            const handled = !e.dispatchEvent(new KeyboardEvent('keydown', o));
            e.dispatchEvent(new KeyboardEvent('keypress', o));
            e.dispatchEvent(new KeyboardEvent('keyup', o));
            if (!handled && e.form && !e.form.querySelector('input[type=password]')) {
              if (e.form.requestSubmit) e.form.requestSubmit();
              else e.form.submit();
            }
          }
          return { ok: true };
        }
        case 'press': {
          const e = (step.sel && document.querySelector(step.sel)) || document.activeElement || document.body;
          const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33, End: 35, Home: 36 };
          const o = { key: step.key, code: step.key, keyCode: codes[step.key], which: codes[step.key], bubbles: true, cancelable: true };
          e.dispatchEvent(new KeyboardEvent('keydown', o));
          e.dispatchEvent(new KeyboardEvent('keyup', o));
          return { ok: true };
        }
        case 'scroll': {
          const e = step.sel && document.querySelector(step.sel);
          if (e) e.scrollBy(0, e.clientHeight * 0.9);
          else window.scrollBy(0, window.innerHeight * 0.9);
          return { ok: true };
        }
        case 'back':
          history.back();
          return { ok: true };
        case 'inspect':
          return { ok: true, value: inspect(step) };
      }
      return { ok: false, error: 'unknown page step ' + step.do };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }

    // What lists, fields and boxes a page has, with CSS selectors that work for them (for writing flows).
    function inspect(opts) {
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
      const goodClass = (c) => c && c.length < 40 && !/^(ng-|css-|sc-|jsx-|_)|[0-9]{3,}|^[a-z]{1,2}[0-9]/.test(c) || /^[a-zA-Z]{2,4}$/.test(c);
      const classSel = (e, n = 2) => {
        const cs = [...e.classList].filter(goodClass).slice(0, n);
        return e.tagName.toLowerCase() + cs.map((c) => '.' + esc(c)).join('');
      };
      const textLen = (e) => clean(e.innerText).length;
      // 1. Repeated items: siblings with the same tag and classes.
      const groups = new Map();
      const all = document.body ? document.body.getElementsByTagName('*') : [];
      for (let i = 0; i < all.length && i < 30000; i++) {
        const e = all[i];
        if (!e.parentElement || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'svg', 'path', 'OPTION', 'BR'].includes(e.tagName)) continue;
        const key = classSel(e, 1);
        let g = groups.get(e.parentElement);
        if (!g) groups.set(e.parentElement, (g = new Map()));
        const arr = g.get(key);
        if (arr) arr.push(e);
        else g.set(key, [e]);
      }
      const cands = [];
      for (const [parent, g] of groups)
        for (const [key, items] of g) {
          if (items.length < 2) continue;
          const vis = items.filter(visible);
          if (vis.length < 2) continue;
          const lens = vis.slice(0, 10).map(textLen);
          const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
          if (avg < (vis.length < 3 ? 30 : 12)) continue;
          cands.push({ parent, key, items: vis, score: Math.min(vis.length, 30) * Math.min(avg, 300) });
        }
      cands.sort((a, b) => b.score - a.score);
      const lists = [];
      const seen = new Set();
      for (const c of cands) {
        if (lists.length >= (opts.lists || 4)) break;
        if ([...seen].some((s) => s.contains(c.parent) || c.parent.contains(s))) continue;
        seen.add(c.parent);
        // A selector for the items that does not match much else: the classes every item has (Gmail marks unread
        // rows with an extra class, so the first row's classes would miss the read ones).
        const common = [...c.items[0].classList].filter((k) => goodClass(k) && c.items.every((it) => it.classList.contains(k))).slice(0, 3);
        c.key = c.items[0].tagName.toLowerCase() + common.map((k) => '.' + esc(k)).join('');
        let sel = c.key;
        const n = document.querySelectorAll(sel).length;
        if (n > c.items.length * 3 || n < c.items.length) {
          const anc = c.parent.closest('[id]');
          if (anc && !/\d{4,}/.test(anc.id)) sel = '#' + esc(anc.id) + ' ' + c.key;
          else sel = classSel(c.parent, 2) + ' > ' + c.key;
        }
        const matched = document.querySelectorAll(sel).length;
        // Fields: leaf texts, links, images and useful attributes inside the first items.
        const fields = [];
        const fseen = new Set();
        const first = c.items[0];
        const nodes = [first, ...first.querySelectorAll('*')];
        for (const e of nodes) {
          if (fields.length >= 12) break;
          if (!visible(e) && !e.hasAttribute('email')) continue;
          const own = [...e.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join(' ').trim();
          const rel = e === first ? '.' : relSel(e, first);
          if (!rel) continue;
          const add = (attr, sample) => {
            const k = rel + '|' + attr;
            if (fseen.has(k) || !sample) return;
            const hits = c.items.slice(0, 8).filter((it) => {
              const x = rel === '.' ? it : it.querySelector(rel);
              return x && valueOf(x, attr);
            }).length;
            if (hits < Math.min(3, c.items.length) - 1) return;
            fseen.add(k);
            fields.push({ sel: rel, attr, sample: String(sample).slice(0, 90), inItems: hits + '/' + Math.min(8, c.items.length) });
          };
          if (own.length > 1 && e !== first) add('text', clean(e.innerText));
          if (e.tagName === 'A' && e.href && !e.href.startsWith('javascript')) add('href', e.href);
          if (e.tagName === 'IMG' && (e.currentSrc || e.src)) add('src', e.currentSrc || e.src);
          for (const a of ['email', 'title', 'aria-label', 'datetime', 'data-asin', 'data-id']) if (e.hasAttribute(a) && e.getAttribute(a).trim()) add(a, e.getAttribute(a));
        }
        lists.push({ items: sel, count: matched, sampleText: clean(first.innerText).slice(0, 160), fields });
      }
      function relSel(e, base) {
        const parts = [];
        let x = e;
        while (x && x !== base && parts.length < 12) {
          // Inside one item an id is fine even when every item repeats it (YouTube does).
          parts.unshift(x.id && /^[A-Za-z][\w-]{0,40}$/.test(x.id) && !/\d{3,}/.test(x.id) ? x.tagName.toLowerCase() + '#' + esc(x.id) : classSel(x, 2));
          x = x.parentElement;
        }
        if (x !== base) return null;
        for (let k = 1; k <= parts.length; k++) {
          const s = parts.slice(-k).join(' ');
          try {
            if (base.querySelector(s) === e) return s;
          } catch {}
        }
        return null;
      }
      // 2. Boxes to type in and the main buttons.
      const boxes = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=password]),textarea,[contenteditable=true]')]
        .filter(visible)
        .slice(0, 6)
        .map((e) => ({ sel: e.id && !/\d{4,}/.test(e.id) ? '#' + esc(e.id) : e.name ? e.tagName.toLowerCase() + '[name="' + e.name + '"]' : classSel(e, 2), label: clean(e.getAttribute('aria-label') || e.placeholder || e.name || e.title).slice(0, 60), inForm: !!e.form }));
      let target = null;
      if (opts.sample) {
        const hit = [...document.querySelectorAll('body *')].filter((e) => visible(e) && clean(e.innerText).includes(opts.sample)).sort((a, b) => textLen(a) - textLen(b))[0];
        if (hit) {
          const path = [];
          for (let x = hit; x && x !== document.body && path.length < 6; x = x.parentElement) path.unshift(x.id && !/\d{4,}/.test(x.id) ? '#' + esc(x.id) : classSel(x, 2));
          target = { path: path.join(' > '), text: clean(hit.innerText).slice(0, 120), tag: hit.tagName.toLowerCase() };
        }
      }
      return { url: location.href, title: document.title, lists, boxes, ...(target ? { sample: target } : {}) };
    }
  }

  // ---------- Running ----------
  // adapters: { page(tabCtx, step) -> {ok,value,error}, open(tabCtx, url), back(tabCtx), close(tabCtx), ai({prompt,
  // model, json, max}) -> value, getFlow(id) -> flow, signal, onStep(info) }
  async function run(flow, input, adapters, depth = 0, stack = []) {
    const v = validate(flow);
    if (!v.ok) throw new Error('invalid flow ' + flow.id + ': ' + v.errors.join('; '));
    if (depth > LIMITS.depth) throw new Error('flows call each other too deeply');
    if (stack.includes(flow.id)) throw new Error('flow ' + flow.id + ' calls itself');
    const args = {};
    for (const [k, spec] of Object.entries(flow.inputs || {})) {
      let x = input && input[k] !== undefined && input[k] !== null && input[k] !== '' ? input[k] : spec.default;
      if (x === undefined) {
        if (spec.required) throw new Error('missing input "' + k + '" (' + (spec.description || spec.type) + ')');
        continue;
      }
      if (spec.type === 'number') x = Number(x);
      else if (spec.type === 'boolean') x = x === true || x === 'true';
      else x = String(x);
      if (spec.type === 'number' && !Number.isFinite(x)) throw new Error('input "' + k + '" must be a number');
      args[k] = x;
    }
    const scope = { ...args, input: args };
    const tab = { id: null, created: false, sites: (flow.sites || []).map((x) => String(x).toLowerCase().replace(/^www\./, '')) };
    const log = [];
    let last;
    let returned;
    const t0 = Date.now();
    const sig = adapters.signal;
    const doSteps = async (steps, path) => {
      for (let i = 0; i < steps.length; i++) {
        if (sig && sig.aborted) throw new Error('stopped');
        if (returned !== undefined) return;
        const s = steps[i];
        const where = path + '[' + i + '] ' + s.do;
        if (s.if !== undefined && !truthy(render(s.if, scope))) {
          log.push(where + ': skipped');
          continue;
        }
        try {
          const out = await doStep(s, where);
          if (s.as && out !== undefined) setPath(scope, s.as, out);
          if (out !== undefined) last = out;
          log.push(where + ': ok' + summary(out));
          adapters.onStep && adapters.onStep({ flow: flow.id, step: where, ok: true });
        } catch (e) {
          const msg = String((e && e.message) || e);
          log.push(where + ': ' + (s.optional ? 'skipped (' + msg + ')' : 'failed: ' + msg));
          adapters.onStep && adapters.onStep({ flow: flow.id, step: where, ok: false, error: msg });
          if (!s.optional) {
            const err = new Error(where + ' failed: ' + msg);
            err.log = log;
            throw err;
          }
        }
      }
    };
    const page = async (s) => {
      if (!tab.id) throw new Error('open a page first');
      const r = await adapters.page(tab, { ...render(s, scope), __risky: RISKY.source });
      if (!r || !r.ok) throw new Error((r && r.error) || 'the page did not answer');
      return r;
    };
    const doStep = async (s) => {
      switch (s.do) {
        case 'open': {
          const url = render(s.url, scope, 'url');
          const u = new URL(url);
          if (u.protocol !== 'https:' || !tab.sites.some((x) => hostIn(u.hostname.replace(/^www\./, ''), x))) throw new Error('not allowed to open ' + u.hostname);
          await adapters.open(tab, u.href, !!s.newTab);
          return undefined;
        }
        case 'wait': {
          const until = Date.now() + (s.timeout || 15000);
          let last = null;
          let since = Date.now();
          for (;;) {
            const r = await adapters.page(tab, { ...render(s, scope), __risky: RISKY.source });
            if (s.stable) {
              // Settled: the text has not changed for "stable" ms (a streaming answer has finished).
              const now = r && r.ok ? r.value : null;
              if (now !== last) (last = now), (since = Date.now());
              else if (now && Date.now() - since >= s.stable) return undefined;
            } else if (r && r.ok) return undefined;
            if (Date.now() > until) throw new Error('timed out waiting for ' + (s.gone ? s.for + ' to go away' : s.stable ? s.for + ' to settle' : s.for || '"' + s.text + '"'));
            await sleep(400, sig);
          }
        }
        case 'assert': {
          const v = render(s.that, scope);
          if (!compare(v, s.op, render(s.value, scope))) throw new Error(String(render(s.message, scope, 'text')));
          return undefined;
        }
        case 'notify': {
          const title = String(render(s.title, scope, 'text')).slice(0, 120);
          const message = String(render(s.message || '', scope, 'text')).slice(0, 2000);
          if (adapters.notify) await adapters.notify({ title, message }).catch(() => {});
          return undefined;
        }
        case 'extract': {
          const until = Date.now() + (s.timeout || 0);
          for (;;) {
            const r = await page(s);
            const empty = Array.isArray(r.value) ? !r.value.length : r.value === null || r.value === undefined;
            if (!empty || Date.now() >= until) {
              if (empty && s.required) throw new Error('found nothing for ' + (s.items || s.sel));
              return r.value;
            }
            await sleep(500, sig);
          }
        }
        case 'read':
        case 'click':
        case 'type':
        case 'press':
        case 'scroll': {
          const r = await page(s);
          if (s.do === 'click' || s.do === 'type') await sleep(s.settle ?? 600, sig);
          return s.do === 'read' ? r.value : undefined;
        }
        case 'back':
          await adapters.back(tab);
          return undefined;
        case 'sleep':
          await sleep(s.ms, sig);
          return undefined;
        case 'set':
          return clone(render(s.value, scope));
        case 'format':
          return String(render(s.template, scope, 'text'));
        case 'filter': {
          const list = asList(render(s.in, scope));
          const want = render(s.value, scope);
          return list.filter((x) => compare(get(x, s.field), s.op, want));
        }
        case 'sort': {
          const list = asList(render(s.in, scope)).slice();
          const key = (x) => {
            const y = get(x, s.by);
            const n = typeof y === 'number' ? y : parseFloat(String(y ?? '').replace(/[,\s]/g, '').replace(/^[^\d.-]+/, ''));
            return Number.isFinite(n) ? n : String(y ?? '');
          };
          list.sort((a, b) => {
            const x = key(a), y = key(b);
            const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
            return s.desc ? -c : c;
          });
          return list;
        }
        case 'take':
          return asList(render(s.in, scope)).slice(0, Number(render(s.n, scope)) || 0);
        case 'map': {
          const list = asList(render(s.in, scope));
          const name = s.item || 'item';
          const saved = [scope[name], scope.index];
          const out = list.map((x, k) => {
            scope[name] = x;
            scope.index = k;
            if (s.value !== undefined) return clone(render(s.value, scope));
            return isObj(x) ? { ...x, ...clone(render(s.set, scope)) } : { value: x, ...clone(render(s.set, scope)) };
          });
          [scope[name], scope.index] = saved;
          if (saved[0] === undefined) delete scope[name];
          if (saved[1] === undefined) delete scope.index;
          return out;
        }
        case 'concat':
          return s.in.flatMap((t) => asList(render(t, scope)));
        case 'unique': {
          const seen = new Set();
          return asList(render(s.in, scope)).filter((x) => {
            const k = String(get(x, s.by) ?? JSON.stringify(x)).toLowerCase().trim();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        case 'ai': {
          const prompt = String(render(s.prompt, scope, 'text'));
          return await adapters.ai({ prompt, input: s.input !== undefined ? render(s.input, scope) : undefined, model: s.model || (flow.model === 'strong' ? 'strong' : 'fast'), json: s.json, max: s.max });
        }
        case 'each': {
          const list = asList(render(s.in, scope)).slice(0, s.limit || 20);
          const name = s.item || 'item';
          const out = [];
          for (let k = 0; k < list.length; k++) {
            scope[name] = clone(list[k]);
            scope.index = k;
            await doSteps(s.steps, '  each#' + k);
            out.push(s.collect !== undefined ? render(s.collect, scope) : scope[name]);
          }
          delete scope[name];
          delete scope.index;
          return out;
        }
        case 'flow': {
          const sub = await adapters.getFlow(s.id);
          if (!sub) throw new Error('there is no flow "' + s.id + '"');
          const r = await run(sub, render(s.input || {}, scope), adapters, depth + 1, [...stack, flow.id]);
          log.push('  ' + s.id + ': ' + r.log.length + ' steps');
          return r.output;
        }
        case 'return':
          returned = render(s.value, scope);
          return returned;
      }
    };
    try {
      await doSteps(flow.steps, 'step');
    } finally {
      if (tab.id && !(input && input.keepOpen)) await adapters.close(tab).catch(() => {});
    }
    let output = returned !== undefined ? returned : flow.output !== undefined ? render(flow.output, scope) : last;
    return { output, log, ms: Date.now() - t0, tabId: input && input.keepOpen ? tab.id : undefined };
  }
  function compare(a, op, b) {
    const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[,\s]/g, '').replace(/^[^\d.-]+/, '')));
    switch (op) {
      case 'exists':
        return truthy(a);
      case 'contains':
        return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
      case 'equals':
        return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
      case 'not':
        return !String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
      case 'matches':
        try {
          return new RegExp(String(b), 'i').test(String(a ?? ''));
        } catch {
          return false;
        }
      case 'gt':
        return num(a) > num(b);
      case 'lt':
        return num(a) < num(b);
      case 'gte':
        return num(a) >= num(b);
      case 'lte':
        return num(a) <= num(b);
    }
    return false;
  }
  const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const summary = (v) => (Array.isArray(v) ? ' (' + v.length + ' items)' : typeof v === 'string' ? ' (' + v.length + ' characters)' : '');
  function sleep(ms, signal) {
    return new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      signal && signal.addEventListener && signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('stopped'))), { once: true });
    });
  }

  // What a flow looks like to someone deciding whether to use or share it.
  function describe(flow) {
    const v = validate(flow);
    const ins = Object.entries(flow.inputs || {}).map(([k, s]) => k + (s.required ? '' : '?') + ':' + s.type);
    return {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      sites: flow.sites || [],
      inputs: ins.join(', '),
      steps: v.stepCount,
      clicksOrTypes: v.acts,
      usesAI: v.usesAI,
      callsFlows: v.calls,
      model: flow.model || (v.usesAI ? 'fast' : 'none'),
    };
  }
  // Things that look personal in a flow about to be shared (an e-mail address, a phone number, a long number).
  function privacyScan(flow) {
    const text = JSON.stringify(flow);
    const hits = [];
    const add = (re, what) => {
      const m = text.match(re);
      if (m) hits.push(what + ' "' + m[0].slice(0, 40) + '"');
    };
    add(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an e-mail address');
    add(/(?<![\w/.-])\+?\d[\d\s-]{8,}\d(?![\w/])/, 'a phone or account number');
    add(/\b(?:sk|pk|api|key|token|LLM)[_-][A-Za-z0-9_-]{12,}/i, 'something like a key');
    add(/\/u\/[1-9]\//, 'a signed-in account number');
    return hits;
  }

  const api = { validate, render, run, describe, privacyScan, pageOp, hostIn, MODELS, LIMITS, RISKY, VERSION: 1 };
  root.VAFlows = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
