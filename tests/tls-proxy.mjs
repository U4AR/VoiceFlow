// HTTPS front for the local mock Meta API (test only): api.meta.ai:443 → 127.0.0.1:MOCK_PORT.
// AGENT_DELAY_MS: hold agent chat requests (not the router/interpreter) that long, so a task stays "running".
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
const target = Number(process.env.MOCK_PORT);
const delay = Number(process.env.AGENT_DELAY_MS ?? 0);
https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const s = body.toString();
    const slow = delay && /chat\/completions|responses/.test(req.url) && !/Classify the user request|You distinguish spoken|Reply with OK/.test(s);
    setTimeout(() => {
      const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      up.end(body);
    }, slow ? delay : 0);
  });
}).listen(Number(process.env.TLS_PORT), '127.0.0.1', () => console.log('tls proxy up'));
