"""Hold-to-talk tests: live transcription over the realtime socket, fallback to upload, and dictating into the box
under the pointer even when another box has focus."""
import subprocess, time, os, json, re, ssl, urllib.request, sys
from playwright.sync_api import sync_playwright
R = '/tmp/claude-0/va9run'
EXT = sys.argv[1] if len(sys.argv) > 1 else R + '/ext-live'
KEY = 'LLM_testkey_0123456789abcdefABCDEF'
env = dict(os.environ, PORT='8791', MOCK_KEY=KEY, MOCK_TRANSCRIPT='type exactly: uploaded words',
           MOCK_CHAT_RULES=R + '/hold-rules.json', MOCK_SCRIPT=R + '/fast-scripts.json', DUMP_DIR=R + '/dumps-hold')
procs = [subprocess.Popen(['npx', 'tsx', R + '/mock/mock5.mts'], cwd='/home/claude/voice-agent/packages/meta-client', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'tls-proxy-ws.mjs'], cwd=R, env=dict(os.environ, MOCK_PORT='8791', TLS_PORT='8443'), stdout=open(R + '/proxy-ws.log', 'w'), stderr=subprocess.STDOUT),
         subprocess.Popen(['python3', '-m', 'http.server', '8792', '--bind', '127.0.0.1'], cwd=R + '/kpf', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
time.sleep(5)
ctxssl = ssl._create_unverified_context()
def proxy(path):
    return urllib.request.urlopen('https://127.0.0.1:8443' + path, context=ctxssl).read().decode()
PROFILE = R + '/profile-hold'
subprocess.run(['rm', '-rf', PROFILE])
os.makedirs(PROFILE + '/Default', exist_ok=True)
c = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', '--no-sandbox', '--remote-debugging-port=9360', f'--user-data-dir={PROFILE}',
    f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--use-mock-keychain', '--no-first-run', '--ignore-certificate-errors', '--no-proxy-server',
    '--host-resolver-rules=MAP api.meta.ai 127.0.0.1:8443', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=/tmp/claude-0/say16.wav', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
results = []
def check(name, ok, info=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(info)[:300] if info else ''), flush=True)
def logs(sw):
    rows = sw.evaluate("(async()=>{const a=await chrome.storage.local.get(null);const r=[];for(const[k,v]of Object.entries(a))if(k.startsWith('va.log.')&&Array.isArray(v))r.push(...v);r.sort((x,y)=>x.t-y.t);return r.map(x=>new Date(x.t).toISOString().slice(11,23)+' ['+x.c+'] '+x.l+': '+x.m)})()")
    return rows
try:
    time.sleep(6)
    p_ = sync_playwright().start(); b = p_.chromium.connect_over_cdp('http://127.0.0.1:9360'); ctx = b.contexts[0]; time.sleep(2)
    sw = None
    for _ in range(40):
        w = [w for w in ctx.service_workers if w.url.endswith('/background.js') and 'glbjn' not in w.url]
        if w: sw = w[0]; break
        time.sleep(0.5)
    ext = sw.url.split('/')[2]
    pg = ctx.new_page(); pg.goto(f'chrome-extension://{ext}/options.html'); pg.wait_for_timeout(1500)
    if pg.locator('text=Connect securely').count():
        pg.fill('input[type=password]', KEY); pg.click('text=Connect securely'); pg.wait_for_timeout(4000)
    if pg.locator('text=Allow microphone & enable voice').count():
        pg.click('text=Allow microphone & enable voice'); pg.wait_for_timeout(3000)
    pg.close()
    web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900})

    def hold_on(sel, focus='#a', ms=2600):
        web.goto('http://127.0.0.1:8792/dict.html'); web.wait_for_timeout(2000); web.bring_to_front()
        web.focus(focus)
        box = web.locator(sel).bounding_box()
        x, y = box['x'] + 30, box['y'] + 30
        web.mouse.move(x, y); web.mouse.down()
        pills = []
        t0 = time.time()
        while time.time() - t0 < ms / 1000:
            web.wait_for_timeout(200)
            t = web.evaluate("(document.querySelector('[data-voice-agent=hold]')||{}).textContent||''")
            if t and (not pills or pills[-1] != t): pills.append(t)
        web.mouse.up()
        t1 = time.time()
        got = None
        for _ in range(60):
            web.wait_for_timeout(100)
            v = web.evaluate("({a:document.querySelector('#a').value,b:document.querySelector('#b').value,c:document.querySelector('#c').innerText.trim(),pill:(document.querySelector('[data-voice-agent=hold]')||{}).textContent||''})")
            if v['b'] or v['c'] or v['a'] or re.search('No transcript|failed|Copy', v['pill']):
                got = v; break
        return got, round(time.time() - t1, 2), pills

    # 1. live transcription into the textarea under the pointer while the input has focus
    proxy('/__mode?m=ok')
    got, secs, pills = hold_on('#b')
    st = json.loads(proxy('/__stats'))
    check('live: text lands in the box under the pointer', got and got['b'] == 'live words here' and got['a'] == '', (got, secs))
    check('live: socket got handshake, audio and endStream', st and st[0]['handshake'] and st[0]['handshake'].get('mode') == 'PUSH_TO_TALK' and st[0]['handshake'].get('audioEncoding') == 'PCM_16KHZ' and st[0]['bytes'] > 32000 and st[0]['endStream'], st)
    check('live: key sent only in the handshake', st and st[0]['handshake']['authorization']['accessToken'] == 'Bearer ' + KEY)
    check('live: words shown while holding', any('live words' in p for p in pills), pills)
    check('live: result under 2 s after release', secs < 2.0, secs)
    # 2. contenteditable under the pointer
    got, secs, pills = hold_on('#c')
    check('live: contenteditable under the pointer', got and got['c'] == 'live words here' and got['a'] == '', got)
    # 3. socket fails: upload fallback
    proxy('/__mode?m=fail')
    got, secs, _ = hold_on('#b')
    check('fail: falls back to upload', got and got['b'] == 'uploaded words', (got, secs))
    check('fail: no long wait', secs < 3.0, secs)
    # 4. socket never finishes: upload after the time limit
    proxy('/__mode?m=hang')
    got, secs, _ = hold_on('#b', ms=2600)
    check('hang: falls back to upload', got and got['b'] == 'uploaded words', (got, secs))
    # 5. socket refused at connect
    proxy('/__mode?m=refuse')
    got, secs, _ = hold_on('#b')
    check('refused: falls back to upload', got and got['b'] == 'uploaded words', (got, secs))
    # 6. hold on page text while the input has focus: not typed into the input
    proxy('/__mode?m=ok')
    web.goto('http://127.0.0.1:8792/dict.html'); web.wait_for_timeout(1500)
    web.focus('#a'); web.mouse.move(900, 600); web.mouse.down(); web.wait_for_timeout(2600); web.mouse.up(); web.wait_for_timeout(3000)
    a = web.evaluate("document.querySelector('#a').value")
    check('page hold does not type into the focused input', a == '', a)
    # 7. spoken edit: find and replace in the box under the pointer
    proxy('/__live?t=change%20Sam%20to%20Priya')
    web.goto('http://127.0.0.1:8792/dict.html'); web.wait_for_timeout(1500)
    web.evaluate("document.querySelector('#b').value='Hi Sam, see you tomorrow at the cafe.'")
    web.focus('#a'); bx = web.locator('#b').bounding_box(); web.mouse.move(bx['x']+30, bx['y']+30); web.mouse.down(); web.wait_for_timeout(2600); web.mouse.up()
    v = None
    for _ in range(50):
        web.wait_for_timeout(100); v = web.evaluate("document.querySelector('#b').value")
        if 'Priya' in v: break
    pill = web.evaluate("(document.querySelector('[data-voice-agent=hold]')||{}).textContent||''")
    check('edit: find and replace in the field', v == 'Hi Priya, see you at the cafe.', (v, pill))
    # 8. spoken edit in a contenteditable
    web.evaluate("document.querySelector('#c').innerHTML='<div>Hi Sam,</div><div><br></div><div>See you tomorrow.</div>'")
    bx = web.locator('#c').bounding_box(); web.mouse.move(bx['x']+60, bx['y']+12); web.mouse.down(); web.wait_for_timeout(2600); web.mouse.up()
    for _ in range(50):
        web.wait_for_timeout(100); v = web.evaluate("document.querySelector('#c').innerText")
        if 'Priya' in v: break
    check('edit: contenteditable', 'Hi Priya,' in v and 'tomorrow' not in v and 'See you.' in v, v)
    for l in logs(sw):
        if '[va] live' in l or '[va] voice decision' in l or 'uncaught' in l.lower(): print('   ', l)
    print(f'RESULT {sum(results)} of {len(results)} passed')
    try: b.new_browser_cdp_session().send('Browser.close')
    except Exception: pass
    c.wait(timeout=20); p_.stop()
finally:
    for pr in procs: pr.terminate()
    c.kill()
