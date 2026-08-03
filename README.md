# Claude Desktop — run from `app.asar` under stock Electron

This turns `~/Downloads/app.asar` (the **Claude Desktop** app, `@ant/desktop`
v1.24012.9 by Anthropic PBC — an Electron Forge + Vite build) into a runnable
Electron app using a stock Electron runtime.

> **Private by necessity.** `app/` is Anthropic's unpacked proprietary bundle
> (~40 MB of their JS, native binaries and resources). Keep this repository
> private — publishing it would be redistributing their software.

## Setup

`node_modules/` is not committed, so a fresh clone needs the Electron runtime
installed once:

```bash
git clone git@github.com:mkornreich/llm-desktop-electron.git
cd llm-desktop-electron
npm install            # pulls Electron 43.x — ~200 MB, one time
./run.sh
```

Everything else self-heals on launch: `run.sh` recreates the `app.asar` symlink and
the `disclaimer` shim each time, so an `npm install` that wipes `node_modules` costs
nothing. Requires macOS (see [LINUX.md](LINUX.md)), Node ≥ 22 for the proxy, and — for
OpenAI mode — an API key in `~/.dbeaver-ai-complete` (never in this repo).

A window opens and loads the Claude login screen from `claude.ai`. Sign in as you
would in the desktop app. Quit with `Cmd+Q`.

## Documentation

| Document | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the app is actually put together: which UI is local vs. remote, the IPC bridge the remote page uses to drive your machine, and which layers can be modified |
| [ANTHROPIC_ENDPOINTS.md](ANTHROPIC_ENDPOINTS.md) | Every Anthropic endpoint the app calls, with payloads and responses, and what each is for |
| [FINDINGS.md](FINDINGS.md) | Notable and unreleased features found in the bundle — companion-hardware pairing, remote device control, permission modes, the extension registry |
| [LINUX.md](LINUX.md) | A phased plan for running this build on Linux, with the native-module and folded-conditional blockers |
| [openai-proxy/README.md](openai-proxy/README.md) | The Anthropic↔OpenAI proxy: scope, the twelve bundle patches, output shaping, auto-continue, and its 49 tests |
| `settings/` | The settings window: `server.js` (local API), `config.js` (dot-file read/write), `index.html` (UI), and 8 tests covering comment preservation |

## How it was assembled

| Piece | What it is |
|-------|-----------|
| `app/` | The extracted `app.asar` with the native binaries from `app.asar.unpacked` merged back in at their original relative paths (`@ant/claude-native`, `@ant/claude-swift`, `node-pty`, office365 `msal`). |
| `node_modules/electron` | Stock **Electron 43.2.0**. The app hard-requires Electron ≥ 34 (`if (electronMajor < 34) throw`); 43 is the line current at this build's date and ships Node 24 (the app needs Node ≥ 22). The native modules are all N-API, so they load across ABI versions. |
| `user-data/` | An **isolated** profile — this build never *writes* to your real Claude install's data in `~/Library/Application Support/Claude`. It does *read* from it: `run.sh` copies Claude Desktop's sessions in on each launch (see [Sessions and memory](#sessions-and-memory)). |
| `run.sh` | The one launcher. Self-heals the layout, selects the model provider, applies the telemetry toggle, syncs sessions, then execs Electron. `run-openai.sh` and `run-anthropic.sh` are one-line wrappers over it. |
| `openai-proxy/` | The Anthropic↔OpenAI translation proxy and its test suite. Only used in OpenAI mode. |

### Settings window

```bash
./settings.sh
```

A GUI for every parameter below — grouped, each with the reasoning behind it, plus live
status chips (is the app running, is the proxy up, which model and classifier, tokens used
so far) and a **Save & restart app** button, since most settings are read at launch.

It runs as a small local page rather than an Electron window, for a concrete reason:
`run.sh` symlinks `Resources/app.asar → app/` because several of the app's worker paths
resolve through `<resourcesPath>/app.asar`, and that symlink makes Electron load
**Anthropic's** app and ignore any CLI app path — verified with both `electron settings`
and `electron --app=settings`, which each booted `appVersion 1.24012.9`. A second Electron
would mean another ~200 MB runtime, and patching a window into their bundle would have to
be redone on every re-extraction. `settings.sh` opens it as a chrome-less app window when
Chrome/Canary/Edge/Brave is available, otherwise in the default browser.

The server binds to `127.0.0.1` and requires a **per-start token** in the URL. That is not
decoration: the API writes config and can restart the app, and without a token any web page
you happened to visit could POST to `127.0.0.1:8765` and do the same. Requests without it
get a 403.

Writes are surgical — only the `KEY=value` line changes. These dot files are mostly
documentation, so a GUI that rewrote them from a schema would silently delete the reasoning
they carry. Verified on the live file: a save changed exactly one line of 52 and left all 38
comment lines byte-identical.

### Configuration — four dot files

All read by `run.sh` at launch; each can be overridden per-launch by an env var of
the same name. None contains a secret.

| File | Setting | Default | Effect |
|---|---|---|---|
| [`.provider`](.provider) | `PROVIDER` | `openai` | `anthropic` = the agent calls Anthropic with Claude; `openai` = via the proxy |
| [`.openai-model`](.openai-model) | `OPENAI_MODEL` and friends | `gpt-5.3-codex` | Model, classifier model, output shaping, auto-continue, thinking. `OPENAI_REASONING_EFFORT=max` — the proxy steps down to the highest value the model accepts (`xhigh` for gpt-5.3-codex/5.4) |
| [`.privacy`](.privacy) | `DISABLE_TELEMETRY` | `1` | Kills first-party telemetry, Sentry, Datadog and the proxied analytics hosts |
| [`.sync`](.sync) | `SYNC_CLAUDE_SESSIONS` | `1` | Copies Claude Desktop's sessions into this build on every launch |

`run.sh` also (re)creates one symlink:
`node_modules/electron/dist/Electron.app/Contents/Resources/app.asar → app/`.
A few of the app's helper-process paths are resolved as
`<resourcesPath>/app.asar/…` with no unpacked fallback (e.g. the shell-PATH
worker); the symlink makes those resolve and mirrors the real packaged layout.
It's recreated on every launch so it survives an Electron reinstall.

The app runs **unpackaged** (`app.isPackaged === false`), which is the app's own
dev layout: it resolves resources relative to the app directory instead of the
signed-bundle paths.

## What works / what doesn't

**Works:** launches and stays running; the window renders the real Claude web UI
(login screen); native addons load (the Swift addon logs a hotkey line); the
desktop↔web IPC bridge is valid on the `claude.ai` origin.

**Cosmetic / benign:**
- Two `getInitialLocale … did not pass origin validation` warnings at startup.
  These come from the brief local `file://` splash page before the window
  navigates to `claude.ai`. The app's IPC allowlist trusts the `claude.ai`
  origin and `app://localhost`, not `file://`, so only the splash's locale call
  is rejected — it falls back to `en-US`. No effect once on `claude.ai`.
- `MISSING_TRANSLATION` warnings: the `resources/i18n` locale files weren't part
  of the asar/unpacked, so main-process menu/tray strings use their embedded
  English defaults. (An empty `app/resources/i18n/en-US.json` stub silences the
  file-not-found errors.)
- A one-off "Shell environment extraction timed out (attempt 1/5)" — the login
  shell is slow to spawn on the first try; it retries and meanwhile falls back to
  the inherited `PATH`.

**Inherent limits of running outside the signed bundle:** features tied to the
original code-signed `.app` / bundle identity — auto-update, OS-level deep-link
(`claude://`) registration, and anything gated on macOS entitlements the stock
Electron binary doesn't carry (e.g. the VM/"virtualization" features, which the
app itself reports as unavailable) — will not work here. `--remote-debugging-port`
is refused by the app's built-in, cryptographically-signed CDP gate.

**Scheduled tasks and wake scheduling do not work**, and the app says so itself:
`[wake-scheduler] DEV BUILD — daemon registration will fail. The dev Electron bundle
has no Contents/Library/LaunchDaemons/ plist.` The knock-on is the
`CCDScheduledTasks_getAllScheduledTasks` handler failing with "Scheduled tasks not
initialized" (3× per launch). Anything that needs the machine woken on a timer —
`CronCreate`, `ScheduleWakeup`, scheduled agents — is inert here. Everything
interactive is unaffected.

## Choose which model backs the agent

```bash
./run-anthropic.sh    # Claude, calling Anthropic directly (stock behaviour)
./run-openai.sh       # OpenAI, via the local translation proxy
./run.sh              # whichever the .provider dot file says (default: openai)
```

Both wrappers are one line — the logic lives in `run.sh`, selected by `PROVIDER`
(`.provider` dot file, or `PROVIDER=anthropic ./run.sh` for a single launch).

| | `anthropic` | `openai` |
|---|---|---|
| agent's `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | `http://127.0.0.1:8123` |
| translation proxy | not started | started, health-checked |
| `.openai-model` `CLAUDE_CODE_*` settings | **not applied** | applied |
| model | Claude, as shipped | `gpt-5.3-codex` (see `.openai-model`) |

Switching back needs **no un-patching**: every bundle edit is env-gated
(`PROXY_ANTHROPIC_BASE_URL || <original host>`), so with the variable unset the app
uses its own Anthropic host. Anthropic mode also actively drops
`CLAUDE_CODE_BG_CLASSIFIER_MODEL` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
if they are set — they hold OpenAI model ids in `.openai-model`, and sending
`gpt-4.1-mini` to Anthropic just errors.

Maximum reasoning is the default in both modes, via two different knobs: the proxy's
`OPENAI_REASONING_EFFORT` on the OpenAI path, and `CLAUDE_CODE_EFFORT_LEVEL=max` plus
`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` exported by `run.sh` for the app and the Claude CLI —
the latter is read by the app's own `getDefaultEffort()` and sets the default for new
sessions. `MAX_THINKING_TOKENS` is deliberately not used: the CLI's own migration notes
call `thinking.budget_tokens` deprecated in favour of adaptive thinking.

Either way this only affects the **agent**. The chat window is the remote claude.ai
web app talking to Anthropic in both modes. `CLAUDE_CODE_LOCAL_BINARY`, the telemetry
toggle and the session sync are provider-independent and apply to both. See
[openai-proxy/README.md](openai-proxy/README.md) for the proxy's scope and limits.

## Reset

Delete `user-data/` to wipe the session and start fresh.

## Sessions and memory

### Memory and config — already shared, nothing to sync

The agent in this build reads the **same** `~/.claude` as Claude Desktop and the
`claude` CLI, so your memory files, `MEMORY.md` indexes, project `CLAUDE.md`s,
settings and session transcripts are all already visible to it. This is not
configured anywhere — it falls out of how the config dir resolves:

```js
process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
```

Verified rather than assumed, two ways:

- Every child process of this build runs with `HOME=$HOME` and **no**
  `CLAUDE_CONFIG_DIR` override, so it resolves `$HOME/.claude`.
- A session created *inside this build* wrote its transcript to
  `~/.claude/projects/<slug>/<cliSessionId>.jsonl` — the shared location, not
  anywhere under `user-data/`.

The MCP connectors come along too: a captured request carried all **214** tools,
Asana/Slack/Notion/calendar servers included (`PROXY_DUMP_TOOLS=1` — see
`openai-proxy/README.md`).

### Sessions — copied in on every launch

Sessions are the one thing that *isn't* shared, because they live in the profile
and this build runs on an isolated `--user-data-dir`. So `run.sh` syncs them
before Electron starts:

```
~/Library/Application Support/Claude/claude-code-sessions/<user>/<org>/local_*.json
  ->  user-data/claude-code-sessions/<user>/<org>/
```

Each `local_<uuid>.json` holds one session's metadata — `sessionId`,
`cliSessionId`, `cwd`, `title`, `isArchived`, `model`, `effort`,
`permissionMode`, `enabledMcpTools`. There is **no group field**: the sidebar
derives grouping from `cwd`, so copying these files brings sessions across with
their titles *and* their grouping intact.

The copy is `rsync -a --update` with no `--delete`, which makes it one-way and
additive. Tested by planting two things before a launch and checking both
survived:

| Planted | After sync |
|---|---|
| a session that exists only in this build | kept |
| a file edited to be *newer* here than the source | edit kept, not overwritten |
| all 378 Claude Desktop sessions | **0 missing**, 15 build-only sessions retained |

Toggle it in the **`.sync`** dot file (`SYNC_CLAUDE_SESSIONS=0` to launch without
syncing). If Claude Desktop is running, the launcher warns: a session it happens
to be writing at that instant can copy incompletely, and relaunching picks up the
final version.

### Grouping — settled

Grouping is **server-side**, and there is nothing to sync. Captured with
`--net-log-capture-mode=Everything`, `GET /api/claude_code/organizations/{org}/user_settings`
returns the entire sidebar store:

```json
{"state":{"groupByByMode":{"code":"custom"},
          "customGroups":[{"id":"cg-1b717816-…","name":"App Analysis"}, … 7 groups …],
          "customGroupAssignments":{},
          "customGroupOrder":{},
          "pinnedOrder":[],"recentsTypeFilter":"all","recentsStatusFilter":"active"},
 "version":1}
```

Because it follows the account, both apps see identical grouping the moment they are logged in.
`LSS-persisted.dframe-group-scopes` in Local Storage is only a **local mirror** of this.

**Why the sidebar nonetheless looks ungrouped: `customGroupAssignments` is `{}`.** The mode is
`custom` and seven groups are defined, but no session is assigned to any of them — server-side,
for both apps. So there is no sync bug to fix here; the assignments simply are not set. They are
made in the UI, and nothing this launcher does can substitute for that.

Two corrections this produced, both recorded because the reasoning was wrong twice:

- The first answer, "grouping is server-side", was reached by grepping for `sgrp_` and finding
  nothing. Right conclusion, wrong evidence — `sgrp_` is the desktop bundle's *notification*
  format and never appears in either profile.
- The second answer, "grouping is local in Local Storage", came from finding
  `dframe-group-scopes` and `cg-` ids there. Wrong: that is a cache of the server store.

The network capture is what settled it, because it shows the authoritative source rather than a
copy of it. `SYNC_CLAUDE_UI_STATE` still exists for replacing this build's UI state deliberately, but it now
defaults to **0** — it cannot help grouping and it does overwrite composer drafts.

**Two hazards around `Local Storage`, both hit while investigating this:**

- **It holds auth state.** Deleting it produced `401`s and `Bootstrap API fetch failed` until a
  known-good copy was restored. An earlier note here claimed login was unaffected because
  authentication lives in Cookies — that was wrong.
- **Never restore a LevelDB backup from a profile that was not closed cleanly.** A backup taken
  after the app was killed with `pkill` left startup hanging in window setup, with renderers
  reporting *"Terminating current process after 15 seconds with no connection"*. The copy had
  captured a torn write. Recovery is to copy in a good `Local Storage`, not to delete it.

### Are the migrated sessions grouped correctly?

Grouping has exactly two sources, and neither is extra local state to copy:

- **Server-side.** A group id has the form `sgrp_…` (`/^sgrp_[A-Za-z0-9_-]{1,64}$/`),
  and in the local bundle it appears *only* in desktop-notification plumbing. The
  string `sgrp_` occurs **zero** times anywhere in either profile — Local Storage,
  IndexedDB, Session Storage, the sessions dir. So the web app owns grouping and it
  follows the account, not the machine.
- **`cwd` in the session file.** Everything the sidebar can group local sessions by
  travels inside `local_<uuid>.json`.

Verified by diffing every migrated session against its source on the fields that can
drive grouping, ordering and labelling — `cwd`, `originCwd`, `title`, `titleSource`,
`isArchived`, `worktreePath`, `worktreeName`, `branch`, `sourceBranch`, timestamps,
`model`, `effort`:

```
migrated sessions checked : 379
  grouping fields identical: 374
  missing from build       : 0
  field drift              : 5   (lastActivityAt / lastFocusedAt only)
distinct cwd values        : 4   (the repo + 3 worktrees)
```

The 5 drifted sessions differ **only** in `lastActivityAt`/`lastFocusedAt` — focus
timestamps, not grouping keys. Two causes, both correct: sessions opened in *this*
build are newer here and `--update` deliberately keeps them, and sessions Claude
Desktop touches *after* launch are picked up by the next launch. That is inherent to
copy-on-open.

One group points at `…/.claude/worktrees/musing-chandrasekhar-f2b1fd`, which no
longer exists on disk. The real app has the same dangling `cwd`, so both behave the
same; the sync did not cause it.

`[detectedProjects] done: 0 total projects` in the log is unrelated to session
grouping — that scan looks for **editor** workspace databases (VS Code, Cursor, Zed)
and logged `state.vscdb not found`. It feeds the recent-projects feature.
