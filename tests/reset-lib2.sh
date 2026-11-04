#!/bin/sh
# Restart the local flow library (test config: word-hash embeddings) with an empty database (test only).
for p in $(pgrep -f 'wrangler|workerd'); do kill $p 2>/dev/null; done
sleep 2
cd /tmp/claude-0/va9run/flowlib && rm -rf .wrangler/state && npx wrangler d1 execute voice-agent-flows --local --config wrangler.test.toml --file schema.sql >/dev/null 2>&1
nohup npx wrangler dev --config wrangler.test.toml --port 8787 --ip 127.0.0.1 > dev.log 2>&1 &
sleep 10
curl -s localhost:8787/api/health
