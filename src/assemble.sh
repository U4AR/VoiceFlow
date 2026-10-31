#!/bin/sh
# Rebuild extension/background.js after editing an add-on file:
#   background.js = the logger + the flow engine + the task add-ons + the flow add-ons + the extension's own
#   (patched, minified) worker code in src/bg-body.js.
cd "$(dirname "$0")/../extension" && cat va-logger.js va-flows-core.js va-tasks-bg.js va-flows-bg.js ../src/bg-body.js > background.js && node --check background.js && echo "extension/background.js rebuilt"
