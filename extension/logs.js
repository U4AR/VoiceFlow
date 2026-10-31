const out = document.getElementById('out');
const status = document.getElementById('status');
async function load() {
  const all = await chrome.storage.local.get(null);
  const rows = [];
  for (const [k, v] of Object.entries(all)) if (k.startsWith('va.log.') && Array.isArray(v)) rows.push(...v);
  rows.sort((a, b) => a.t - b.t);
  out.innerHTML = '';
  for (const r of rows.slice(-3000)) {
    const line = document.createElement('div');
    line.className = r.l;
    line.textContent = new Date(r.t).toLocaleTimeString() + ' [' + r.c + '] ' + r.l + ': ' + r.m;
    out.appendChild(line);
  }
  window.scrollTo(0, document.body.scrollHeight);
  const s = await chrome.runtime.sendMessage({ vaLog: 'status' }).catch(() => null);
  status.textContent = rows.length + ' lines. Log file: ' + ((s && s.last) || 'not written yet');
}
document.getElementById('refresh').onclick = load;
document.getElementById('write').onclick = async () => { const s = await chrome.runtime.sendMessage({ vaLog: 'write-now' }).catch((e) => ({ last: String(e) })); status.textContent = 'Log file: ' + (s && s.last); };
document.getElementById('copy').onclick = () => navigator.clipboard.writeText(out.innerText);
document.getElementById('clear').onclick = async () => { const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('va.log.')); await chrome.storage.local.remove(keys); load(); };
load();
