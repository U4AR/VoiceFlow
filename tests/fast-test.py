# End-to-end test (test only): a flow that does the request starts before the agent (in the task's own tab), and the
# agent asks before a submit only on sensitive sites.
import subprocess, time, os, json, re
from playwright.sync_api import sync_playwright
R = '/tmp/claude-0/va9run'
EXT = R + '/ext'
KEY = 'LLM_testkey_0123456789abcdefABCDEF'
PROFILE = R + '/profile-fast'
EX = R + '/flowlib/examples'
DUMP = R + '/dumps-fast'
subprocess.run(['rm', '-rf', PROFILE, DUMP])
procs = [subprocess.Popen(['npx', 'tsx', R + '/mock/mock5.mts'], cwd='/home/claude/voice-agent/packages/meta-client',
                          env=dict(os.environ, PORT='8791', MOCK_KEY=KEY, MOCK_CHAT_RULES=R + '/fast-rules.json', MOCK_SCRIPT=R + '/fast-scripts.json', DUMP_DIR=DUMP),
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'tls-proxy.mjs'], cwd=R, env=dict(os.environ, MOCK_PORT='8791', TLS_PORT='8443'), stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'sites.mjs'], cwd=R, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)]
time.sleep(5)
os.makedirs(PROFILE + '/Default', exist_ok=True)
hosts = ['mail.google.com', 'www.amazon.in', 'www.youtube.com', 'html.duckduckgo.com', 'en.wikipedia.org', 'news.ycombinator.com', 'www.flipkart.com', 'chatgpt.com', 'claude.ai', 'www.example-shop.com', 'netbanking.example-bank.com', 'sites.test']
chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', '--no-sandbox', '--remote-debugging-port=9356', f'--user-data-dir={PROFILE}',
    f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--use-mock-keychain', '--no-first-run', '--ignore-certificate-errors', '--no-proxy-server',
    '--host-resolver-rules=MAP api.meta.ai 127.0.0.1:8443, ' + ', '.join(f'MAP {h} 127.0.0.1:8444' for h in hosts), 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
import urllib.request
for _ in range(60):
    try:
        urllib.request.urlopen('http://127.0.0.1:9356/json/version', timeout=1); break
    except Exception: time.sleep(0.5)
time.sleep(2)
p_ = sync_playwright().start()
b = p_.chromium.connect_over_cdp('http://127.0.0.1:9356')
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
    sw.evaluate("chrome.storage.local.get('nb.settings').then(r=>chrome.storage.local.set({'va.flows.auto':false,'va.flows.repo':'http://127.0.0.1:8787','nb.settings':{...r['nb.settings'],turnCap:80}}))")  # default mode stays "ask"
    st = sw.evaluate("chrome.storage.local.get(['va.flows','va.starters']).then(r=>({flows:Object.keys(r['va.flows']||{}),starters:r['va.starters']||[]}))")
    check('a new install already has the ask-chatgpt and ask-claude flows', {'ask-chatgpt','ask-claude'} <= set(st['flows']) and len(st['starters']) == 2, st)
    # flows used below (each is test-run on the replicas when saved)
    for fid, ti in []:
        t0 = time.time()
        r = tool('save_flow', {'flow': json.load(open(f'{EX}/{fid}.json')), 'test_input': ti})
        check(f'save_flow {fid} ({time.time()-t0:.1f}s)', not r['isError'], r['text'][:400])
        if fid.startswith('ask-'): print('   ', r['text'][:260])
    web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900}); web.goto('https://www.youtube.com/'); web.wait_for_timeout(1500); web.bring_to_front()
    webtab = sw.evaluate("chrome.tabs.query({}).then(ts=>ts.find(t=>t.url.startsWith('https://www.youtube.com/')).id)")
    tasks = ctx.new_page(); tasks.set_viewport_size({'width': 900, 'height': 1500}); tasks.goto(f'chrome-extension://{ext}/tasks.html'); tasks.wait_for_timeout(800)
    web.bring_to_front()
    def run_task(text, secs=90, target='current'):
        # each task starts in its own tab, as a new conversation (like speaking on a fresh page)
        global web, webtab
        web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900}); web.goto('https://www.youtube.com/?t=' + str(time.time())); web.wait_for_timeout(800); web.bring_to_front()
        webtab = sw.evaluate("(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===u).id)", web.url)
        before = {a['id'] for a in sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>r['voice.activity']||[])")}
        t0 = time.time()
        res = tasks.evaluate("([tab,text,target])=>chrome.runtime.sendMessage({type:'product.task',sourceTabId:tab,text,route:{effort:'low',kind:'agent',target:target}})", [webtab, text, target])
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

    def tabs_now():
        return sw.evaluate("chrome.tabs.query({}).then(ts=>ts.map(t=>({id:t.id,url:t.url,active:t.active})))")
    prompts_seen = []
    def kinds_waiting():
        return [l for l in logs() if 'waiting for you' in l]

    # ---- 1. the matching flow starts before the agent, in the task's own tab ----
    before_tabs = tabs_now()
    a, secs, res = run_task('Ask ChatGPT what is 6x7', target='background')
    after_tabs = tabs_now()
    lg = logs()
    early = [l for l in lg if 'flow started before the agent' in l]
    print('   ', secs, res)
    print('    ' + '\n    '.join([l for l in lg if '[va]' in l][-12:]))
    steps = [q for q in requests() if q['kind'] == 'agent' and q['task'].startswith('Ask ChatGPT what is 6x7')]
    fill = [q for q in requests() if q.get('rule') and q['rule'].startswith('Fill the inputs')]
    check('the task finished', a and a['status'] == 'done', a)
    check('the flow\'s inputs were read from the request with one fast call', len(fill) == 1, fill)
    check('the flow started before the agent\'s first step ("flow started before the agent")', early and 'what is 6x7?' in early[0], early)
    time.sleep(2)
    runs = [l for l in logs() if 'flow ask-chatgpt ran in' in l]
    check('ChatGPT was asked once (the agent\'s run_flow got the early run)', len(runs) == 1, runs)
    check('the agent still needed only 2 steps', len(steps) == 2, steps)
    new_tabs = [t for t in after_tabs if t['id'] not in {x['id'] for x in before_tabs} and not t['url'].startswith('https://www.youtube.com/?t=')]
    gpt = [t for t in new_tabs if t['url'].startswith('https://chatgpt.com/')]
    check('one new tab: the task\'s own, now on ChatGPT (no copy of the user\'s page, no second tab)', len(new_tabs) == 1 and len(gpt) == 1, new_tabs)

    # ---- 2. asking before a submit: not on ordinary sites, yes on sensitive ones ----
    a, secs, res = run_task('leave a note on the shop site', secs=60)
    lg = logs()
    print('    ' + '\n    '.join([l for l in lg if '[va]' in l or 'layer' in l][-14:]))
    asked_shop = [l for l in lg if 'waiting for you' in l and 'write-card' in l]
    went = [l for l in lg if 'went ahead without asking' in l and 'example-shop.com' in l]
    check('ordinary site: the agent submitted without asking', a and any('/send' in t['url'] for t in a.get('tabs', [])) and not asked_shop and went, [a, asked_shop[-2:], went])
    t0 = time.time()
    bank = ctx.new_page(); bank.goto('https://www.youtube.com/?bank=' + str(time.time())); bank.wait_for_timeout(800); bank.bring_to_front()
    banktab = sw.evaluate("(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===u).id)", bank.url)
    tasks.evaluate("([tab,text])=>{chrome.runtime.sendMessage({type:'product.task',sourceTabId:tab,text,route:{effort:'low',kind:'agent',target:'current'}});return 1}", [banktab, 'leave a note on my bank site'])
    asked = None
    for _ in range(120):
        asked = [l for l in logs() if 'waiting for you' in l and 'write-card' in l]
        if asked: break
        time.sleep(0.25)
    print('    ' + '\n    '.join([l for l in logs() if 'step' in l or 'layer' in l or 'went ahead' in l or 'waiting' in l or 'run ended' in l][-12:]))
    check('bank-like site: the agent asks before submitting (an "Allow this?" card)', asked, '')
    pending = sw.evaluate("chrome.storage.local.get('va.prompts').then(r=>r['va.prompts']||{})")
    check('…and nothing was sent while it waits', not [l for l in logs() if 'went ahead without asking' in l and 'example-bank' in l], pending)
    # the setting: ask on every site
    sw.evaluate("chrome.storage.local.set({'va.ask':'always'})"); time.sleep(0.5)
    d = sw.evaluate("globalThis.__vaDecideWrite({category:'submit',site:'www.example-shop.com'},{decision:'ask',by:'auto',canRemember:true}).decision")
    check('with "On every site" chosen, ordinary sites ask again', d == 'ask', d)
    sw.evaluate("chrome.storage.local.set({'va.ask':'sensitive'})"); time.sleep(0.5)
    checks = sw.evaluate("""[['www.hdfcbank.com','submit'],['onlinesbi.sbi','submit'],['accounts.google.com','submit'],['www.incometax.gov.in','submit'],['pay.google.com','submit'],['chatgpt.com','submit'],['www.amazon.in','submit'],['mail.google.com','delete'],['www.zerodha.com','upload'],['github.com','upload']].map(([s,c])=>[s,c,globalThis.__vaDecideWrite({category:c,site:s},{decision:'ask',by:'auto',canRemember:true}).decision])""")
    want = {'www.hdfcbank.com': 'ask', 'onlinesbi.sbi': 'ask', 'accounts.google.com': 'ask', 'www.incometax.gov.in': 'ask', 'pay.google.com': 'ask', 'chatgpt.com': 'run', 'www.amazon.in': 'run', 'mail.google.com': 'ask', 'www.zerodha.com': 'ask', 'github.com': 'run'}
    check('sensitive sites and deleting ask; ordinary submits and uploads go ahead', all(want[s] == d for s, c, d in checks), checks)
    ab = sw.evaluate("[globalThis.__vaAskBefore(['www.amazon.in']), globalThis.__vaAskBefore(['chatgpt.com']), globalThis.__vaAskBefore(['netbanking.hdfcbank.com']), globalThis.__vaAskBefore(['www.amazon.in','pay.amazon.in'])]")
    check('library flows that type ask first only on sensitive sites', ab == [False, False, True, True], ab)
    rule = sw.evaluate("globalThis.__vaDecideWrite({category:'submit',site:'chatgpt.com'},{decision:'ask',by:'site-rule',canRemember:false}).decision")
    check('a site rule the user set ("always ask") still wins', rule == 'ask', rule)
except Exception as e:
    import traceback; traceback.print_exc()
finally:
    print('RESULT', sum(1 for _, o in OK if o), 'of', len(OK), 'passed')
    for pr in procs: pr.terminate()
    try: chrome.kill()
    except Exception: pass
