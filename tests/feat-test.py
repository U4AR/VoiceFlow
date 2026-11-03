# End-to-end test (test only): speed of quick actions with flows, memory (ask / auto / off / secrets), views bound to
# flow results, spotting common tasks and making a flow from the suggestion, ask-chatgpt / ask-claude flows with alerts.
import subprocess, time, os, json, re
from playwright.sync_api import sync_playwright
R = '/tmp/claude-0/va9run'
EXT = R + '/ext'
KEY = 'LLM_testkey_0123456789abcdefABCDEF'
PROFILE = R + '/profile-feat'
EX = R + '/flowlib/examples'
DUMP = R + '/dumps-feat'
subprocess.run(['rm', '-rf', PROFILE, DUMP])
procs = [subprocess.Popen(['npx', 'tsx', R + '/mock/mock5.mts'], cwd='/home/claude/voice-agent/packages/meta-client',
                          env=dict(os.environ, PORT='8791', MOCK_KEY=KEY, MOCK_CHAT_RULES=R + '/feat-rules.json', MOCK_SCRIPT=R + '/feat-scripts.json', DUMP_DIR=DUMP),
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'tls-proxy.mjs'], cwd=R, env=dict(os.environ, MOCK_PORT='8791', TLS_PORT='8443'), stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'sites.mjs'], cwd=R, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)]
time.sleep(5)
os.makedirs(PROFILE + '/Default', exist_ok=True)
hosts = ['mail.google.com', 'www.amazon.in', 'www.youtube.com', 'html.duckduckgo.com', 'en.wikipedia.org', 'news.ycombinator.com', 'www.flipkart.com', 'chatgpt.com', 'claude.ai']
chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', '--no-sandbox', '--remote-debugging-port=9354', f'--user-data-dir={PROFILE}',
    f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--use-mock-keychain', '--no-first-run', '--ignore-certificate-errors', '--no-proxy-server',
    '--host-resolver-rules=MAP api.meta.ai 127.0.0.1:8443, ' + ', '.join(f'MAP {h} 127.0.0.1:8444' for h in hosts), 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
import urllib.request
for _ in range(60):
    try:
        urllib.request.urlopen('http://127.0.0.1:9354/json/version', timeout=1); break
    except Exception: time.sleep(0.5)
time.sleep(2)
p_ = sync_playwright().start()
b = p_.chromium.connect_over_cdp('http://127.0.0.1:9354')
ctx = b.contexts[0]
time.sleep(2)
sw = None
for _ in range(40):
    ws = [w for w in ctx.service_workers if w.url.endswith('/background.js') and 'glbjn' not in w.url]
    if ws: sw = ws[0]; break
    time.sleep(0.5)
ext = sw.url.split('/')[2]
OK = []
def check(name, cond, detail=''):
    OK.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  ' + str(detail)[:900]))
def tool(name, args, conv='test-conv'):
    return sw.evaluate("([c,n,a])=>globalThis.__vaFlowTools.run(c,n,a)", [conv, name, args])
def logs(skip=r'workflow.list|hold.status|controller ready|last 5s|pageReady|va.chat|va.whoami'):
    rows = sw.evaluate("(async()=>{const a=await chrome.storage.local.get(null);const r=[];for(const[k,v]of Object.entries(a))if(k.startsWith('va.log.')&&Array.isArray(v))r.push(...v);r.sort((x,y)=>x.t-y.t);return r.map(x=>new Date(x.t).toISOString().slice(11,23)+' ['+x.c+'] '+x.l+': '+x.m)})()")
    return [l for l in rows if not re.search(skip, l)]
def requests():
    try: return [json.loads(l) for l in open(DUMP + '/requests.jsonl')]
    except Exception: return []
try:
    pg = ctx.new_page(); pg.goto(f'chrome-extension://{ext}/options.html'); pg.wait_for_timeout(1500)
    if pg.locator('text=Connect securely').count():
        pg.fill('input[type=password]', KEY); pg.click('text=Connect securely'); pg.wait_for_timeout(4000)
    pg.close()
    sw.evaluate("chrome.storage.local.get('nb.settings').then(r=>chrome.storage.local.set({'nb.settings':{...r['nb.settings'],turnCap:80,defaultMode:'auto'}}))")
    st = sw.evaluate("chrome.storage.local.get(['va.flows','va.starters']).then(r=>({flows:Object.keys(r['va.flows']||{}),starters:r['va.starters']||[]}))")
    check('a new install already has the ask-chatgpt and ask-claude flows', {'ask-chatgpt','ask-claude'} <= set(st['flows']) and len(st['starters']) == 2, st)
    # flows used below (each is test-run on the replicas when saved)
    for fid, ti in [('youtube-feed', {}), ('amazon-search', {'query': 'headphones'}), ('flipkart-search', {'query': 'earbuds'}), ('price-compare', {'query': 'headphones', 'maxPrice': 3000}),
                    ('ask-claude', {'question': 'what is 3+4?', 'alert': False}), ('ask-chatgpt', {'question': 'what is 6x7?'})]:
        t0 = time.time()
        r = tool('save_flow', {'flow': json.load(open(f'{EX}/{fid}.json')), 'test_input': ti})
        check(f'save_flow {fid} ({time.time()-t0:.1f}s)', not r['isError'], r['text'][:400])
        if fid.startswith('ask-'): print('   ', r['text'][:260])
    notes = sw.evaluate("chrome.notifications.getAll()")
    check('ask-chatgpt alerts when the answer arrives (notify step → system notification)', any(k.startswith('va-flow-') for k in notes), notes)
    r = tool('run_flow', {'id': 'ask-chatgpt', 'input': {'question': 'capital of Kerala?', 'alert': False}})
    o = json.loads(r['text'])['output'] if not r['isError'] else {}
    check('ask-chatgpt returns the whole streamed answer and the chat link', 'is 42.' in str(o.get('answer')) and o.get('link', '').endswith('/c/abc123'), r['text'][:300])

    web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900}); web.goto('https://www.youtube.com/'); web.wait_for_timeout(1500); web.bring_to_front()
    webtab = sw.evaluate("chrome.tabs.query({}).then(ts=>ts.find(t=>t.url.startsWith('https://www.youtube.com/')).id)")
    tasks = ctx.new_page(); tasks.set_viewport_size({'width': 900, 'height': 1500}); tasks.goto(f'chrome-extension://{ext}/tasks.html'); tasks.wait_for_timeout(800)
    web.bring_to_front()
    def run_task(text, secs=90):
        # each task starts in its own tab, as a new conversation (like speaking on a fresh page)
        global web, webtab
        web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900}); web.goto('https://www.youtube.com/?t=' + str(time.time())); web.wait_for_timeout(800); web.bring_to_front()
        webtab = sw.evaluate("(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===u).id)", web.url)
        before = {a['id'] for a in sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>r['voice.activity']||[])")}
        t0 = time.time()
        res = tasks.evaluate("([tab,text])=>chrome.runtime.sendMessage({type:'product.task',sourceTabId:tab,text,route:{effort:'low',kind:'agent',target:'current'}})", [webtab, text])
        a = None
        for _ in range(secs * 4):
            acts = sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>r['voice.activity']||[])")
            new = [x for x in acts if x['id'] not in before]
            if new and new[0]['status'] != 'working':
                a = new[0]; break
            time.sleep(0.25)
        return a, time.time() - t0, res
    def agent_steps(task_prefix):
        return [q for q in requests() if q['kind'] == 'agent' and q['task'].startswith(task_prefix[:40])]

    # ---- 1. speed: a quick action that a flow covers ----
    n0 = len(requests())
    a, secs, res = run_task('ask Claude how much is the price of gold today?')
    steps = agent_steps('ask Claude how much')
    reqs = requests()[n0:]
    print('ask Claude: %.1fs, model calls by kind:' % secs, {k: sum(1 for q in reqs if q['kind'] == k) for k in ('router', 'agent', 'judge', 'other')}, '| agent steps:', len(steps))
    check('quick action: done with 2 agent calls (run_flow, answer), no tab hunting or tool loading', a and a['status'] == 'done' and len(steps) == 2, [a, steps])
    check('quick action: type and wait are loaded from the first step (no load_tools round trip)', steps and {'type', 'wait', 'run_flow', 'remember'} <= set(steps[0]['tools']) and 'show_view' not in steps[0]['tools'], steps[:1])
    first = json.load(open(DUMP + '/' + sorted(f for f in os.listdir(DUMP) if f.endswith('step-01.json'))[0])) if steps else {}
    sysmsg = json.dumps(first.get('messages', [])[:1])
    check('instructions: run a matching flow first, go straight to the site', 'call run_flow as your very first step' in sysmsg and 'https://claude.ai/new' in sysmsg, sysmsg[-600:])
    fl = [l for l in logs() if 'flow ask-claude ran in' in l]
    print('   ', fl[-1] if fl else 'no flow log')
    check('quick action under ~6 s on the replica (model calls + the flow)', secs < 8, secs)

    # ---- 2. memory: ask first (default) ----
    a, secs, _ = run_task('My name is Ashish and I live in Thrissur. Ask nothing, just say hi.')
    check('remember: the task finishes without waiting for the answer', a and a['status'] == 'done', a)
    card = None
    for _ in range(40):
        ps = sw.evaluate("chrome.storage.local.get('va.prompts').then(r=>Object.values(r['va.prompts']||{}).flat().filter(p=>p.kind==='flow-ask'&&p.data.title==='Remember this about you?'))")
        if ps: card = ps[0]; break
        time.sleep(0.25)
    check('remember (ask mode): a "Remember this about you?" card, nothing saved yet', card and 'Ashish' in card['data']['message'] and not sw.evaluate("chrome.storage.local.get('va.memory').then(r=>r['va.memory']||[])"), card)
    tasks.bring_to_front(); tasks.wait_for_timeout(600)
    btn = tasks.locator('button:has-text("Remember")').first
    if btn.count(): btn.click()
    time.sleep(1.5)
    mem = sw.evaluate("chrome.storage.local.get('va.memory').then(r=>r['va.memory']||[])")
    check('clicking Remember on the card saves the fact', any('Ashish' in m['fact'] for m in mem), mem)
    time.sleep(4)  # the end-of-task check (judge) also lists facts; duplicates of saved ones are skipped
    ps = sw.evaluate("chrome.storage.local.get('va.prompts').then(r=>Object.values(r['va.prompts']||{}).flat().filter(p=>p.kind==='flow-ask'))")
    check('facts the end-of-task check found that are already remembered are not asked again', not any('Thrissur' in p['data']['message'] or 'Ashish' in p['data']['message'] for p in ps), ps)
    web.bring_to_front()
    a, _, _ = run_task('here is my card number 4111 1111 1111 1111, remember it')
    mem2 = sw.evaluate("chrome.storage.local.get('va.memory').then(r=>r['va.memory']||[])")
    check('secrets (card numbers) are never remembered', len(mem2) == len(mem) and not any('4111' in m['fact'] for m in mem2), mem2)
    a, _, _ = run_task('what do you know about me?')
    st = agent_steps('what do you know about me')
    import hashlib
    blob = ''.join(open(DUMP + '/' + x).read() for x in os.listdir(DUMP) if x.endswith('step-01.json') and 'what do you know about me' in open(DUMP + '/' + x).read())
    check('saved memory is in the next task\'s instructions', 'What you know about the user' in blob and 'Ashish' in blob, blob[-400:])

    # ---- 3. memory automatic + common tasks ----
    sw.evaluate("chrome.storage.local.set({'va.memory.mode':'auto'})"); time.sleep(0.5)
    for i in range(2):
        a, secs, _ = run_task('check the gold price on Claude for me' + (' again' if i else ''))
        time.sleep(4.5)
    mem3 = sw.evaluate("chrome.storage.local.get('va.memory').then(r=>r['va.memory']||[])")
    check('automatic memory: a fact from the end-of-task check is saved without a card', any('gold' in m['fact'] for m in mem3), mem3)
    pats = sw.evaluate("chrome.storage.local.get('va.patterns').then(r=>r['va.patterns']||{})")
    g = pats.get('check-gold-price', {})
    check('common task spotted after 2 times (same kind, no flow covers it)', g.get('count') == 2 and g.get('suggest'), pats)
    tasks.bring_to_front(); tasks.reload(); tasks.wait_for_timeout(1200)
    sugg = tasks.locator('#patterns .flow').count()
    check('the Tasks page suggests it', sugg == 1 and tasks.locator('#patterns').inner_text().count('2 times') == 1, tasks.locator('#patterns').inner_text()[:300])
    tasks.locator('#patterns').screenshot(path=R + '/shot-suggested.png')
    n_before = len(sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>r['voice.activity']||[])"))
    tasks.locator('button:has-text("Make it a flow")').first.click()
    started = None
    for _ in range(60):
        acts = sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>r['voice.activity']||[])")
        if len(acts) > n_before: started = acts[0]; break
        time.sleep(0.25)
    txt = ''
    if started:
        for _ in range(20):
            rr = sw.evaluate("(id)=>chrome.storage.local.get(['voice.pending-tasks','va.titles','voice.activity']).then(r=>({p:(r['voice.pending-tasks']||{})[id],t:(r['va.titles']||{})[id],a:((r['voice.activity']||[]).find(x=>x.id===id)||{}).text}))", started['id'])
            txt = ' '.join(str(v) for v in rr.values() if v)
            if txt: break
            time.sleep(0.25)
    check('"Make it a flow" starts the agent with the examples', 'Make a reusable flow for a task I keep doing: Check the gold price' in txt and 'check the gold price on Claude for me' in txt, [started, txt[:300]])
    time.sleep(3)

    # ---- 4. views bound to flow results ----
    web.bring_to_front()
    a, secs, _ = run_task('show my youtube feed and headphone prices as a page')
    vt = None
    for _ in range(40):
        vt = next((pg_ for pg_ in ctx.pages if '/view.html?id=' in pg_.url), None)
        if vt: break
        time.sleep(0.25)
    check('show_view opens the view page (after loading the tool once)', vt is not None and a and a['status'] == 'done', [a, [p.url for p in ctx.pages]])
    if vt:
        vt.set_viewport_size({'width': 1100, 'height': 1300})
        for _ in range(40):
            if vt.locator('.card').count() >= 5 and vt.locator('table tr').count() >= 8 and vt.locator('.barrow').count() >= 7: break
            vt.wait_for_timeout(250)
        check('view: YouTube feed as 5 cards (live from the flow)', vt.locator('.card').count() == 5 and 'freeCodeCamp' in vt.locator('.cards').inner_text(), vt.locator('main').inner_text()[:300])
        check('view: price-compare as a table (7 rows + header) and a bar chart', vt.locator('table tr').count() == 8 and vt.locator('.barrow').count() == 7, vt.locator('main').inner_text()[:500])
        check('view: text section with bold and a link', vt.locator('.text strong').count() == 1 and vt.locator('.text a[href="https://www.flipkart.com"]').count() == 1, vt.locator('.text').inner_html()[:300] if vt.locator('.text').count() else '')
        vt.wait_for_timeout(300); vt.screenshot(path=R + '/shot-view.png', full_page=True)
        vt.reload(); vt.wait_for_timeout(300)
        check('view: opens instantly from the last results, then refreshes', vt.locator('.card').count() == 5, vt.locator('main').inner_text()[:200])
    tasks.bring_to_front(); tasks.reload(); tasks.wait_for_timeout(1000)
    check('Tasks page lists the view and the memory', tasks.locator('#views a').count() == 1 and 'Ashish' in tasks.locator('#memList').inner_text(), tasks.locator('#views').inner_text() + tasks.locator('#memList').inner_text())
    tasks.screenshot(path=R + '/shot-tasks-more.png', full_page=True)

    # ---- 5. memory off ----
    sw.evaluate("chrome.storage.local.set({'va.memory.mode':'off'})"); time.sleep(0.5)
    web.bring_to_front()
    a, _, _ = run_task('hello there')
    st = agent_steps('hello there')
    check('memory off: no remember tool', st and 'remember' not in st[0]['tools'], st[:1])

    # toast (alert on the page when system notifications are not allowed)
    sw.evaluate("(t)=>chrome.tabs.sendMessage(t,{type:'va.toast',title:'Claude answered',message:'Gold is about ₹7,900 per gram today.'})", webtab)
    web.bring_to_front(); web.wait_for_timeout(500); web.screenshot(path=R + '/shot-toast.png')
    print('\n'.join(l for l in logs()[-45:] if '[va]' in l))
    try: b.new_browser_cdp_session().send('Browser.close')
    except Exception as e: print('close', e)
finally:
    print('RESULT', sum(1 for _, o in OK if o), 'of', len(OK), 'passed')
    for pr in procs: pr.terminate()
    try: chrome.kill()
    except Exception: pass
