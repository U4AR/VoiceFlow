// Voice Agent debug logger (added for troubleshooting). Loaded first in every context: the background worker,
// the offscreen microphone page, extension pages and the page content script. Records console output, uncaught
// errors, network calls (method, address, status, time; for an error reply the first 400 characters of what the
// server said, with keys masked - never request bodies), microphone access, runtime message kinds and long mouse
// holds into chrome.storage.local. The background worker merges them and writes
// <Downloads>/voice-agent-test (3)/logs/voice-agent-log.txt a few seconds after each change. Open logs.html to view.
// It also meters Meta API calls (model, tokens, seconds of audio) for the cost shown in the task popup.
(() => {
  if (globalThis.__vaLog) return;
  const isSW = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
  const isExtPage = !isSW && typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
  const ctx = isSW ? 'bg' : isExtPage ? 'page:' + location.pathname.replace(/^\/|\.html$/g, '') : 'content:' + location.hostname + (window.top === window ? '' : '(frame)');
  const KEY = 'va.log.' + (isSW ? 'bg' : isExtPage ? ctx.slice(5) : 'content');
  const MAX = 1500;
  const LOG_PATH = 'voice-agent-test (3)/logs/voice-agent-log.txt';
  let buf = [];
  let timer = null;
  const scrub = (s) => s.replace(/LLM_[A-Za-z0-9_-]{8,}/g, 'LLM_***').replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').replace(/"accessToken"\s*:\s*"[^"]*"/g, '"accessToken":"***"');
  const fmt = (a) => {
    try {
      if (a instanceof Error) return (a.stack || a.message || String(a));
      if (a && typeof a === 'object') return JSON.stringify(a).slice(0, 800);
      return String(a);
    } catch { return String(a); }
  };
  function add(level, args) {
    const m = scrub(args.map(fmt).join(' ')).slice(0, 1500);
    buf.push({ t: Date.now(), c: ctx, l: level, m });
    if (!timer) timer = setTimeout(flush, 700);
  }
  async function flush() {
    timer = null;
    const out = buf;
    buf = [];
    if (!out.length) return;
    try {
      if (!(globalThis.chrome && chrome.storage && chrome.storage.local)) {
        chrome.runtime.sendMessage({ vaLogEntries: out, vaLogKey: KEY }).catch(() => {});
        return;
      }
      const cur = (await chrome.storage.local.get(KEY))[KEY] || [];
      await chrome.storage.local.set({ [KEY]: cur.concat(out).slice(-MAX) });
    } catch {}
  }
  for (const l of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[l] && console[l].bind(console);
    if (!orig) continue;
    console[l] = (...a) => { try { add(l, a); } catch {} return orig(...a); };
  }
  try {
    addEventListener('error', (e) => add('uncaught', [e.message, (e.filename || '') + ':' + (e.lineno || ''), e.error && e.error.stack || '']));
    addEventListener('unhandledrejection', (e) => add('unhandled', [e.reason]));
  } catch {}
  // Cost meter: what each Meta API call used. The model and audio size come from the request; tokens from the reply
  // (the usage block at the end of the stream, or of the JSON). Reported to the background worker, which prices it.
  const META = /^https:\/\/api\.meta\.ai\/v1\/(chat\/completions|responses|asr\/)/;
  async function meterRequest(init) {
    const out = { model: '', audioBytes: 0, audioType: '' };
    try {
      const b = init && init.body;
      if (typeof b === 'string') out.model = String(JSON.parse(b).model || '');
      else if (b && typeof FormData !== 'undefined' && b instanceof FormData) {
        for (const [k, v] of b.entries()) {
          if (typeof v === 'string') {
            if (k === 'model') out.model = v;
            else if (k === 'request') { try { out.model = String(JSON.parse(v).model || out.model); } catch {} }
          } else if (v && typeof v.size === 'number') {
            if (k === 'request') { try { out.model = String(JSON.parse(await v.text()).model || out.model); } catch {} }
            else { out.audioBytes += v.size; out.audioType = v.type || out.audioType; }
          }
        }
      }
    } catch {}
    return out;
  }
  async function meterResponse(path, res, reqP) {
    try {
      const req = await reqP;
      const text = await res.text();
      let usage = null, model = '', seconds = 0;
      for (const line of text.split('\n')) {
        const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!s || s[0] !== '{') continue;
        try {
          const j = JSON.parse(s);
          const u = j.usage || (j.response && j.response.usage);
          if (u) usage = u;
          model = model || j.model || (j.response && j.response.model) || '';
          seconds = Number(j.duration || (j.usage && (j.usage.seconds || j.usage.duration)) || seconds) || seconds;
        } catch {}
      }
      if (!seconds && req.audioBytes) {
        // 16 kHz 16-bit mono PCM/WAV is 32 000 bytes a second; compressed audio is rarer here and estimated at 4 000.
        seconds = /wav|pcm|l16|x-raw/i.test(req.audioType) || !req.audioType ? Math.max(0, req.audioBytes - 44) / 32000 : req.audioBytes / 4000;
      }
      const rec = { path: path.replace(/^https:\/\/api\.meta\.ai/, ''), model: req.model || model, usage, seconds };
      if (typeof globalThis.__vaMeter === 'function') globalThis.__vaMeter(rec);
      else if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) chrome.runtime.sendMessage({ vaMeter: rec }).catch(() => {});
    } catch {}
  }
  const realFetch = globalThis.fetch;
  if (realFetch) {
    globalThis.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = (init && init.method) || (input && input.method) || 'GET';
      const short = url.replace(/[?#].*$/, '').slice(0, 200);
      const quiet = /^(chrome-extension|data|blob):/.test(url);
      const t0 = Date.now();
      // Meta's API refuses JSON schemas that use "oneOf" ('oneOf' is not permitted); "anyOf" means the same for
      // these schemas and is accepted. This is what made the agent's create_flow fail with HTTP 400.
      if (META.test(url) && init && typeof init.body === 'string' && init.body.includes('"oneOf"')) {
        try {
          init = { ...init, body: JSON.stringify(JSON.parse(init.body), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.oneOf) ? (({ oneOf, ...rest }) => ({ ...rest, anyOf: oneOf }))(v) : v)) };
          add('info', ['[va] rewrote oneOf as anyOf for', short]);
        } catch {}
      }
      const metered = META.test(url) ? meterRequest(init) : null;
      try {
        const r = await (arguments.length > 1 ? realFetch.call(this, input, init) : realFetch.call(this, input));
        if (metered && r.ok) meterResponse(short, r.clone(), metered);
        if (!quiet) add('net', [method, short, r.status, (Date.now() - t0) + 'ms', r.headers.get('content-type') || '']);
        // For an error reply, also keep the start of its body (what the server said was wrong), with anything
        // that looks like a key masked.
        if (!quiet && r.status >= 400) {
          r.clone().text().then((b) => add('net', ['error body', short, b.slice(0, 400).replace(/(LLM_|sk-|Bearer\s+)[\w-]{6,}/g, '$1***')])).catch(() => {});
        }
        return r;
      } catch (e) {
        if (!quiet) add('net', [method, short, 'FAILED', (e && e.name) || '', (e && e.message) || String(e), (Date.now() - t0) + 'ms']);
        throw e;
      }
    };
  }
  try {
    const md = globalThis.navigator && navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const g = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        add('media', ['getUserMedia', JSON.stringify(c)]);
        try {
          const s = await g(c);
          add('media', ['granted', s.getAudioTracks().map((t) => t.label + ':' + t.readyState + (t.muted ? ':muted' : '')).join('; ')]);
          s.getAudioTracks().forEach((t) => t.addEventListener('ended', () => add('media', ['track ended', t.label])));
          return s;
        } catch (e) {
          add('media', ['getUserMedia FAILED', e && e.name, e && e.message]);
          throw e;
        }
      };
    }
  } catch {}
  const NOISY = new Set(['hold.host', 'hold.vad', 'hold-host', 'hold.level', 'hold.frame']);
  const noisy = {};
  setInterval(() => {
    const ks = Object.keys(noisy);
    if (!ks.length) return;
    add('msg', ['last 5s:', ks.map((k) => k + ' x' + noisy[k]).join(', ')]);
    for (const k of ks) delete noisy[k];
  }, 5000);
  try {
    if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((m, s) => {
        let kind = typeof m;
        if (m && typeof m === 'object') kind = String(m.type || m.kind || m.action || m.cmd || m.command || m.vk || m.wf || m.target || Object.keys(m).slice(0, 4).join(','));
        if (m && m.vaLogEntries) return false;
        const from = s && s.tab ? 'tab' + s.tab.id + (s.frameId ? '/f' + s.frameId : '') : ((s && s.url) || '').replace(/^chrome-extension:\/\/[^/]+/, '');
        if (NOISY.has(kind)) { noisy[kind] = (noisy[kind] || 0) + 1; return false; }
        add('msg', ['recv', kind, 'from', from]);
        return false;
      });
    }
  } catch {}
  if (ctx.startsWith('content:')) {
    let downAt = 0;
    addEventListener('pointerdown', (e) => { if (e.button === 0) downAt = performance.now(); }, true);
    addEventListener('pointerup', (e) => {
      if (e.button === 0 && downAt) {
        const d = Math.round(performance.now() - downAt);
        if (d >= 300) add('gesture', ['left hold', d + 'ms', 'on', (e.target && e.target.tagName) || '']);
        downAt = 0;
      }
    }, true);
  }
  globalThis.__vaLog = { add, flush, ctx };

  if (isSW) {
    let wTimer = null;
    let writing = false;
    let again = false;
    globalThis.__vaLogLastWrite = null;
    const writeFile = async () => {
      if (writing) { again = true; return; }
      writing = true;
      try {
        if (!chrome.downloads) { globalThis.__vaLogLastWrite = 'no downloads permission'; return; }
        const all = await chrome.storage.local.get(null);
        const rows = [];
        for (const [k, v] of Object.entries(all)) if (k.startsWith('va.log.') && Array.isArray(v)) rows.push(...v);
        rows.sort((a, b) => a.t - b.t);
        const text = rows.slice(-2500).map((r) => new Date(r.t).toISOString() + ' [' + r.c + '] ' + r.l + ': ' + String(r.m).slice(0, 600)).join('\n') + '\n';
        try { chrome.downloads.setUiOptions && await chrome.downloads.setUiOptions({ enabled: false }); } catch {}
        const id = await chrome.downloads.download({ url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text), filename: LOG_PATH, conflictAction: 'overwrite', saveAs: false });
        const state = await new Promise((res) => {
          const l = (d) => { if (d.id === id && d.state && d.state.current !== 'in_progress') { chrome.downloads.onChanged.removeListener(l); res(d.state.current); } };
          chrome.downloads.onChanged.addListener(l);
          setTimeout(() => { chrome.downloads.onChanged.removeListener(l); res('timeout'); }, 10000);
        });
        globalThis.__vaLogLastWrite = new Date().toISOString() + ' ' + state;
        try { await chrome.downloads.erase({ id }); } catch {}
      } catch (e) {
        globalThis.__vaLogLastWrite = 'failed: ' + ((e && e.message) || e);
      } finally {
        try { chrome.downloads && chrome.downloads.setUiOptions && await chrome.downloads.setUiOptions({ enabled: true }); } catch {}
        writing = false;
        if (again) { again = false; wTimer = setTimeout(writeFile, 3000); }
      }
    };
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && Object.keys(ch).some((k) => k.startsWith('va.log.'))) {
        clearTimeout(wTimer);
        wTimer = setTimeout(writeFile, 2500);
      }
    });
    chrome.runtime.onMessage.addListener((m, s, reply) => {
      if (m && Array.isArray(m.vaLogEntries)) {
        const key = typeof m.vaLogKey === 'string' && m.vaLogKey.startsWith('va.log.') ? m.vaLogKey : 'va.log.other';
        chrome.storage.local.get(key).then((r) => chrome.storage.local.set({ [key]: (r[key] || []).concat(m.vaLogEntries).slice(-MAX) })).catch(() => {});
        return false;
      }
      if (m && m.vaLog === 'write-now') { writeFile().then(() => reply({ last: globalThis.__vaLogLastWrite })); return true; }
      if (m && m.vaLog === 'status') { reply({ last: globalThis.__vaLogLastWrite }); return false; }
      return false;
    });
  }
  add('info', ['logger started', ctx, (globalThis.chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '']);
})();
