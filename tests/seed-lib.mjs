// Publish the example flows to a local library (test only).
import fs from 'fs';
const url = process.argv[2] || 'http://127.0.0.1:8787', token = 'starter-token-1234567890abcdef', dir = '/tmp/claude-0/va9run/flowlib/examples';
const order = ['gmail-search','gmail-read-mails','amazon-search','flipkart-search','youtube-feed','youtube-search','hackernews-top','duckduckgo-search','wikipedia-summary','gmail-digest','amazon-best-pick','price-compare','topic-briefing','morning-digest'];
for (const n of order) {
  const r = await fetch(url + '/api/flows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-contributor': token }, body: JSON.stringify({ flow: { ...JSON.parse(fs.readFileSync(`${dir}/${n}.json`)), author: 'starter' } }) });
  if (!r.ok) console.log('FAIL', n, await r.text());
}
console.log(JSON.stringify((await (await fetch(url + '/api/sites/mail.google.com')).json()).flows.map((f) => f.id)));
