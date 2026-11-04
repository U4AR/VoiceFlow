# End-to-end test (test only): finding a flow for each task (saved, online library, none), learning phrasings, and
# making flows automatically for repeated tasks (adopt from the library, with approval when it acts, or have an agent write one).
import subprocess, time, os, json, re
from playwright.sync_api import sync_playwright
R = '/tmp/claude-0/va9run'
EXT = R + '/ext'
KEY = 'LLM_testkey_0123456789abcdefABCDEF'
PROFILE = R + '/profile-auto'
EX = R + '/flowlib/examples'
DUMP = R + '/dumps-auto'
subprocess.run(['rm', '-rf', PROFILE, DUMP])
procs = [subprocess.Popen(['npx', 'tsx', R + '/mock/mock5.mts'], cwd='/home/claude/voice-agent/packages/meta-client',
                          env=dict(os.environ, PORT='8791', MOCK_KEY=KEY, MOCK_CHAT_RULES=R + '/auto-rules.json', MOCK_SCRIPT=R + '/auto-scripts.json', DUMP_DIR=DUMP),
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'tls-proxy.mjs'], cwd=R, env=dict(os.environ, MOCK_PORT='8791', TLS_PORT='8443'), stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'sites.mjs'], cwd=R, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)]
time.sleep(5)
os.makedirs(PROFILE + '/Default', exist_ok=True)
hosts = ['mail.google.com', 'www.amazon.in', 'www.youtube.com', 'html.duckduckgo.com', 'en.wikipedia.org', 'news.ycombinator.com', 'www.flipkart.com', 'chatgpt.com', 'claude.ai', 'www.goodreturns.in']
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
    sw.evaluate("chrome.storage.local.set({'va.flows.repo':'http://127.0.0.1:8787','va.flows.author':'auto-test','va.memory.mode':'off','va.ask':'always'})"); time.sleep(1)  # 'always': library flows that use AI ask first (the default asks only on sensitive sites)
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
        return [q for q in requests() if q['kind'] == 'agent' and q['task'].startswith(task_prefix[:70])]

    def sysmsg(prefix):
        st = agent_steps(prefix)
        if not st: return ''
        f = sorted(x for x in os.listdir(DUMP) if x.endswith('step-01.json'))
        for name in f:
            d = json.load(open(DUMP + '/' + name))
            if 'tools' in d and d['messages'][1]['content'][0]['text'].startswith(prefix[:40]): return d['messages'][0]['content']
        return ''
    def flows():
        return sw.evaluate("chrome.storage.local.get('va.flows').then(r=>r['va.flows']||{})")
    def lib(path):
        return json.load(urllib.request.urlopen('http://127.0.0.1:8787' + path))
    def libsql(q):
        out = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'voice-agent-flows', '--local', '--config', 'wrangler.test.toml', '--json', '--command', q], cwd=R + '/flowlib', capture_output=True, text=True).stdout
        try: return json.loads(out)[0]['results']
        except Exception: return out[:300]
    def answer_next(ans='yes', secs=20, title=None):
        for _ in range(secs * 2):
            ps = sw.evaluate("chrome.storage.local.get('va.prompts').then(r=>Object.values(r['va.prompts']||{}).flat().filter(p=>p.kind==='flow-ask'))")
            ps = [p for p in ps if not title or p['data'].get('title') == title]
            if ps:
                p = ps[-1]
                tasks.evaluate("([id,a])=>chrome.runtime.sendMessage({type:'va.flowAnswer',promptId:id,answer:a})", [p['id'], ans])
                return p
            time.sleep(0.5)
        return None
    def wait_for(fn, secs=30):
        for _ in range(secs * 4):
            v = fn()
            if v: return v
            time.sleep(0.25)
        return None

    # ---- 1. the flow for a task: saved / online library / none ----
    a, secs, _ = run_task('ask Claude what is the capital of France')
    s1 = sysmsg('ask Claude what is the capital of France')
    check('a saved flow that fits is named in the first instructions ("run_flow ask-claude (saved) as your first step")', 'run_flow ask-claude (saved)' in s1, s1[-700:])
    check('…and the task is done with it in 2 model calls', a and a['status'] == 'done' and len(agent_steps('ask Claude what is the capital')) == 2, a)
    print('   ask Claude: %.1fs' % secs)
    a, secs, _ = run_task('search youtube for flutter riverpod tutorials')
    s2 = sysmsg('search youtube for flutter riverpod tutorials')
    check('a library flow that fits is named first ("The online library has a flow … youtube-search")', re.search(r'The online library has a flow (that probably does this request|for this request): youtube-search', s2), s2[-700:])
    f = flows()
    check('…run_flow uses it and saves it locally', a and a['status'] == 'done' and 'youtube-search' in f and f['youtube-search']['source'] == 'online', [a, list(f)])
    print('   youtube search: %.1fs (library lookup + flow)' % secs)
    ex = wait_for(lambda: [r for r in libsql("SELECT id, text FROM flow_examples") if isinstance(r, dict)], 20) or []
    check('…the library learned the phrasing with the value taken out ("search youtube for {query}")', any(r['id'] == 'youtube-search' and r['text'] == 'search youtube for {query}' for r in ex), ex)
    check('…and the flow keeps it locally for matching', 'search youtube for {query}' in (flows()['youtube-search'].get('examples') or []), flows()['youtube-search'].get('examples'))
    a, secs, _ = run_task('turn off the bedroom lights')
    s3 = sysmsg('turn off the bedroom lights')
    check('no flow fits: the agent is told to do it itself without searching ("no need to call find_flows")', 'No saved or library flow does this request' in s3 and 'no need to call find_flows' in s3, s3[-500:])
    lk = [l for l in logs() if 'flow lookup:' in l]
    print('   ', '\n    '.join(lk[-3:]))

    # ---- 2. a repeated task that the library covers: adopted, no agent needed ----
    n_tasks = len(sw.evaluate("chrome.storage.local.get('voice.activity').then(r=>r['voice.activity']||[])"))
    run_task('check hacker news top stories')
    w = wait_for(lambda: [x for x in lib('/api/wanted?all=1')['wanted'] if x['kind'] == 'hn-top-check'], 15)
    check('a repeatable task without a saved flow is reported to the library (kind, name, site only)', w and w[0]['name'] == 'Check Hacker News top stories' and w[0].get('doneBy') == 'hackernews-top', w)
    run_task('check the hacker news top stories again')
    got = wait_for(lambda: 'hackernews-top' in flows() and flows()['hackernews-top'], 30)
    check('the second time, the library flow is adopted automatically (read-only: no question)', got and got.get('adopted') and got['source'] == 'online', got and {k: got[k] for k in ('source', 'adopted') if k in got})
    log = sw.evaluate("chrome.storage.local.get('va.autoFlows').then(r=>r['va.autoFlows']||[])")
    check('…logged as from the library, and no flow-making agent was started', any(x['kind'] == 'hn-top-check' and x['how'] == 'library' for x in log) and not agent_steps('Make a reusable flow for a task I keep doing: Check Hacker'), log)
    web.wait_for_timeout(300)

    # ---- 3. a repeated task the library does not cover: an agent writes and tests a flow in the background ----
    run_task('what is the gold rate on goodreturns today')
    run_task('goodreturns gold rate for kochi')
    made = wait_for(lambda: 'goodreturns-gold-rate' in flows() and flows()['goodreturns-gold-rate'], 60)
    check('the second time, an agent writes and tests a flow for it in the background', made and made.get('tested'), made)
    st = agent_steps('Make a reusable flow for a task I keep doing: Check the gold rate')
    first_req = [json.load(open(DUMP + '/' + x)) for x in sorted(os.listdir(DUMP)) if x.endswith('step-01.json')]
    mk = [d for d in first_req if 'tools' in d and d['messages'][1]['content'][0]['text'].startswith('Make a reusable flow for a task I keep doing: Check the gold rate')]
    check('…from a task that names what the user asked before', mk and 'goodreturns gold rate for kochi' in mk[0]['messages'][1]['content'][0]['text'], [d['messages'][1]['content'][0]['text'][:300] for d in mk])
    pats = sw.evaluate("chrome.storage.local.get('va.patterns').then(r=>r['va.patterns']||{})")
    check('…and the flow-making task itself is not counted as a task to make a flow for', not any('reusable' in k for k in pats) and pats.get('goodreturns-gold-rate', {}).get('flowRequested'), list(pats))
    tasks.reload(); tasks.wait_for_timeout(800)
    txt = tasks.locator('#autoLog').inner_text()
    check('the Tasks page shows what was made automatically', 'hn-top-check' in txt and 'goodreturns-gold-rate' in txt and tasks.locator('#autoFlows').is_checked(), txt)
    tasks.screenshot(path=R + '/shot-auto-flows.png', full_page=False)
    a, secs, _ = run_task('gold rate in kochi on goodreturns')
    s4 = sysmsg('gold rate in kochi on goodreturns')
    check('the next time, the new flow is named in the instructions', 'goodreturns-gold-rate' in s4, s4[-500:])

    # ---- 4. a library flow that uses AI: adopted only after the user says yes ----
    def start_task(text):
        global web, webtab
        web = ctx.new_page(); web.set_viewport_size({'width': 1280, 'height': 900}); web.goto('https://www.youtube.com/?t=' + str(time.time())); web.wait_for_timeout(800); web.bring_to_front()
        webtab = sw.evaluate("(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===u).id)", web.url)
        tasks.evaluate("([tab,text])=>{chrome.runtime.sendMessage({type:'product.task',sourceTabId:tab,text,route:{effort:'low',kind:'agent',target:'current'}}); return 1}", [webtab, text])
    run_task('pick the best earbuds on amazon under 2000')
    start_task('pick the best earbuds on amazon again')
    card = answer_next('yes', 40, 'Use a flow from the library?')
    check('a library flow that uses AI is adopted only after a "Use a flow from the library?" card', card and 'amazon-best-pick' in card['data']['message'], card)
    got = wait_for(lambda: flows().get('amazon-best-pick'), 20)
    check('…and saved once the user says yes', got and got.get('approved'), got)

    # ---- 5. off switch, and the daily limit ----
    sw.evaluate("chrome.storage.local.set({'va.flows.auto':false})"); time.sleep(0.5)
    run_task('open my coursera certificates')
    run_task('open my coursera certificates page')
    wait_for(lambda: sw.evaluate("chrome.storage.local.get('va.patterns').then(r=>((r['va.patterns']||{})['coursera-certificates']||{}).count||0)") >= 2, 20)
    time.sleep(2)
    pats = sw.evaluate("chrome.storage.local.get('va.patterns').then(r=>r['va.patterns']||{})")
    check('with automatic flows off, a repeated task is only suggested (Make it a flow)', pats.get('coursera-certificates', {}).get('suggest') and not agent_steps('Make a reusable flow for a task I keep doing: Open Coursera'), pats.get('coursera-certificates'))
    sw.evaluate("chrome.storage.local.set({'va.flows.auto':true,'va.autoFlows':[1,2,3].map(i=>({kind:'k'+i,at:new Date().toISOString(),how:'made'}))})"); time.sleep(0.5)
    sw.evaluate("globalThis.__vaPatternSeen('lim-conv','coursera-certificates','Open Coursera certificates','open my coursera certificates','www.coursera.org',true)")
    time.sleep(2)
    check('at most 3 automatic flows a day', not agent_steps('Make a reusable flow for a task I keep doing: Open Coursera') and any('3 made today' in l for l in logs()), [l for l in logs() if 'auto flow' in l][-3:])

    # ---- 6. privacy: what reached the library ----
    want = libsql("SELECT kind, name, sites FROM wanted")
    check('wanted entries carry only a kind, a short name and a site', all(set(r) == {'kind', 'name', 'sites'} for r in want) and not any(re.search(r'\d{3,}|kochi', r['name'], re.I) for r in want), want)
    ex = libsql("SELECT text FROM flow_examples")
    check('learned phrasings have the values taken out', ex and all('{' in r['text'] or len(r['text'].split()) <= 6 for r in ex), ex)
    print('\n'.join(l for l in logs()[-60:] if 'auto flow' in l or 'flow lookup' in l or 'library' in l))
    try: b.new_browser_cdp_session().send('Browser.close')
    except Exception as e: print('close', e)
finally:
    print('RESULT', sum(1 for _, o in OK if o), 'of', len(OK), 'passed')
    for pr in procs: pr.terminate()
    try: chrome.kill()
    except Exception: pass
