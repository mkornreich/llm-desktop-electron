# How Claude Desktop is put together

Everything here was read out of this build's own bundle. Where a claim rests on
inference rather than a quoted string, it says so.

---

## 1. The UI is remote; the capabilities are local

The app's own source comment is the clearest statement of the design.
`app/.vite/renderer/main_window/index.html`, line 1:

```html
<!-- this is the html for app title bar and error UI. everything else gets loaded from claude.ai -->
```

That file's entire body is `<body class="light"></body>`. The local shell draws the
window frame; Anthropic's React app, served from `claude.ai`, draws everything inside
it — sidebar, composer, messages, settings.

| Layer | Where it lives | Size |
|---|---|---|
| Electron main process | local, `app/.vite/build/index.chunk-*.js` | 5.1 MB + 1.3 + 1.2 + … |
| Window shell (title bar, error screen) | local, `mainWindow.js` | 172 KB |
| **The entire chat UI** | **remote `https://claude.ai`** | not on disk |
| About / Quick-entry / Find-in-page / Buddy windows | local | 149 / 149 / 148 / 68 KB |

The remote page is attached as a `WebContentsView` via `addChildView` (8 call sites).
There are five local renderer entrypoints under `app/.vite/renderer/`: `main_window`,
`quick_window`, `find_in_page`, `about_window`, `buddy_window`.

## 2. The remote page drives your machine over an IPC bridge

This is the part worth understanding: control flows *inward*. The remote page calls
into the local main process on channels shaped like

```
$eipc_message$_699a1464-945b-4143-a09c-275519ade04d_$_claude.web_$_LocalSessions_$_getDetectedProjects
                └──── build-time namespace UUID ────┘   └ origin ┘  └── service ──┘  └─── method ───┘
```

**69 service namespaces** are exposed this way. A representative slice:

`LocalSessions` · `ClaudeCode` · `MCP` · `FileSystem` · `FilePickers` · `Skills` ·
`Extensions` · `WakeScheduler` · `GlobalShortcut` · `DesktopNotifications` ·
`ClaudeVM` · `Simulator` · `CoworkMemory` · `SupportBundle` · `Auth` · `Account` ·
`AutoUpdater` · `DeepLink` · `Toast` · `WindowControl`

There are **four** namespaces, one on a different build UUID:

| Namespace | UUID |
|---|---|
| `claude.web` | `699a1464-945b-4143-a09c-275519ade04d` |
| `claude.buddy` | `699a1464-…` |
| `claude.settings` | `699a1464-…` |
| `electron_window_` | `fcb91d11-972d-4fd6-b90b-72739699bff5` |

Every handler validates the caller. The failure message is explicit:

```
"<Service>" from '${r.senderFrame?.url}' did not pass origin validation
```

That check is the source of the two harmless `getInitialLocale … did not pass origin
validation` warnings at startup — they come from the brief local `file://` splash
before the window navigates to `claude.ai`, which is not a trusted origin.

## 3. What can be changed, and what cannot

Proven in this repository, not theoretical:

| Layer | Changeable | How |
|---|---|---|
| Main process (all 5 MB) | **yes** | Readable JS on disk. Twelve patches live here: 2 agent base-URLs, 5 telemetry gates, a request canceller, `app.setName` |
| Any renderer request | **yes** | The app's own `webRequest.onBeforeRequest` handler is patchable — cancel or redirect anything, including by path on a shared host |
| DNS | **yes** | `--host-resolver-rules`, which is how the analytics hosts are sinkholed |
| JS inside the remote page | **yes** | `registerPreloadScript` plus main-world injection |
| All 69 IPC service implementations | **yes** | They are local code |
| The web app's origin | **partly** | `CLAUDE_AI_URL` is honoured when `buildType === "dev"`, but OAuth only accepts `http://localhost:` or `.staging`, so a real login needs real `claude.ai` |

Not reachable at any price:

- **Conversation state.** The completion request carries `{prompt, model, effort,
  thinking_mode, tools}` and **no message history** — it is server-side, keyed by
  conversation id. This is the concrete reason the main chat cannot be pointed at
  another model provider, and no amount of local patching changes it.
- **The chat UI's source**, served from `assets-proxy.anthropic.com`. It can be
  intercepted and injected into at runtime, but not edited.
- **Session grouping.** Group ids look like `sgrp_…` and the string `sgrp_` appears
  **zero** times anywhere in either profile's Local Storage, IndexedDB, Session
  Storage or sessions directory — so grouping follows the account, not the machine.
- **Account, org, entitlements and feature flags** — 53 org features and 236
  GrowthBook flags are fetched per launch.
- **Remote MCP execution** — tool calls are proxied through Anthropic and run there.

The clean summary: **presentation and conversation state are server-side; execution
and configuration are client-side.** That boundary is why the agent sub-layer could be
moved to OpenAI while the chat could not.

## 4. Where the agent's config and memory live

Both this build and the real app resolve the same directory:

```js
process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
```

So memory files, `MEMORY.md` indexes, project `CLAUDE.md`s, settings and transcripts
are shared with Claude Desktop and the `claude` CLI without configuring anything.
Verified two ways: every child process runs with `HOME=$HOME` and no
`CLAUDE_CONFIG_DIR` override, and a session created *inside this build* wrote its
transcript to `~/.claude/projects/<slug>/<cliSessionId>.jsonl` rather than under
`user-data/`.

Sessions are the exception — they live in the Electron profile, which is isolated
here, so `run.sh` copies them in on each launch. See the README.

## 5. Things that had to be worked around

| Problem | Cause | Fix |
|---|---|---|
| Helper paths resolve to `<resourcesPath>/app.asar/…` | The app expects the packaged layout | `run.sh` symlinks `Resources/app.asar → app/` |
| Every subprocess spawn fails | Spawns go through `dirname(resourcesPath)/Helpers/disclaimer`, a macOS TCC wrapper absent from stock Electron | `run.sh` drops in an `exec "$@"` passthrough shim |
| `--remote-debugging-port` exits silently | A cryptographically signed CDP gate — the token cannot be forged | Use `--enable-logging` and `--log-net-log` instead |
| Agent reports "binary missing or damaged" | The app pins an RC build whose download URL is not publicly fetchable | `CLAUDE_CODE_LOCAL_BINARY` points at a locally installed `claude` |
| Renaming `productName` broke login | The rename changed the User-Agent, so claude.ai stopped recognising it as the desktop app and showed an install wall | Reverted |
| `MISSING_TRANSLATION` ×514 per launch | `resources/i18n` was not in the asar | Cosmetic; menu strings fall back to English |
| Scheduled tasks never initialise | Unpackaged builds have no `Contents/Library/LaunchDaemons/` plist, and the app says so: `[wake-scheduler] DEV BUILD — daemon registration will fail` | None — timed wakes are inert here |
