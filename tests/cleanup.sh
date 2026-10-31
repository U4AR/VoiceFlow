#!/bin/sh
# Stop test browsers and helper servers left over from a crashed test run.
for pid in $(pgrep -f '^/opt/google/chrome/chrome .*remote-debugging-port=93'); do kill $pid; done
for pid in $(pgrep -f '^node tls-proxy'); do kill $pid; done
for pid in $(pgrep -f 'mock[0-9]\.mts'); do kill $pid; done
for pid in $(pgrep -f '^python3 -m http.server 8792'); do kill $pid; done
for pid in $(pgrep -f 'voice-agent-mcp.mjs'); do kill $pid; done
sleep 2
echo "chrome left: $(pgrep -fc '^/opt/google/chrome/chrome ')"
