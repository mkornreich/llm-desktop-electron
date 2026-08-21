# Plan: run this build on Linux

**Verdict: feasible, and less work than the bundled binaries suggest.** The app's own
JavaScript already treats `linux` as a first-class platform; what's macOS-bound is the five
native modules and my launcher scripts. Three features degrade and one is lost outright.

Everything below is from reading this build, not from assumption — the evidence is quoted.

---

## 1. What is already Linux-aware

The main-process JS is platform-generic and has real Linux branches (`"linux"` appears 60×,
`process.platform` 360×):

- **The agent binary has a Linux triple.** The platform-triple resolver reads
  `if (process.platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64"`,
  falling through to `throw new Error("Unsupported platform: …")`. So darwin, win32 and linux
  are the three supported targets, and Claude Code itself ships for linux-x64/arm64.
- **WSL and container awareness**: `WSL_DISTRO_NAME`, `/mnt/c/Program Files/ClaudeCode`,
  `wsl(\d+)` version parsing, `/.dockerenv` detection.
- **A Linux VM helper path**: `process.platform === "linux" && v.configure` →
  `"[VM:start] Configuring Linux VM helper…"`.
- Much of the `claude-native` usage is actually **win32**-specific (WEF trusted catalog,
  Windows Hello), confirming it is a cross-platform helper rather than a macOS one.

## 2. Native module inventory

| Module | Bundled as | Linux plan |
|---|---|---|
| `node-pty` | `prebuilds/darwin-{x64,arm64}/pty.node` only | **Swap** — npm ships `linux-x64`/`linux-arm64` prebuilds for the same version |
| `@ant/claude-native` | Mach-O universal | **Omit** — every call site goes through `maybeGetClaudeNative()`, a `try{require}catch{null}` that logs `Failed to load Claude Native` and returns; callers null-check |
| `@ant/claude-swift` (`swift_addon`, `computer_use`) | Mach-O universal | **Lost** — Swift, macOS-only by construction. Loaded via `await import()` in try/catch: *"@ant/claude-swift unavailable; macOS emits no _pressure telemetry"* |
| `office365-mcp/msal-node-runtime.node` + `libmsalruntime_arm64.dylib` | Mach-O arm64 | **Degraded** — no Linux binary available; the M365 connector's local path won't load |

The two `maybe`/try-catch loaders are what make this viable: absent native modules degrade
rather than crash. One exception throws — `openMjpegStream: claude-native encodeFrameJpeg
unavailable` — but that is computer-use frame streaming, already lost with claude-swift.

**No official Linux Claude Desktop build was available to harvest binaries from** when this
was written, so the plan omits `claude-native` rather than pretending it can be sourced.

Worth re-checking before starting, though: the app's own Buddy maker guide says *"Claude for
macOS, **Windows, and Linux** can connect Claude Cowork and Claude Code to maker devices over
BLE"*. Anthropic's documentation therefore already refers to a Linux desktop app. If one
ships, its `app.asar.unpacked` would supply Linux-native `claude-native` and `node-pty`
directly and collapse Phase 1 to almost nothing.

## 3. The subtle one: the `disclaimer` wrapper

Every subprocess (the agent, the shell-PATH probe) is spawned through a wrapper:

```js
function Van(){{const e=C.dirname(process.resourcesPath);return C.join(e,"Helpers","disclaimer")}}
function j_(e){return {cmd:Van(), args:[e.cmd, ...e.args]}}
```

The doubled brace is a **conditional the bundler folded away** — `if (platform === 'darwin')`
became a constant in this macOS build — so the path is applied unconditionally at runtime.
On Linux the app will still look for `<dirname(resourcesPath)>/Helpers/disclaimer` and fail
with `disclaimer_binary_missing` (a real code in the app's own error enum) if it is absent.

Fortunately `run.sh` already solves this on macOS with a passthrough shim; it only needs the
path computed per platform:

| | `process.resourcesPath` | shim goes at |
|---|---|---|
| macOS | `…/Electron.app/Contents/Resources` | `…/Contents/Helpers/disclaimer` |
| Linux | `…/electron/dist/resources` | `…/electron/dist/Helpers/disclaimer` |

## 4. Phases

### Phase 1 — runtime and modules (half a day)
1. `npm i electron@43 --platform=linux --arch=x64` (or arm64) into a separate tree, so macOS
   and Linux runtimes can coexist.
2. Replace `app/node_modules/node-pty/prebuilds/` with the matching Linux prebuild.
3. Delete or leave `@ant/claude-swift` and `@ant/claude-native` in place — both fail closed.
   Leaving them costs one `error` log line each at startup; deleting them is cleaner.
4. Recreate the two self-healing artefacts at Linux paths: the `resources/app.asar → app/`
   symlink and the `Helpers/disclaimer` shim.

### Phase 2 — make the launcher portable (half a day)
`run.sh` and `run-proxy.sh` are the only genuinely macOS-specific code *we* wrote. Add a
`case "$(uname -s)"` block resolving these:

| Concern | macOS | Linux |
|---|---|---|
| Claude Desktop profile (session sync source) | `~/Library/Application Support/Claude` | `~/.config/Claude` |
| Electron resources dir | `Electron.app/Contents/Resources` | `dist/resources` |
| disclaimer shim dir | `Contents/Helpers` | `dist/Helpers` |
| `stat` mtime | `stat -f '%m'` | `stat -c '%Y'` |
| in-place sed | `sed -i ''` | `sed -i` |
| "is Claude running" probe | `pgrep -f /Claude.app/Contents/MacOS/Claude` | `pgrep -f 'claude'` narrowed by path |

Portable as-is: the proxy (pure Node), all bundle patches (pure JS), the `--host-resolver-rules`
sinkhole and the webRequest canceller (Chromium-level), `.privacy`, `.openai-model`, `.sync`.

### Phase 3 — secrets and managed config (half a day)
- `safeStorage` uses the macOS Keychain; on Linux it needs libsecret (GNOME Keyring) or
  kwallet, and silently falls back to **plaintext** when neither is present. Decide
  deliberately: require a keyring, or accept plaintext token storage on that machine.
- Managed config formats in the bundle are `mobileconfig` (darwin), `reg`/`admx` (win32) —
  **no Linux format**, so `/Library/Managed Preferences` has no counterpart. This costs
  nothing here: the `.privacy` toggle already bypasses managed config by patching the gates
  directly, which is why it works at all.

### Phase 4 — verify (half a day)
Reuse the checks already built rather than inventing new ones:
1. `node --test openai-proxy/proxy.test.mjs` — 49 tests, no platform assumptions.
2. Launch and confirm the same milestones the log analysis uses: `Starting app`,
   `[my-access] loaded N features`, `isLoggedOut: false`, `claude-code/<version>`.
3. Telemetry still dead: 0 `[EventLogging] Flushing`, `Sentry disabled`,
   `isolated-segment.html` → `ERR_BLOCKED_BY_CLIENT`, and a `--log-net-log` capture showing
   0 bytes to datadog/`s-cdn`/`a-cdn`/`a-api`.
4. Agent round-trip through the proxy: `tools=214`, a `stop_reason=tool_use` turn.
5. Session sync: `[run] synced Claude sessions: N -> M` against `~/.config/Claude`.

## 5. What you lose on Linux

| Feature | Why |
|---|---|
| Global hotkey / menu-bar extras, memory-pressure telemetry, virtualization check | `@ant/claude-swift` is Swift |
| Computer-use screen capture and MJPEG streaming | `claude-swift` `computer_use` + `claude-native` `encodeFrameJpeg` |
| M365 connector (local path) | `msal-node-runtime` is a Mach-O arm64 binary |
| Windows Hello / WEF catalog | win32-only anyway |
| Scheduled tasks / timed wake | already broken here — unpackaged builds can't register the launch daemon |
| Keychain-backed token storage | libsecret-dependent; plaintext fallback otherwise |

Unaffected: the chat UI (it is remote claude.ai), Claude Code and the OpenAI proxy, sessions,
MCP over HTTP, files, notifications.

## 6. Risks worth naming up front

1. **The folded `darwin` conditionals are invisible.** The disclaimer path is one I found;
   this build was compiled *for* macOS, so other platform checks may also have been folded to
   macOS constants and will not re-evaluate on Linux. Each surfaces only at runtime. Budget
   for a few of these — the symptom is a hardcoded `Contents/…` path in a stack trace.
2. **Electron 43 must be the same minor** as the macOS side, or the N-API modules and the
   app's `electronMajor < 34` check drift apart.
3. **Login is origin-bound.** The IPC bridge validates `senderFrame.url`, and OAuth only
   accepts `http://localhost:` or `.staging` overrides for `CLAUDE_AI_URL` — so the Linux
   build must load real `claude.ai` and sign in normally.
4. **Session sync is one-way and additive**, so pointing it at a Linux `~/.config/Claude` that
   has never run Claude Desktop simply syncs nothing. Copying a macOS profile across machines
   is a separate decision, not part of this plan.

## 7. Estimate

Roughly **two days** for a working Linux build with the OpenAI proxy, telemetry toggle and
session sync intact — Phase 1–2 being most of it, Phase 3–4 shorter. Add a day if several
folded-conditional path bugs surface.
