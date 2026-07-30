# Claude Desktop — run from `app.asar` under stock Electron

This turns `~/Downloads/app.asar` (the **Claude Desktop** app, `@ant/desktop`
v1.24012.9 by Anthropic PBC — an Electron Forge + Vite build) into a runnable
Electron app using a stock Electron runtime.

## Run it

```bash
cd ~/Downloads/claude-desktop-electron
./run.sh
```

A window opens and loads the Claude login screen (served from `claude.ai`).
Sign in there as you would in the desktop app. Quit from the app menu or with
`Cmd+Q`.

## How it was assembled

| Piece | What it is |
|-------|-----------|
| `app/` | The extracted `app.asar` with the native binaries from `app.asar.unpacked` merged back in at their original relative paths (`@ant/claude-native`, `@ant/claude-swift`, `node-pty`, office365 `msal`). |
| `node_modules/electron` | Stock **Electron 43.2.0**. The app hard-requires Electron ≥ 34 (`if (electronMajor < 34) throw`); 43 is the line current at this build's date and ships Node 24 (the app needs Node ≥ 22). The native modules are all N-API, so they load across ABI versions. |
| `user-data/` | An **isolated** profile — this build never *writes* to your real Claude install's data in `~/Library/Application Support/Claude`. It does *read* from it: `run.sh` copies Claude Desktop's sessions in on each launch (see [Sessions and memory](#sessions-and-memory)). |
| `run.sh` | Launcher: `electron app` with the isolated profile and logging on. |

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

## Run the Claude Code sub-layer on OpenAI (experiment)

```bash
./run-openai.sh
```

Routes the app's **Claude Code / agent** calls through a local Anthropic→OpenAI
translation proxy so that sub-layer runs on OpenAI (`gpt-4.1`, key read from
`~/.dbeaver-ai-complete`). Verified end-to-end with the in-app agent. The main
chat window is remote claude.ai and is unaffected. See
[openai-proxy/README.md](openai-proxy/README.md) for scope, limits, and the
patches involved.

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
