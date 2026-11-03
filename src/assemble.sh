#!/bin/sh
# background.js = the logger + the flow engine + the worker add-ons + the extension's own (patched) worker code.
cd "$(dirname "$0")" && cat va-logger.js va-flows-core.js va-tasks-bg.js va-flows-bg.js va-more-bg.js bg-body.js > background.js
