#!/bin/sh
# Restart the local flow library with an empty database (test only).
for p in $(pgrep -f 'wrangler|workerd'); do kill $p 2>/dev/null; done
sleep 2
cd /tmp/claude-0/va9run/flowlib && rm -rf .wrangler/state && npx wrangler d1 execute voice-agent-flows --local --file schema.sql >/dev/null 2>&1
nohup npx wrangler dev --port 8787 --ip 127.0.0.1 > dev.log 2>&1 &
sleep 10
curl -s localhost:8787/api/health
