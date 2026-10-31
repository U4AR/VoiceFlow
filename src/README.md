# Building background.js

The extension is a compiled build (a Nanobrowser fork, see `extension/FORK.md`). The improvements are add-on files in
`extension/` that are concatenated in front of the build's own worker code:

| File | What it adds |
|---|---|
| `va-logger.js` | logging, Meta API usage metering |
| `va-flows-core.js` | the flow engine: validator, runner, page operations, page inspector (shared with the online library) |
| `va-tasks-bg.js` | task list, progress, questions, cost meter, recent-task context, history shortening, tool loading |
| `va-flows-bg.js` | the agent's flow tools, sharing cards, online library client, per-site flows, the MCP bridge |
| `src/bg-body.js` | the build's worker code, with small string patches (hooks into the above) |

After editing any of them, run `sh src/assemble.sh` and reload the extension.
Page-side add-ons (`va-tasks.js`, `va-prompt-ui.js`, `va-guard.js`, `tasks.html/js`) are loaded directly by the manifest.
