#!/bin/sh
# Run the extension test suites one after another, killing leftover mock servers between them (test helper).
R=/tmp/claude-0/va9run; cd $R
km() { for p in $(pgrep -f 'mock/mock'); do kill $p 2>/dev/null; done; sleep 1; }
km; sh reset-lib3.sh >/dev/null 2>&1; node seed-lib.mjs >/dev/null; timeout 900 python3 auto-test.py > auto-test.out 2>&1
km; sh reset-lib3.sh >/dev/null 2>&1; timeout 1500 python3 flows-test.py > flows-test.out 2>&1
km; sh reset-lib3.sh >/dev/null 2>&1; node seed-lib.mjs >/dev/null; timeout 900 python3 mcp-test.py > mcp-test.out 2>&1
km; timeout 1200 python3 feat-test.py > feat-test.out 2>&1
km
for f in auto-test flows-test mcp-test feat-test; do echo "$f: $(grep RESULT $f.out)"; grep FAIL $f.out | cut -c1-250; done
