// Test-only HTTPS replicas of the parts of Gmail, Amazon and YouTube that flows read, chosen by Host header.
// Structure follows the real sites' markup (Gmail: tr.zA rows, span.bog subject, span[email] sender, span.y2
// snippet, td.xW span[title] date, div.a3s body; Amazon: div[data-component-type=s-search-result] with h2 title,
// span.a-price > span.a-offscreen, span.a-icon-alt; YouTube: client-rendered ytd-rich-item-renderer).
import https from 'node:https';
import { readFileSync } from 'node:fs';
const MAILS = [
  { id: 'm1', from: 'Fireworks AI', email: 'credits@fireworks.ai', subject: 'Your $50 hackathon credits are live', snippet: 'Hi Ashish, the credits for the Meta hackathon have been added to your account', body: 'Hi Ashish,\nThe $50 in credits for the Meta Llama hackathon are now on your Fireworks account. They expire on 30 November.\nThe Fireworks team', date: 'Thu, Oct 29, 2026, 4:12 PM' },
  { id: 'm2', from: 'Meta for Developers', email: 'noreply@meta.com', subject: 'Hackathon: API credits application received', snippet: 'We received your application for Muse API credits. We will reply within 3 days', body: 'Thanks for applying for Muse API credits for the hackathon. We review applications within 3 working days.', date: 'Wed, Oct 28, 2026, 9:03 AM' },
  { id: 'm3', from: 'Amazon.in', email: 'order-update@amazon.in', subject: 'Your order has shipped', snippet: 'Boat Rockerz 450 will arrive Saturday', body: 'Your package is on the way.', date: 'Tue, Oct 27, 2026, 7:40 PM' },
  { id: 'm4', from: 'Kaggle', email: 'no-reply@kaggle.com', subject: 'ARC Prize 2026: new leaderboard results', snippet: 'Your latest submission scored 0.31', body: 'Your submission scored 0.31 on the public leaderboard.', date: 'Mon, Oct 26, 2026, 11:00 AM' },
];
const gmail = `<!doctype html><html><head><title>Inbox - test.user@example.com - Gmail</title><style>body{font:14px Arial} tr.zA{cursor:pointer} td{padding:4px 8px;border-bottom:1px solid #ddd} .a3s{white-space:pre-wrap;padding:12px}</style></head>
<body><div role="main" id=":1"><div class="nH"><button class="T-I" aria-label="Delete" id="del">Delete</button><table class="F cf zt"><tbody id="rows"></tbody></table><div id="thread"></div></div></div>
<script>
const MAILS=${JSON.stringify(MAILS)};
function render(){
  const h=decodeURIComponent(location.hash.slice(1)); const parts=h.split('/');
  const rows=document.getElementById('rows'), th=document.getElementById('thread'); rows.textContent=''; th.textContent='';
  if(parts[0]==='search'&&parts[2]){ const m=MAILS.find(x=>x.id===parts[2]); th.innerHTML='<h2 class="hP"></h2><div class="a3s aiL"></div>'; th.querySelector('h2').textContent=m.subject; th.querySelector('.a3s').textContent=m.body; return; }
  const q=(parts[0]==='search'?parts[1]:'').toLowerCase().split(/\\s+/).filter(Boolean);
  setTimeout(()=>{ for(const m of MAILS.filter(m=>q.filter(w=>!/:/.test(w)||/^from:/.test(w)).every(w=>(m.subject+' '+m.snippet+' '+m.from+' '+m.body).toLowerCase().includes(w.replace(/^from:/,''))))){
    const tr=document.createElement('tr'); tr.className='zA zE'; tr.innerHTML='<td class="yX xY"><div class="yW"><span class="bA4"><span class="yP" email="'+m.email+'" name="'+m.from+'">'+m.from+'</span></span></div></td><td class="xY a4W"><div class="xS"><div class="y6"><span class="bog"><span>'+m.subject+'</span></span></div><span class="y2"> - '+m.snippet+'</span></div></td><td class="xW xY"><span title="'+m.date+'"><span>'+m.date.split(',')[1]+'</span></span></td>';
    tr.onclick=()=>{ location.hash='#search/'+encodeURIComponent(parts[1]||'')+'/'+m.id; }; rows.append(tr); } }, 700);
}
addEventListener('hashchange',render); render();
</script></body></html>`;
const PRODUCTS = [
  { asin: 'B0CX1', title: 'boAt Rockerz 450 Bluetooth On Ear Headphones', price: 1299, rating: 4.1 },
  { asin: 'B0CX2', title: 'Sony WH-CH520 Wireless Headphones', price: 3990, rating: 4.3 },
  { asin: 'B0CX3', title: 'JBL Tune 510BT Wireless On-Ear Headphones', price: 2999, rating: 4.4 },
  { asin: 'B0CX4', title: 'Noise Two Wireless Headphones, 50 hours playtime', price: 1199, rating: 3.9 },
  { asin: 'B0CX5', title: 'Sony WH-1000XM5 Noise Cancelling Headphones', price: 26990, rating: 4.6 },
];
const amazon = (q) => `<!doctype html><html><head><title>Amazon.in : ${q}</title></head><body><div id="search"><div class="s-main-slot s-result-list">` +
  PRODUCTS.filter((p) => !q || q.split(/\s+/).some((w) => p.title.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase() === 'headphones')).map((p) =>
    `<div data-asin="${p.asin}" data-component-type="s-search-result" class="s-result-item s-asin sg-col"><div class="puis-card-container"><a class="a-link-normal s-no-outline" href="/${p.title.split(' ')[0]}/dp/${p.asin}/"><img class="s-image" src="https://m.media-amazon.com/images/I/${p.asin}.jpg"></a><a class="a-link-normal s-line-clamp-2 s-link-style a-text-normal" href="/x/dp/${p.asin}/"><h2 aria-label="${p.title}" class="a-size-medium a-spacing-none a-color-base a-text-normal"><span>${p.title}</span></h2></a><div class="a-row a-size-small"><span class="a-icon-alt">${p.rating} out of 5 stars</span></div><span class="a-price" data-a-color="base"><span class="a-offscreen">₹${p.price.toLocaleString('en-IN')}</span><span aria-hidden="true"><span class="a-price-symbol">₹</span><span class="a-price-whole">${p.price.toLocaleString('en-IN')}</span></span></span><button class="a-button-text" type="button">Add to cart</button></div></div>`).join('') +
  `</div></div></body></html>`;
const VIDEOS = [
  ['ARC Prize 2026 explained', 'Two Minute Papers', 'dQw1'], ['Building a Chrome extension with AI agents', 'Fireship', 'dQw2'], ['Kerala monsoon travel vlog', 'Tech Travel Eat', 'dQw3'], ['Learn Flutter in 1 hour', 'freeCodeCamp.org', 'dQw4'], ['Gospel of John, chapter 1', 'BibleProject', 'dQw5'],
];
const youtube = `<!doctype html><html><head><title>YouTube</title></head><body><ytd-app><div id="content"><ytd-rich-grid-renderer><div id="contents" class="style-scope ytd-rich-grid-renderer"></div></ytd-rich-grid-renderer></div></ytd-app>
<script>setTimeout(()=>{const c=document.getElementById('contents');for(const [t,ch,id] of ${JSON.stringify(VIDEOS)}){const e=document.createElement('ytd-rich-item-renderer');e.className='style-scope ytd-rich-grid-renderer';e.innerHTML='<div id="content" class="style-scope ytd-rich-item-renderer"><ytd-rich-grid-media><div id="dismissible"><ytd-thumbnail><a id="thumbnail" class="yt-simple-endpoint" href="/watch?v='+id+'"><img src="https://i.ytimg.com/vi/'+id+'/hq.jpg"></a></ytd-thumbnail><div id="details"><h3><a id="video-title-link" class="yt-simple-endpoint focus-on-expand" href="/watch?v='+id+'" title="'+t+'"><yt-formatted-string id="video-title" class="style-scope ytd-rich-grid-media">'+t+'</yt-formatted-string></a></h3><ytd-channel-name id="channel-name"><div id="text-container"><yt-formatted-string id="text" class="style-scope ytd-channel-name"><a class="yt-simple-endpoint" href="/@x">'+ch+'</a></yt-formatted-string></div></ytd-channel-name><div id="metadata-line"><span class="inline-metadata-item">12K views</span><span class="inline-metadata-item">2 days ago</span></div></div></div></ytd-rich-grid-media></div>';c.append(e)}},900)</script></body></html>`;

const ddg = (q) => `<!doctype html><title>${q} at DuckDuckGo</title><div id="links">` + [['Kerala backwaters - Wikipedia','https://en.wikipedia.org/wiki/Kerala_backwaters','The Kerala backwaters are a network of brackish lagoons and lakes.'],['Alleppey houseboats guide','https://www.keralatourism.org/backwaters','Book a houseboat in Alappuzha for the backwaters.'],['Best time to visit the backwaters','https://travel.example.com/kerala','October to February is the best season.']].map(([t,u,sn])=>`<div class="result results_links web-result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&rut=abc">${t}</a></h2><a class="result__snippet" href="#">${sn}</a></div>`).join('') + `<div class="result result--ad"><a class="result__a" href="https://ads.example.com">Ad: cheap tours</a></div></div>`;
const wiki = `<!doctype html><title>Kerala backwaters - Wikipedia</title><h1 id="firstHeading">Kerala backwaters</h1><div id="mw-content-text"><div class="mw-content-ltr mw-parser-output"><p class="mw-empty-elt"></p><section><p>The Kerala backwaters are a network of brackish lagoons and canals running parallel to the Arabian Sea coast of Kerala.</p><p>The network includes five large lakes linked by canals, both man-made and natural, fed by 38 rivers.</p></section><section><p>Houseboat tourism around Alappuzha is the best-known activity.</p></section></div></div>`;
const hn = `<!doctype html><title>Hacker News</title><table>` + [['Show HN: A flow library for browser agents','https://flows.example.com','flows.example.com'],['Cloudflare D1 is now GA','https://blog.cloudflare.com/d1','blog.cloudflare.com'],['My favourite PowerMac is a Nintendo Wii','https://virtuallyfun.com/wii','virtuallyfun.com']].map(([t,u,site],i)=>`<tr class="athing submission" id="${5000+i}"><td><span class="rank">${i+1}.</span></td><td><span class="titleline"><a href="${u}">${t}</a><span class="sitebit"> (<a><span class="sitestr">${site}</span></a>)</span></span></td></tr><tr><td class="subtext">${100-i*10} points</td></tr>`).join('') + `</table>`;
const FK = [['boAt Airdopes 141 Bluetooth Headset', 1099, 4.1, 'boat-141'], ['Noise Buds VS104', 999, 4.0, 'noise-vs104'], ['JBL Tune 510BT Wireless On-Ear Headphones', 2799, 4.4, 'jbl-510bt'], ['realme Buds T300', 1999, 4.3, 'realme-t300']];
const flipkart = (q) => `<!doctype html><title>Flipkart: ${q}</title><div class="grid">` + FK.map(([t,p,r,slug],i)=>`<div data-id="FK${i}"><div class="slAVV4"><a class="VJA3rP" href="/${slug}/p/itm${i}?pid=FK${i}&lid=x"><img class="DByuf4" alt="${t}" src="https://rukminim2.flixcart.com/${slug}.jpg"></a><a class="pIpigb" href="/${slug}/p/itm${i}">${t}</a><div class="_5OesEi"><div class="MKiFS6">${r}</div></div><div class="hZ3P6w">₹${p.toLocaleString('en-IN')}</div><div class="kRYCnD">₹${(p*2).toLocaleString('en-IN')}</div><span>Add to Compare</span></div></div>`).join('') + `<div data-id="AD1"><span>Sponsored banner</span></div></div>`;
const ytResults = (q) => `<!doctype html><title>${q} - YouTube</title><ytd-app><ytd-search><ytd-item-section-renderer><div id="contents"></div></ytd-item-section-renderer></ytd-search></ytd-app><script>setTimeout(()=>{const c=document.getElementById('contents');c.insertAdjacentHTML('beforeend','<ytd-video-renderer><a id="video-title" href="/watch?v=yt1&pp=abc" title="Kerala backwaters in 4K"><yt-formatted-string>Kerala backwaters in 4K</yt-formatted-string></a><ytd-channel-name><a href="/@travel">Travel Lens</a></ytd-channel-name><div id="metadata-line"><span>1.2M views</span><span>1 year ago</span></div></ytd-video-renderer>');c.insertAdjacentHTML('beforeend','<yt-lockup-view-model><a href="/watch?v=yt2" class="thumb"></a><h3><a href="/watch?v=yt2">Houseboat day trip, Alleppey</a></h3><a href="/@kerala">Kerala Diaries</a><yt-content-metadata-view-model>300K views · 3 months ago</yt-content-metadata-view-model></yt-lockup-view-model>')},600)</script>`;

let codexMode = false;
const chatgpt = `<!doctype html><title>ChatGPT</title><main><div id="thread"></div><form id="f"><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div><button type="button" data-testid="send-button" aria-label="Send prompt">↑</button></form></main>
<script>const box=document.getElementById('prompt-textarea'),th=document.getElementById('thread');
box.addEventListener('keydown',e=>{if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();const q=box.innerText.trim();if(!q)return;box.textContent='';
const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent=q;th.append(u);
const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('form').append(stop);
setTimeout(()=>{const a=document.createElement('div');a.dataset.messageAuthorRole='assistant';const md=document.createElement('div');md.className='markdown';a.append(md);th.append(a);
const words=('ChatGPT here: the answer to "'+q+'" is 42.').split(' ');let i=0;const t=setInterval(()=>{md.textContent=words.slice(0,++i).join(' ');if(i>=words.length){clearInterval(t);stop.remove();history.replaceState(null,'','/c/abc123')}},150)},800)});</script>`;
const claude = `<!doctype html><title>Claude</title><main><div id="thread"></div><fieldset><div data-testid="chat-input" class="tiptap ProseMirror" contenteditable="true" aria-label="Write your prompt to Claude"></div></fieldset></main>
<script>const box=document.querySelector('[data-testid=chat-input]'),th=document.getElementById('thread');
box.addEventListener('keydown',e=>{if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();const q=box.innerText.trim();if(!q)return;box.textContent='';history.pushState(null,'','/chat/xyz789');
const u=document.createElement('div');u.className='user-msg';u.textContent=q;th.append(u);
setTimeout(()=>{const a=document.createElement('div');a.dataset.isStreaming='true';const md=document.createElement('div');md.className='standard-markdown';a.append(md);th.append(a);
const words=('Gold is about ₹7,900 per gram today (answer to: '+q+').').split(' ');let i=0;const t=setInterval(()=>{md.textContent=words.slice(0,++i).join(' ');if(i>=words.length){clearInterval(t);a.dataset.isStreaming='false'}},120)},600)});</script>`;
https
  .createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const u = new URL(req.url, 'https://' + host);
    let html = null;
    if (host === 'mail.google.com' && u.pathname.startsWith('/mail/')) html = gmail;
    else if (host === 'www.amazon.in' && u.pathname === '/s') html = amazon(u.searchParams.get('k') || '');
    else if (host === 'www.amazon.in' && u.pathname === '/') html = '<!doctype html><title>Amazon.in</title><form action="/s"><input id="twotabsearchtextbox" name="k" type="text" aria-label="Search Amazon.in"><input id="nav-search-submit-button" type="submit" value="Go"></form>';
    else if (host === 'www.youtube.com' && u.pathname === '/') html = youtube;
    else if (host === 'accounts.google.com') html = '<!doctype html><title>Sign in</title>Sign in';
    else if (host === 'html.duckduckgo.com' && u.pathname.startsWith('/html')) html = ddg(u.searchParams.get('q') || '');
    else if (host === 'en.wikipedia.org' && u.pathname.startsWith('/wiki/')) html = wiki;
    else if (host === 'news.ycombinator.com' && u.pathname === '/') html = hn;
    else if (host === 'www.goodreturns.in' && u.pathname.startsWith('/gold-rates')) html = '<!doctype html><title>Gold Rate Today</title><h1>Gold rate today in ' + (u.pathname.split('/')[2] || 'india').replace('.html', '') + '</h1><table id="rates"><tr class="row"><td class="g">22K</td><td class="p">₹7,285</td></tr><tr class="row"><td class="g">24K</td><td class="p">₹7,947</td></tr></table>';
    else if (host === 'www.flipkart.com' && u.pathname === '/search') html = flipkart(u.searchParams.get('q') || '');
    else if (host === 'chatgpt.com' && u.pathname === '/__codex_on') (codexMode = true), (html = 'codex mode on');
    else if (host === 'chatgpt.com' && u.pathname === '/__codex_off') (codexMode = false), (html = 'codex mode off');
    // Codex mode (test): the chat home sends you to /codex until you take its link back to the normal chat.
    else if (host === 'chatgpt.com' && u.pathname === '/' && codexMode && !/codex=0/.test(req.headers.cookie || '')) {
      res.writeHead(302, { location: '/codex' });
      return res.end();
    } else if (host === 'chatgpt.com' && u.pathname.startsWith('/codex')) html = '<!doctype html><title>Codex</title><h1>Codex</h1><nav><a href="/" onclick="document.cookie=\'codex=0; path=/\'">ChatGPT</a></nav><textarea aria-label="Describe a task"></textarea>';
    else if (host === 'chatgpt.com' && !u.pathname.startsWith('/codex')) html = chatgpt;
    else if (host === 'claude.ai') html = claude;
    else if (host === 'www.youtube.com' && u.pathname === '/results') html = ytResults(u.searchParams.get('search_query') || '');
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(8444, '127.0.0.1', () => console.log('sites up'));
