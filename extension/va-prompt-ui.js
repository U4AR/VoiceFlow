// Voice Agent: the answer box and the agent's question cards (added). Shared by the on-page popup (va-tasks.js,
// inside its closed shadow root) and the Tasks page (tasks.js).
//  - The answer box is one row: text, Point (pick something on the page; only where the host offers it), Speak
//    (records with the extension's own microphone, va.dictate.*, and puts the words in the box) and Send.
//  - Drafts are kept in va.ui.drafts, so a half-typed answer survives re-renders, page clicks and switching tabs.
//  - Answers go to the worker as va.answer, the same answers the side panel gives. Buttons ignore synthetic clicks,
//    so a web page cannot press them.
globalThis.vaUI ??= (() => {
  const send = (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  const drafts = {};
  const status = {};
  const cardWarned = {};
  const inputs = new Map(); // key -> the input currently showing that draft
  let rerender = () => {};
  let pick = null; // host-provided: pick(callback) lets the user click an element on the page
  let dict = null; // { key, id, ready, timer }
  let busy = null;
  let focusKey = null;

  // ---------- Drafts shared across tabs ----------
  let saveTimer = null;
  const saveDrafts = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keep = Object.fromEntries(Object.entries(drafts).filter(([, v]) => v));
      chrome.storage.local.set({ 'va.ui.drafts': keep }).catch(() => {});
    }, 300);
  };
  const setDraft = (key, v) => {
    drafts[key] = v;
    saveDrafts();
  };
  chrome.storage.local.get('va.ui.drafts').then((r) => {
    Object.assign(drafts, r['va.ui.drafts'] || {});
    for (const [k, i] of inputs) if (!i.matches(':focus') && drafts[k] && !i.value) i.value = drafts[k];
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch['va.ui.drafts']) return;
    const next = ch['va.ui.drafts'].newValue || {};
    for (const k of new Set([...Object.keys(drafts), ...Object.keys(next)])) {
      if (drafts[k] === next[k]) continue;
      const i = inputs.get(k);
      if (i && i.matches(':focus')) continue; // never change what someone is typing
      drafts[k] = next[k] || '';
      if (i) i.value = drafts[k];
    }
  });

  // ---------- Small helpers ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (label, cls, fn) => {
    const b = el('button', 'b' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (fn) b.onclick = (e) => e.isTrusted && fn(b);
    return b;
  };
  const SVG = {
    mic: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    point: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  };
  const iconButton = (svg, label, cls, fn) => {
    const b = el('button', 'ib' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.innerHTML = svg;
    b.title = label;
    b.setAttribute('aria-label', label);
    if (fn) b.onclick = (e) => e.isTrusted && fn(b);
    return b;
  };
  const usd = (v) => {
    v = Number(v) || 0;
    return '$' + (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4));
  };
  const looksLikeCard = (s) => {
    for (const m of String(s).matchAll(/(?:\d[ -]?){13,19}/g)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length < 13 || d.length > 19) continue;
      let sum = 0;
      for (let i = 0; i < d.length; i++) {
        let n = Number(d[d.length - 1 - i]);
        if (i % 2 === 1 && (n *= 2) > 9) n -= 9;
        sum += n;
      }
      if (sum % 10 === 0) return true;
    }
    return false;
  };

  // ---------- Speak ----------
  async function toggleMic(key) {
    if (busy) return;
    if (!dict) {
      const id = crypto.randomUUID();
      dict = { key, id, ready: false };
      status[key] = 'Starting the microphone…';
      rerender(true);
      const r = await send({ type: 'va.dictate.begin', id });
      if (!dict || dict.id !== id) return;
      if (!r || !r.ok) {
        dict = null;
        status[key] = (r && r.error) || 'Could not start the microphone.';
        return rerender(true);
      }
      dict.ready = true;
      dict.timer = setTimeout(() => toggleMic(key), 120000);
      status[key] = 'Listening… press the red button when you are done.';
      return rerender(true);
    }
    if (dict.key !== key || !dict.ready) return;
    const { id, timer } = dict;
    clearTimeout(timer);
    dict = null;
    busy = key;
    status[key] = 'Writing down what you said…';
    rerender(true);
    const r = await send({ type: 'va.dictate.end', id });
    busy = null;
    if (r && r.ok && r.transcript) {
      setDraft(key, ((drafts[key] || '').trim() + ' ' + String(r.transcript).trim()).trim());
      status[key] = '';
    } else status[key] = (r && r.error) || 'Nothing was heard. Try again.';
    focusKey = key;
    rerender(true);
  }
  addEventListener('pagehide', () => {
    if (dict) send({ type: 'va.dictate.cancel', id: dict.id });
  });

  // ---------- The answer box ----------
  // onSend(text, statusEl) returns false to keep the text (e.g. after a warning).
  function textBox(key, { placeholder, label, onSend, point = false }) {
    const wrap = el('div', 'tbwrap');
    const form = el('form', 'tb');
    const input = el('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    input.dataset.key = key;
    input.value = drafts[key] || '';
    input.oninput = () => setDraft(key, input.value);
    inputs.set(key, input);
    const st = el('div', 'status', status[key] || '');
    st.setAttribute('role', 'status');
    const recording = dict && dict.key === key;
    const mic = iconButton(recording ? SVG.stop : SVG.mic, recording ? 'Stop and use what you said' : 'Speak instead of typing', 'mic' + (recording ? ' rec' : ''), () => toggleMic(key));
    if ((dict && dict.key !== key) || busy) mic.disabled = true;
    const go = iconButton(SVG.send, 'Send', 'go');
    go.type = 'submit';
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!e.isTrusted) return;
      const v = input.value.trim();
      if (!v) return;
      go.disabled = true;
      const r = await onSend(v, st);
      go.disabled = false;
      if (r !== false) {
        setDraft(key, '');
        input.value = '';
        status[key] = '';
      }
    };
    form.append(input);
    if (point && pick)
      form.append(
        iconButton(SVG.point, 'Point at something on the page as your answer', 'pt', () => {
          status[key] = 'Click the thing you mean on the page. Esc cancels.';
          st.textContent = status[key];
          pick((d) => {
            status[key] = '';
            if (d) {
              const desc = describePick(d);
              setDraft(key, ((drafts[key] || '').trim() + (drafts[key] ? ' ' : '') + desc).trim());
            }
            focusKey = key;
            rerender(true);
          });
        }),
      );
    form.append(mic, go);
    wrap.append(form, st);
    return wrap;
  }
  // What the user clicked, as words the agent can use.
  function describePick(d) {
    const parts = [];
    if (d.text) parts.push('“' + d.text.slice(0, 200) + '”');
    if (d.image) parts.push('image “' + d.image + '”');
    if (d.link) parts.push('link ' + d.link);
    if (d.section) parts.push('under “' + d.section + '”');
    return '[the ' + (d.tag || 'item') + ' I pointed at: ' + (parts.join(', ') || 'no text') + (d.page ? ' on ' + d.page : '') + ']';
  }

  // ---------- Question and approval cards ----------
  const CATEGORY = { submit: 'Submit a form', send: 'Send a message', delete: 'Delete something', upload: 'Upload a file' };
  const HANDOVER = {
    pay: 'Paying is always your step.',
    grant: 'Granting access is always your step.',
    secret: 'Typing a password or code is always your step.',
    prompt: 'The page opened a browser dialog that needs you.',
  };
  async function answer(p, a, st) {
    const r = await send({ type: 'va.answer', promptId: p.id, answer: a });
    if (!r || !r.ok) {
      if (st) st.textContent = r && r.error && r.error !== 'unsupported answer' ? r.error : 'This question is no longer open.';
      return false;
    }
    return true;
  }
  function promptCard(p, agentName = 'Voice Agent') {
    const d = p.data || {};
    const c = el('div', 'prompt');
    const st = el('div', 'status');
    const head = el('div', 'phead');
    head.append(el('span', 'ptitle', p.kind === 'flow-ask' ? String(d.title || 'Flow') : p.kind === 'write-card' ? 'Allow this?' : p.kind === 'confirm' ? 'Move a tab into this task?' : p.kind === 'ask-input' ? agentName + ' asks' : 'Your turn'));
    if (Number.isInteger(p.tabId)) {
      const a = el('a', 'link', d.site ? d.site + ' ↗' : 'Show tab ↗');
      a.title = 'Show the tab this is about';
      a.onclick = (e) => e.isTrusted && send({ type: 'va.showTab', tabId: p.tabId });
      head.append(a);
    }
    c.append(head);
    const row = el('div', 'acts');
    switch (p.kind) {
      case 'ask-input':
        c.append(el('div', 'pmsg', String(d.message || '')));
        c.append(
          textBox('p:' + p.id, {
            placeholder: 'Type, speak, or point at the page',
            label: 'Your answer',
            point: true,
            onSend: async (v, s) => {
              if (looksLikeCard(v) && cardWarned[p.id] !== v) {
                cardWarned[p.id] = v;
                s.textContent = 'That looks like a card number. Type card numbers on the site itself. Send again only if you are sure.';
                return false;
              }
              return answer(p, { outcome: 'continue', data: v }, s);
            },
          }),
        );
        {
          const skip = el('a', 'link muted', 'Skip this question');
          skip.onclick = (e) => e.isTrusted && answer(p, { outcome: 'cancel' }, st);
          c.append(skip);
        }
        break;
      case 'ask-takeover':
        c.append(el('div', 'pmsg', String(d.message || '')));
        c.append(el('div', 'pnote', 'Do it yourself in that tab (passwords and codes stay with you), then press Done.'));
        row.append(button('Done', 'primary', () => answer(p, { outcome: 'continue' }, st)), button('Cancel', 'ghost', () => answer(p, { outcome: 'cancel' }, st)));
        break;
      case 'handover':
        c.append(el('div', 'pmsg', HANDOVER[d.reason] || 'This step has to be done by you.'));
        c.append(el('div', 'pnote', 'Do it yourself in that tab, then press Done.'));
        row.append(button('Done', 'primary', () => answer(p, 'given-back', st)), button('Cancel', 'ghost', () => answer(p, 'cancelled', st)));
        break;
      case 'write-card':
        c.append(el('div', 'pmsg', (CATEGORY[d.category] || 'Change something') + ': ' + [d.action, d.target].filter(Boolean).join(' ')));
        if (d.intent || d.reason) c.append(el('div', 'pnote', String(d.intent || d.reason)));
        row.append(button('Allow once', 'primary', () => answer(p, 'approve', st)), button('Decline', 'ghost', () => answer(p, 'decline', st)));
        break;
      case 'flow-ask': {
        c.append(el('div', 'pmsg', String(d.message || '')));
        if (d.show) {
          const det = el('details', 'fdet');
          det.append(el('summary', 'link muted', 'See exactly what is shared'), el('pre', 'fjson', JSON.stringify(d.show, null, 1).slice(0, 6000)));
          c.append(det);
        }
        const fa = async (a) => {
          const r = await send({ type: 'va.flowAnswer', promptId: p.id, answer: a });
          if (!r || !r.ok) st.textContent = (r && r.error) || 'This question is no longer open.';
        };
        row.append(button(String(d.yes || 'Yes'), 'primary', () => fa('yes')), button(String(d.no || 'No'), 'ghost', () => fa('no')));
        break;
      }
      case 'confirm':
        c.append(el('div', 'pmsg', String(d.title || 'A tab')));
        row.append(button('Yes', 'primary', () => answer(p, 'yes', st)), button('No', 'ghost', () => answer(p, 'no', st)));
        break;
      default:
        c.append(el('div', 'pmsg', d.filename ? 'Save ' + d.filename + '?' : 'The agent needs a decision.'));
        if (Number.isInteger(p.tabId)) row.append(button('Decide in the chat panel', 'primary', () => send({ type: 'voice.openPanel', taskTabId: p.tabId })));
    }
    if (row.childNodes.length) c.append(row);
    c.append(st);
    return c;
  }

  return {
    send,
    usd,
    el,
    button,
    iconButton,
    SVG,
    textBox,
    promptCard,
    drafts,
    setRerender: (fn) => {
      rerender = fn;
    },
    setPicker: (fn) => {
      pick = fn;
    },
    state: () => JSON.stringify([dict && [dict.key, dict.ready], busy, status]),
    takeFocus: () => {
      const k = focusKey;
      focusKey = null;
      return k;
    },
  };
})();
