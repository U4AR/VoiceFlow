# Voice Agent — Nanobrowser foundation

This is a source import of https://github.com/nanobrowser/nanobrowser at
`19dc8e8a9be6ed06c0ef9ec7de8d84bf6a88c458`, cloned and inspected before modification.
Nanobrowser's Apache-2.0 LICENSE and AGENTS.md are retained. No code under
`src/browser-control` was modified. Its Puppeteer frame manager, chrome.debugger
transport, observation/ref rules, single agent loop, approvals, side panel, model
providers, local endpoints, and native fixture harness form the foundation.

The fork adds Meta as a provider in Settings, adapts its chat parameters, offers
Muse Voice Transcribe in the upstream microphone selector, and adds Workflows and
Dictate links to the side panel. The prior declarative workflow service and UI
are integrated as WXT entrypoints and worker routes. Workflow steps stay separate
from the agent's browser-control layer; no generated JavaScript is exposed.

Peerd is a light source dependency: four small egress/error/URL modules copied
from commit `d7174b66494cc0c3dd466dc9a8ab74b36a5d1491`, used by native Meta requests.
See src/vendor/peerd/SOURCE.txt for precise adaptations. Its UI, multi-actor loop,
VMs, sandbox and site-client system are not imported. The peerd sandbox/tool
learning remain future work; we do not claim the egress helpers implement them.

No new npm runtime dependency was added to Nanobrowser. The integrated workflow
code uses the surrounding workspace's existing workflow-core/meta-client packages
and their existing Zod dependency. Build from the whole Click workspace, not this
folder in isolation. Native Node/pnpm requirements remain those in package.json.

Analytics defaults are changed to off. Native provider keys retain upstream's
local-storage behavior; workflow-only keys can instead remain session-scoped.
Neither key store is an encrypted vault. Never embed API keys in builds.

Validation: full Nanobrowser type check and lint passed; 813 tests passed and four
upstream tests were skipped. The production WXT build passed. Extension-installed
browser scenarios could not complete in managed Chromium; prior administrator
policy blocks unpacked extensions. Live Meta is still not established. The old
custom alpha remains in apps/extension only as reference and a test fixture; the
active fork is this folder. Continuous hold-to-talk now uses an opt-in offscreen mic, bounded ring buffer, desktop hold/stillness/VAD gates and release tail. See TESTING.txt. Realtime ASR, sandboxed scripts, distillation and schedules remain outstanding.

## Voice-first product 0.4

Production welcome/options and side panel now use src/product/Setup and Panel.
Provider/model selection, rating, upstream website links, legacy welcome tips,
telemetry implementation, uninstall feedback and the developer panel are removed
from the product entry graph. Context-menu and unlimited-storage permissions were
removed. Attribution remains in the required license/notice and local credits page.

Setup verifies and stores one Meta key, configures speech/fast/specialist models,
guides the microphone grant and enables the continuous offscreen capture. The
minimal-reasoning router chooses fast Spark or specialist Wonder for complex tasks;
a pre-stream 400/404/422 on Wonder falls back to deeper Spark. Long fast runs also
increase reasoning. The specialist preview has mock wire/fallback coverage, not
live availability proof. The old multi-provider source remains for upstream tests
and reference but is not presented as settings or choice in the new product UI.

## Product 0.5: local activity and shortcut suggestions

Completion history and result tab links are now durable/local. Optional notifications
are permission-gated, use Voice Agent branding and session-backed click targets, and
focus the relevant tab/window. Background-window focus is accounted for. Manual
workflow completions also participate. Failed/stopped work is distinct from success.

Shortcut detection is deterministic: common browser keyboard tips plus suggestions
for repeated successful requests. Saving a voice alias requires a user click and name;
invocation still passes through routing/Ask permissions. These are prompt aliases,
not site-client tool distillation. The new product/activity-store and Activity UI keep
bounded local data; no analytics or new external destinations are introduced.

## Product 0.6: placement and optional home

The fast Meta router now chooses current-page or separate inactive-tab execution.
Task submission does not open the side panel; agent-created tabs do not request
foreground reveal. Completion clicks focus results without opening the panel.
Existing permitted pages receive the voice content script when the worker loads,
and content scripts cover permitted frames with Chrome's own permission enforcement.

An owned home page supports local customization and embedded voice controls. The
standard build keeps Chrome New Tab unchanged; the packaging tool emits a separate,
explicit opt-in manifest variant that overrides New Tab. Requests from the owned
home document are checked against its actual tab before gesture authority is given.
Browser work from protected pages uses a blank background tab. No browser-control
code or URL restrictions were changed. See TESTING.txt for validation and limits.

## Product 0.7: one build and settings-controlled home

Supersedes the 0.6 separate New Tab build. A local opt-in setting routes newly
created built-in New Tab pages to the owned home page. There is no manifest override;
default off preserves normal behavior and explicit navigation is rechecked before
routing. Both setting directions take effect without reinstall/reload.

Product ToolExamples uses the existing workflow worker to create, inspect, save and
run three scoped deterministic tools (E1, E2, E10) with a user-selected website.
Tests use the active fork's UI, service and page code, not the legacy application.
Creation and reuse make zero model requests. No arbitrary scripts, new permissions,
new dependencies or changes to browser-control were introduced. Trace distillation
and site-API discovery are not claimed by these predefined workflow examples.

## Product 0.8: remove presets from tool creation

The active workflow worker no longer imports deterministicWorkflow and the editor
no longer imports/loads example documents. Buttons provide natural-language requests
only. Meta authors all new definitions, including host patterns and triggers. Named
sites take priority over unrelated tab context; outputs targeting other named domains
are rejected. Explicit Save & enable activates eligible URL triggers on matching open
and future tabs. CSS persists across newly inserted tiles; pageReady handles SPA URLs.
Tests locate/open matching tabs and recover a missing top-frame receiver once using
Chrome's scripting permission. Browser-control and action approvals are unchanged.
Nine native regressions and the active UI/editor browser fixture cover the reported
Cloudflare/YouTube and missing-receiver failures. Tests use mock model streams; real
provider availability and live-site selector accuracy remain manual checks.

## Product 0.9: context-aware voice and callable functions

Focused editors no longer imply dictation. Fast obvious/named task paths and a
structured Meta intent/edit decision use a bounded press-down editor context.
User task text stays separate from untrusted field/selection quotes. Agent naming,
selection/cursor editing, guarded plain-page selection undo, and loaded test controls
are product UI features. Password-like fields are not included in the context.

The workflow schema extends compatibly with optional typed parameters, constrained
URL navigation, bounded list extraction and numeric/text filtering. Agent-only
list_flows/create_flow/call_flow ports provide create-and-use within one run without
adding Chrome access to the agent layer. Saved definitions are listed with triggers
and inputs; repeated tasks can suggest parameterized functions. No arbitrary code,
new dependency, install permission or browser-control modification was added.
See TESTING.txt and docs/context-functions-0.9.md for tested behavior and limitations.
