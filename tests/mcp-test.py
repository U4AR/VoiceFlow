# End-to-end test of flows through MCP (test only): the real extension in Chrome (replica sites, mock Meta API),
# voice-agent-mcp.mjs as owner / relay / HTTP, the official MCP SDK client, and Claude Code itself as a client.
import subprocess, time, os, json, re, socket, urllib.request
from playwright.sync_api import sync_playwright
R = '/tmp/claude-0/va9run'
EXT = R + '/ext'
KEY = 'LLM_testkey_0123456789abcdefABCDEF'
PROFILE = R + '/profile-mcp'
EX = R + '/flowlib/examples'
SERVER = R + '/work/mcp/voice-agent-mcp.mjs'
MCPDIR = R + '/mcpdir'
subprocess.run(['rm', '-rf', PROFILE, MCPDIR])
env_mcp = dict(os.environ, VOICE_AGENT_MCP_DIR=MCPDIR)
CODE = subprocess.run(['node', SERVER, '--pairing-code'], env=env_mcp, capture_output=True, text=True).stdout.strip()
print('pairing code made:', CODE[:8] + '…')
procs = [subprocess.Popen(['npx', 'tsx', R + '/mock/mock4.mts'], cwd='/home/claude/voice-agent/packages/meta-client',
                          env=dict(os.environ, PORT='8791', MOCK_KEY=KEY, MOCK_TRANSCRIPT='hello', MOCK_CHAT_RULES=R + '/rules-flows-mcp.json', MOCK_SCRIPT=R + '/flows-script-use.json', DUMP_DIR=R + '/dumps-mcp'),
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'tls-proxy.mjs'], cwd=R, env=dict(os.environ, MOCK_PORT='8791', TLS_PORT='8443'), stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT),
         subprocess.Popen(['node', 'sites.mjs'], cwd=R, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)]
time.sleep(5)
os.makedirs(PROFILE + '/Default', exist_ok=True)
hosts = ['mail.google.com', 'www.amazon.in', 'www.youtube.com', 'accounts.google.com', 'html.duckduckgo.com', 'en.wikipedia.org', 'news.ycombinator.com', 'www.flipkart.com']
chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', '--no-sandbox', '--remote-debugging-port=9353', f'--user-data-dir={PROFILE}',
    f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--use-mock-keychain', '--no-first-run', '--ignore-certificate-errors', '--no-proxy-server',
    '--host-resolver-rules=MAP api.meta.ai 127.0.0.1:8443, ' + ', '.join(f'MAP {h} 127.0.0.1:8444' for h in hosts), 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(7)
p_ = sync_playwright().start()
b = p_.chromium.connect_over_cdp('http://127.0.0.1:9353')
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
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  ' + str(detail)[:700]))
def tool(name, args, conv='test-conv'):
    return sw.evaluate("([c,n,a])=>globalThis.__vaFlowTools.run(c,n,a)", [conv, name, args])
def logs(skip=r'workflow.list|hold.status|controller ready|last 5s|pageReady|va.chat|va.whoami'):
    rows = sw.evaluate("(async()=>{const a=await chrome.storage.local.get(null);const r=[];for(const[k,v]of Object.entries(a))if(k.startsWith('va.log.')&&Array.isArray(v))r.push(...v);r.sort((x,y)=>x.t-y.t);return r.map(x=>new Date(x.t).toISOString().slice(11,23)+' ['+x.c+'] '+x.l+': '+x.m)})()")
    return [l for l in rows if not re.search(skip, l)]
mcp_owner = None
try:
    pg = ctx.new_page(); pg.goto(f'chrome-extension://{ext}/options.html'); pg.wait_for_timeout(1500)
    if pg.locator('text=Connect securely').count():
        pg.fill('input[type=password]', KEY); pg.click('text=Connect securely'); pg.wait_for_timeout(4000)
    pg.close()
    sw.evaluate("chrome.storage.local.set({'va.flows.repo':'http://127.0.0.1:8787','va.ui.suggestAutomate':false})")
    time.sleep(1)

    # ---- 1. more flows, including flows made of flows ----
    seed = [('gmail-search', {'query': 'credits'}), ('gmail-read-mails', {'query': 'hackathon'}), ('amazon-search', {'query': 'headphones'}), ('flipkart-search', {'query': 'earbuds'}),
            ('youtube-feed', {}), ('youtube-search', {'query': 'kerala backwaters'}), ('hackernews-top', {}), ('duckduckgo-search', {'query': 'kerala backwaters'}),
            ('wikipedia-summary', {'topic': 'Kerala backwaters'}), ('gmail-digest', {'query': 'hackathon'}), ('amazon-best-pick', {'query': 'headphones', 'maxPrice': 3000}),
            ('price-compare', {'query': 'headphones', 'maxPrice': 3000}), ('topic-briefing', {'topic': 'Kerala backwaters'}), ('morning-digest', {})]
    outs = {}
    for fid, ti in seed:
        t0 = time.time()
        r = tool('save_flow', {'flow': json.load(open(f'{EX}/{fid}.json')), 'test_input': ti, 'allowEmpty': fid == 'morning-digest'})
        check(f'save_flow {fid} ({time.time()-t0:.1f}s)', not r['isError'], r['text'][:500])
        outs[fid] = r['text']
    r = tool('run_flow', {'id': 'price-compare', 'input': {'query': 'headphones', 'maxPrice': 3000}})
    o = json.loads(r['text'])['output'] if not r['isError'] else []
    print('price-compare →', [(x['shop'], x['price']) for x in o] if isinstance(o, list) else o)
    check('price-compare joins Amazon + Flipkart, sorted by price, shop marked', isinstance(o, list) and len(o) == 7 and o[0]['shop'] == 'Flipkart' and o[0]['price'] == '₹999' and {x['shop'] for x in o} == {'Amazon', 'Flipkart'} and o[-1]['price'] == '₹2,999', r['text'][:600])
    r = tool('run_flow', {'id': 'topic-briefing', 'input': {'topic': 'Kerala backwaters'}})
    o = json.loads(r['text'])['output'] if not r['isError'] else {}
    check('topic-briefing = wikipedia + web + youtube flows + fast ai step', isinstance(o, dict) and 'brackish' in str(o.get('briefing')) and o['sources']['wikipedia'] == 'Kerala backwaters' and len(o['sources']['web']) == 3 and len(o['sources']['videos']) == 2, r['text'][:700])
    r = tool('run_flow', {'id': 'morning-digest', 'input': {}})
    o = json.loads(r['text'])['output'] if not r['isError'] else {}
    check('morning-digest = gmail + hacker news + youtube flows (3 sites) + ai', isinstance(o, dict) and 'flow library' in str(o.get('digest')) and len(o['counts']['news']) == 3 and len(o['counts']['videos']) == 5, r['text'][:700])
    # one shop down: the composite still answers
    sw.evaluate("chrome.storage.local.get('va.flows').then(r=>{const a=r['va.flows'];a['flipkart-search'].flow.steps[1].for='div.gone';a['flipkart-search'].flow.steps[1].timeout=1500;return chrome.storage.local.set({'va.flows':a})})")
    time.sleep(0.5)
    r = tool('run_flow', {'id': 'price-compare', 'input': {'query': 'headphones', 'maxPrice': 3000}})
    o = json.loads(r['text'])['output'] if not r['isError'] else []
    check('price-compare still answers when one inner flow fails (optional step)', isinstance(o, list) and len(o) == 3 and all(x['shop'] == 'Amazon' for x in o), r['text'][:400])
    r = tool('save_flow', {'flow': json.load(open(f'{EX}/flipkart-search.json')), 'test_input': {'query': 'earbuds'}})

    # ---- 1b. the flows for the site the user is on (saved + online library) ----
    tasks0 = ctx.new_page(); tasks0.goto(f'chrome-extension://{ext}/tasks.html'); tasks0.wait_for_timeout(500)
    tasks0.evaluate("()=>chrome.runtime.sendMessage({type:'va.flowDelete',id:'gmail-digest'})"); tasks0.close()
    gm = ctx.new_page(); gm.goto('https://mail.google.com/mail/u/0/#inbox'); gm.bring_to_front(); gm.wait_for_timeout(2500)
    note = sw.evaluate("globalThis.__vaFlowsContext()")
    print('context note:\n' + note)
    here = note.split('Other saved flows')[0]
    check('per-site flows: on mail.google.com the agent sees its Gmail flows first (incl. ones built on them)', 'Flows for the site the user is on (mail.google.com)' in note and 'gmail-search' in here and 'morning-digest' in here and 'amazon-search' not in here, note)
    check('per-site flows: the online library\'s flow for this site is listed too', 'gmail-digest' in here and '[online library' in here, here)
    gm.close()
    r = tool('save_flow', {'flow': json.load(open(f'{EX}/gmail-digest.json')), 'test_input': {'query': 'hackathon'}})

    # ---- 2. pair the extension with the MCP server through the Tasks page ----
    tasks = ctx.new_page(); tasks.set_viewport_size({'width': 900, 'height': 1400}); tasks.goto(f'chrome-extension://{ext}/tasks.html'); tasks.wait_for_timeout(1200)
    tasks.locator('#mcpCard > summary').click()
    tasks.locator('#mcpEnabled').check(); tasks.fill('#mcpCode', CODE); tasks.click('#mcpSave'); tasks.wait_for_timeout(500)
    st = sw.evaluate("chrome.storage.local.get('va.mcp.state').then(r=>r['va.mcp.state'])")
    check('without a server the extension waits quietly', st and st['state'] == 'waiting', st)

    # ---- 3. the official MCP SDK client: owner over stdio, relay, list_changed ----
    sig = R + '/mcp-signal'
    open(sig, 'w').write('')
    cl = subprocess.Popen(['node', R + '/mcptest/client.mjs'], cwd=R + '/mcptest', env=dict(env_mcp, SERVER=SERVER, SIGNAL_FILE=sig), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for _ in range(600):
        if open(sig).read() == 'ready': break
        time.sleep(0.5)
    hn = {'id': 'hn-titles', 'name': 'Hacker News titles', 'description': 'Just the titles of the Hacker News front page (built on hackernews-top).', 'sites': [], 'inputs': {},
          'steps': [{'do': 'flow', 'id': 'hackernews-top', 'as': 's'}, {'do': 'map', 'in': '{{s}}', 'value': '{{item.title}}', 'as': 'titles'}], 'output': '{{titles}}'}
    r = tool('save_flow', {'flow': hn})
    check('a new flow saved in the browser (map over another flow)', not r['isError'] and 'Show HN' in r['text'], r['text'][:300])
    open(sig, 'w').write('saved')
    out, err = cl.communicate(timeout=600)
    try:
        res = json.loads(out.strip().splitlines()[-1])
    except Exception:
        res = {}
        print('client stdout', out[-2000:], '\nstderr', err[-2000:])
    print('MCP stderr:', '\n'.join(l for l in err.splitlines() if 'voice-agent-mcp' in l)[:800])
    names = res.get('toolNames', [])
    print('tools:', names)
    check('MCP: extension connected', res.get('status', {}).get('connected'), res.get('status'))
    check('MCP: one tool per saved flow (+ generic tools, no save_flow)', {'flow_gmail_search', 'flow_price_compare', 'flow_topic_briefing', 'flow_hackernews_top', 'find_flows', 'run_flow', 'get_flow'} <= set(names) and 'save_flow' not in names, names)
    check('MCP: flow inputs become the tool schema', res.get('gmailSchema', {}).get('required') == ['query'] and 'account' in res.get('gmailSchema', {}).get('properties', {}), res.get('gmailSchema'))
    g = res.get('gmail', {})
    check('MCP: flow_gmail_search returns the mails', not g.get('isError') and len(g.get('data', {}).get('output', [])) == 2, g)
    pc = res.get('priceCompare', {})
    check('MCP: flow_price_compare (2 shops) works from an app', not pc.get('isError') and len(pc.get('data', {}).get('output', [])) == 7, pc)
    br = res.get('briefing', {})
    check('MCP: flow_topic_briefing (3 flows + ai) works from an app', not br.get('isError') and 'brackish' in json.dumps(br), str(br)[:400])
    dg = res.get('digest', {})
    check('MCP: flow_morning_digest (3 sites + ai) works from an app', not dg.get('isError') and 'flow library' in json.dumps(dg), str(dg)[:400])
    check('MCP: find_flows finds hackernews-top', 'hackernews-top' in json.dumps(res.get('find')), res.get('find'))
    check('MCP: get_flow returns the steps', 'concat' in json.dumps(res.get('getFlow')), str(res.get('getFlow'))[:300])
    check('MCP: run_flow by id', not res.get('runById', {}).get('isError') and 'Show HN' in json.dumps(res.get('runById')), res.get('runById'))
    check('MCP: save_flow refused unless the user allows it', res.get('saveNotAllowed', {}).get('isError'), res.get('saveNotAllowed'))
    check('MCP: a missing input gives a clear error', res.get('missingInput', {}).get('isError') and 'missing input "query"' in str(res.get('missingInput')), res.get('missingInput'))
    check('MCP: a second copy relays to the first (two Claude windows)', res.get('relayTools', 0) >= 10 and 'Kerala backwaters' in json.dumps(res.get('relayRun')), [res.get('relayTools'), str(res.get('relayRun'))[:300]])
    check('MCP: tools/list_changed after a new flow; it appears as flow_hn_titles', res.get('changedAfter', 0) > res.get('changedBefore', 0) and res.get('newTool'), [res.get('changedBefore'), res.get('changedAfter'), res.get('newTool')])
    mlog = sw.evaluate("chrome.storage.local.get('va.mcp.log').then(r=>r['va.mcp.log']||[])")
    check('every app request is logged for the user (client name, flow, result)', any(e['client'] == 'test-client-a' and e['flow'] == 'price-compare' and e['ok'] for e in mlog) and any(e['client'] == 'test-client-b' for e in mlog), mlog[:3])

    # ---- 4. HTTP endpoint for other products, and its guards ----
    mcp_owner = subprocess.Popen(['node', SERVER, '--http'], env=env_mcp, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    health = {}
    for _ in range(60):
        try:
            health = json.load(urllib.request.urlopen('http://127.0.0.1:17345/health', timeout=2))
            if health.get('extension'): break
        except Exception: pass
        time.sleep(0.5)
    check('HTTP: the extension reconnects to a new server by itself', health.get('extension') and health.get('flows', 0) >= 15, health)
    def post(body, token=CODE):
        req = urllib.request.Request('http://127.0.0.1:17345/mcp', data=json.dumps(body).encode(), method='POST', headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token, 'x-client-name': 'curl-pipeline'})
        try:
            with urllib.request.urlopen(req, timeout=240) as r: return r.status, json.loads(r.read() or b'null')
        except urllib.error.HTTPError as e: return e.code, None
    s, j = post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'curl-pipeline', 'version': '1'}}})
    check('HTTP: initialize', s == 200 and j['result']['serverInfo']['name'] == 'voice-agent', j)
    s, j = post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'flow_duckduckgo_search', 'arguments': {'query': 'kerala backwaters'}}})
    txt = j['result']['content'][0]['text'] if j else ''
    check('HTTP: run a flow (links unwrapped from the DuckDuckGo redirect)', s == 200 and 'https://www.keralatourism.org/backwaters' in txt and 'Ad: cheap' not in txt, txt[:400])
    s, j = post({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/list'}, token='va-wrong')
    check('HTTP: refused without the pairing code', s == 401, s)
    so = socket.create_connection(('127.0.0.1', 17345)); so.send(b'GET /voice-agent HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example.com\r\n\r\n')
    resp = so.recv(200).decode(errors='ignore'); so.close()
    check('a web page cannot connect as the extension (origin check)', resp.startswith('HTTP/1.1 403'), resp[:80])

    # ---- 5. wrong pairing code ----
    sw.evaluate("chrome.storage.local.set({'va.mcp.code':'va-wrong-wrong-wrong-wrong'})")
    st = None
    for _ in range(40):
        st = sw.evaluate("chrome.storage.local.get('va.mcp.state').then(r=>r['va.mcp.state'])")
        if st and st['state'] == 'wrong-code': break
        time.sleep(0.5)
    h2 = json.load(urllib.request.urlopen('http://127.0.0.1:17345/health'))
    check('a different pairing code does not connect (both sides check)', st and st['state'] == 'wrong-code' and not h2['extension'], [st, h2])
    sw.evaluate("(c)=>chrome.storage.local.set({'va.mcp.code':c})", CODE)
    for _ in range(60):
        h2 = json.load(urllib.request.urlopen('http://127.0.0.1:17345/health'))
        if h2['extension']: break
        time.sleep(0.5)
    check('the right code connects again', h2['extension'], h2)

    # ---- 6. Claude Code as the client ----
    cfg = R + '/mcp-claude.json'
    json.dump({'mcpServers': {'voice-agent': {'command': 'node', 'args': [SERVER], 'env': {'VOICE_AGENT_MCP_DIR': MCPDIR}}}}, open(cfg, 'w'))
    prompt = ('Use the voice-agent MCP tools (they run flows in my browser). 1) Compare prices for headphones under 3000 rupees on Amazon and Flipkart and tell me the cheapest option from each shop. '
              '2) Tell me the subjects of my Gmail mails about the hackathon. Answer in at most 6 short lines.')
    t0 = time.time()
    cc = subprocess.run(['claude', '-p', prompt, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__voice-agent', '--max-turns', '8', '--output-format', 'json'],
                        cwd='/tmp', capture_output=True, text=True, timeout=400)
    try:
        cj = json.loads(cc.stdout)
    except Exception:
        cj = {'result': cc.stdout[-1500:], 'err': cc.stderr[-800:]}
    print('Claude Code (%.0fs, $%s):\n' % (time.time() - t0, cj.get('total_cost_usd')), cj.get('result'))
    mlog = sw.evaluate("chrome.storage.local.get('va.mcp.log').then(r=>r['va.mcp.log']||[])")
    cc_runs = [e for e in mlog if 'claude' in str(e['client']).lower()]
    print('extension log, Claude Code requests:', [(e['client'], e['flow'], e['ok']) for e in cc_runs])
    check('Claude Code ran the flows in the browser through MCP', len(cc_runs) >= 2 and all(e['ok'] for e in cc_runs) and {'price-compare', 'gmail-search'} <= {e['flow'] for e in cc_runs}, cc_runs)
    res_txt = str(cj.get('result'))
    check("Claude Code's answer uses the flow results", ('999' in res_txt or 'Noise' in res_txt) and ('hackathon' in res_txt.lower() or 'credits' in res_txt.lower()), res_txt[:600])

    tasks.reload(); tasks.wait_for_timeout(1200); tasks.locator('#mcpCard > summary').click(); tasks.wait_for_timeout(600)
    tasks.locator('#mcpCard').screenshot(path=R + '/shot-mcp-card.png')
    print('\n'.join(l for l in logs()[-25:] if '[va]' in l))
    try: b.new_browser_cdp_session().send('Browser.close')
    except Exception as e: print('close', e)
finally:
    print('RESULT', sum(1 for _, o in OK if o), 'of', len(OK), 'passed')
    for pr in procs + ([mcp_owner] if mcp_owner else []): pr.terminate()
    try: chrome.kill()
    except Exception: pass
