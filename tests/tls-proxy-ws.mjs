// HTTPS front for the mock Meta API plus a mock realtime transcription socket (test only).
// GET /__mode?m=ok|fail|hang sets how the socket behaves. GET /__stats returns what the socket received.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from '/tmp/claude-0/va9run/flowlib/node_modules/ws/wrapper.mjs';
const target = Number(process.env.MOCK_PORT);
let mode = 'ok';
let stats = [];
let LIVE = process.env.LIVE_TRANSCRIPT || 'type exactly: live words here';
const server = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
  if (req.url.startsWith('/__mode')) { mode = new URL(req.url, 'https://x').searchParams.get('m'); stats = []; res.end(mode); return; }
  if (req.url.startsWith('/__live')) { LIVE = new URL(req.url, 'https://x').searchParams.get('t'); res.end(LIVE); return; }
  if (req.url.startsWith('/__stats')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(stats)); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(body);
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/v1/asr/realtime') || mode === 'refuse') { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const st = { handshake: null, bytes: 0, frames: 0, endStream: false, at: Date.now() };
    stats.push(st);
    if (mode === 'fail') { ws.close(1011, 'mock failure'); return; }
    let partialSent = 0;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(String(data));
        if (!st.handshake) { st.handshake = m; ws.send(JSON.stringify({ sessionId: 'mock-session' })); return; }
        if (m.type === 'endStream') {
          st.endStream = true; st.endAt = Date.now();
          if (mode === 'hang') return;
          setTimeout(() => { ws.send(JSON.stringify({ type: 'transcript', transcript: LIVE, final: true, audioProcessedMs: st.bytes / 32 })); ws.close(1000); }, 150);
        }
        return;
      }
      st.bytes += data.length; st.frames++;
      if (st.bytes - partialSent > 16000) { partialSent = st.bytes; ws.send(JSON.stringify({ type: 'transcript', transcript: LIVE.split(' ').slice(0, 3 + Math.floor(st.bytes / 32000)).join(' '), final: false })); }
    });
  });
});
server.listen(Number(process.env.TLS_PORT), '127.0.0.1', () => console.log('tls proxy up'));
