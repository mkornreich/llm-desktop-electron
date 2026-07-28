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
| `user-data/` | An **isolated** profile. This build never touches your real Claude install's data in `~/Library/Application Support/Claude`. |
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

## Reset

Delete `user-data/` to wipe the session and start fresh.
