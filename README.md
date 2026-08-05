# Run Claude's agent tooling on an OpenAI API key

Claude Code and Claude Desktop are good agent harnesses. This repo lets you drive
them with an **OpenAI** key instead of an Anthropic one, by translating between the
two APIs locally.

Two independent things live here, and **you probably only want the first**:

| | What it is | What you need |
|---|---|---|
| **1. The proxy** — [`openai-proxy/`](openai-proxy/) | A local server that speaks the **Anthropic Messages API** on the front and calls **OpenAI** on the back. Point any Anthropic-API client at it. | Node with native `fetch` (18+), an OpenAI API key |
| **2. The desktop build** | Anthropic's **Claude Desktop** app, unpacked and run under a stock Electron runtime, with the proxy wired in and a settings GUI | macOS, plus **your own copy** of Claude Desktop |

The proxy is the generally useful part: it works with the ordinary `claude` CLI on
any machine, and needs nothing from this repo's `app/` directory. Everything below
the [Desktop build](#2-the-desktop-build) heading is specific to running Anthropic's
Electron app and can be ignored if you just want the CLI on OpenAI.

> **Licensing, read this first.** `app/` is Anthropic's unpacked proprietary bundle
> (~40 MB of their JavaScript, native binaries and resources). It is **not**
> redistributable, which is why this repository is private. If you want part 2, you
> must supply that directory from your own licensed Claude Desktop install — see
> [Supplying the bundle](#supplying-the-bundle). Nothing in part 1 touches it.

---

## 1. The proxy — Claude Code on OpenAI

### Quick start

```bash
export OPENAI_API_KEY=sk-...           # the only secret involved
cd openai-proxy && node proxy.mjs      # listens on 127.0.0.1:8123
```

Then, in another shell, point the stock Claude Code CLI at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8123 ANTHROPIC_API_KEY=unused claude -p "hello"
```

`ANTHROPIC_API_KEY` must be set to *something* because the CLI insists on it, but the
proxy ignores it and authenticates to OpenAI with `OPENAI_API_KEY`.

Verified end-to-end with the unmodified CLI: a full agent turn, 221 tools, tool calls
executed and results fed back, with the proxy log showing
`model=claude-opus-4-8->gpt-5.3-codex`. The CLI still *says* "Opus" because it
hardcodes that in its own prompt and asks for it by name — the proxy log and the
`ANTHROPIC_BASE_URL` in the process environment are the ground truth.

### Configuration

Everything has a default; set only what you want to change.

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. Also readable from a `KEY=VALUE` dot file (see below). |
| `OPENAI_MODEL` | `gpt-5.3-codex` | Any OpenAI model id. Names containing `codex` are routed to the **Responses** API automatically. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at any OpenAI-compatible endpoint. |
| `PORT` | `8123` | |
| `OPENAI_API` | auto | `responses` or `chat`, to override the automatic choice. |
| `OPENAI_REASONING_EFFORT` | `max` | The proxy steps down to the highest value your model accepts. |
| `OPENAI_CLASSIFIER_SAFETY_MODEL` | `gpt-5.4` | Model for Claude Code's auto-mode safety verdict. It has a 60-second deadline and **denies the action** when it expires, so this wants a fast model — see [openai-proxy/README.md](openai-proxy/README.md#is-the-classifier-still-calling-anthropic-issue-11) for the measurements. |

The full list — around thirty knobs, each documented with the bug that motivated it —
is in [openai-proxy/README.md](openai-proxy/README.md).

Instead of environment variables you can put `KEY=VALUE` lines in
`.openai-model` at the repo root (checked in, for non-secrets) or in
`~/.dbeaver-ai-complete` (a pre-existing per-user file this proxy will read an
`apiKey=` from if it happens to exist). Precedence is env var → project file →
user file → default.

### Which API surface, and why it matters

| | Chat Completions | Responses |
|---|---|---|
| Tool limit | **128** (129 → HTTP 400) | none observed — probed to 512 |
| Reasoning controls | none | `reasoning.effort`, reasoning summaries |

Claude Code offers 27 tools; Claude Desktop offers over 200. On the chat surface the
128-tool cap is real, so the proxy keeps the essential tools (read/write/edit/run/
search/plan/web, plus renderers) and fills the remainder in the agent's own order,
logging what it dropped — a silently truncated tool list is indistinguishable from a
model that just declined to use a tool.

### What the translation covers

Text and tool calls in both directions, streaming and non-streaming, plus a set of
fixes for behaviour differences between the two model families:

- **Rendering** — GPT models emit `\(…\)` / `\[…\]` for maths, which Claude's
  renderer shows literally. Rewritten to `$…$` / `$$…$$`, fence-aware so code
  samples stay verbatim.
- **Persistence** — GPT models routinely end a turn to check in ("If you want, I'll
  run that now"), which in an agent loop reads as a stall. An explicit persistence
  directive plus auto-continue when a turn announces an action and calls no tool.
- **Context overflow** — Claude Code sizes its own auto-compaction from the model it
  *thinks* it is talking to, so it never fires. The proxy compacts and retries,
  including when the overflow arrives as a mid-stream event rather than an HTTP 400.
- **Empty and truncated turns** — retried or resumed rather than surfaced as a blank
  reply.
- **Unsupported parameters** — the CLI sends `stop_sequences`, which some models
  reject. The proxy drops whichever parameter the API names and retries, so the next
  unsupported knob self-heals too.
- **Thinking** — OpenAI reasoning *summaries* are mapped to Anthropic thinking
  blocks. Raw chain-of-thought is not available from the API at any setting.

Known gaps: images are dropped (`[image omitted by proxy]`) and
`/v1/messages/count_tokens` is estimated. Cost figures the CLI prints are computed
from Anthropic's price list and are meaningless when proxied.

### Tests

```bash
node --test openai-proxy/proxy.test.mjs     # 128 tests
node --test settings/config.test.js         #   8 tests
```

Most were written against a specific misbehaviour; the comments say which.

---

## 2. The desktop build

Runs Anthropic's Claude Desktop (`@ant/desktop` v1.24012.9, an Electron Forge + Vite
build) from its unpacked `app.asar` under a stock Electron runtime, with the proxy
wired into the agent layer and a settings GUI over the launcher's config.

Useful if you want the desktop UI rather than the terminal, or if you want to see how
the app is put together. **Not required for part 1.**

### Supplying the bundle

`app/` **is** committed in this repository — 171 files of Anthropic's code — and that is
exactly why it is private and must not be published. Treat that directory as somebody
else's software that happens to be sitting here.

To build it yourself instead, from your own licensed install:

1. Find `app.asar` in your Claude Desktop installation
   (macOS: `/Applications/Claude.app/Contents/Resources/`).
2. `npx @electron/asar extract app.asar app/`
3. Merge the sibling `app.asar.unpacked/` back in at the same relative paths — the
   native addons (`@ant/claude-native`, `@ant/claude-swift`, `node-pty`, the office365
   `msal` binaries) live there, and the app expects them beside their JS.

The version here is `@ant/desktop` v1.24012.9; a different version will not necessarily
match the twelve env-gated patches, all of which are keyed to strings in this build.

### Setup

```bash
npm install        # stock Electron 43.2.0, ~200 MB, once
./run.sh
```

A window opens on the `claude.ai` login screen; sign in as usual. `Cmd+Q` quits.
`run.sh` re-creates the `Resources/app.asar → app/` symlink and the `disclaimer` shim
on every launch, so reinstalling `node_modules` costs nothing.

Requirements: macOS (see [LINUX.md](LINUX.md) for what a port needs) and Node ≥ 22 —
the app itself refuses to start below Electron 34 and needs Node ≥ 22. Developed against
Node 26; there is no `engines` field, so older versions are untested rather than blocked.

### Settings GUI

```bash
./settings.sh
```

Every parameter, grouped, each with the reasoning behind it, plus live status (app up,
proxy up, model, tokens used) and **Save & restart**, since most settings are read at
launch.

It is a local page rather than an Electron window for a concrete reason: the
`Resources/app.asar → app/` symlink makes Electron load *Anthropic's* app and ignore
any CLI-supplied app path — verified with both `electron settings` and
`electron --app=settings`, which each booted `appVersion 1.24012.9`. The server binds
to `127.0.0.1` and requires a per-start token, because the API writes config and can
restart the app; without a token any page you visited could POST to it. Writes are
surgical — one `KEY=value` line changes and the surrounding documentation comments are
left byte-identical.

### Choosing the provider

```bash
./run-openai.sh       # OpenAI, via the local translation proxy
./run-anthropic.sh    # Claude, calling Anthropic directly (stock behaviour)
./run.sh              # whichever .provider says (default: openai)
```

| | `anthropic` | `openai` |
|---|---|---|
| agent's `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | `http://127.0.0.1:8123` |
| translation proxy | not started | started, health-checked |
| `.openai-model` `CLAUDE_CODE_*` settings | not applied | applied |
| model | Claude, as shipped | `gpt-5.3-codex` |

Switching back needs **no un-patching**: every edit to the bundle is env-gated
(`PROXY_ANTHROPIC_BASE_URL || <original host>`), so with the variable unset the app uses
its own Anthropic host. Anthropic mode also actively drops
`CLAUDE_CODE_BG_CLASSIFIER_MODEL` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`,
because those hold OpenAI model ids and sending `gpt-4.1-mini` to Anthropic just errors.

Maximum reasoning is the default either way, through two different knobs: the proxy's
`OPENAI_REASONING_EFFORT` on the OpenAI path, and `CLAUDE_CODE_EFFORT_LEVEL=max` plus
`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` exported by `run.sh` on the Anthropic path.
`MAX_THINKING_TOKENS` is deliberately unused — the CLI's own migration notes call
`thinking.budget_tokens` deprecated in favour of adaptive thinking.

Either way this affects only the **agent**. The chat window is the remote claude.ai web
app talking to Anthropic in both modes.

### Launcher configuration

Four dot files, all read by `run.sh`, each overridable by an env var of the same name.
None contains a secret.

| File | Setting | Default | Effect |
|---|---|---|---|
| [`.provider`](.provider) | `PROVIDER` | `openai` | `openai` = agent via the proxy; `anthropic` = agent calls Anthropic directly with Claude |
| [`.openai-model`](.openai-model) | `OPENAI_MODEL` and friends | `gpt-5.3-codex` | Everything in the proxy table above |
| [`.privacy`](.privacy) | `DISABLE_TELEMETRY` | `1` | Turns off first-party telemetry and Sentry, and sinkholes the analytics hosts |
| [`.sync`](.sync) | `SYNC_CLAUDE_SESSIONS` | `1` | Copies Claude Desktop's session list into this build's isolated profile on launch |

`user-data/` is an isolated profile: this build never writes to your real Claude
install's data. It does *read* from it, to copy sessions in.

The app runs unpackaged (`app.isPackaged === false`), which is its own dev layout.

### What works, and what cannot

**Works:** launches and stays up, renders the real Claude web UI, native addons load,
the desktop↔web IPC bridge is valid on the `claude.ai` origin, the agent runs on
OpenAI through the proxy.

**Cannot work outside the signed bundle** — auto-update, `claude://` deep links, and
anything gated on macOS entitlements the stock Electron binary does not carry (the
VM/"virtualization" features, which the app itself reports as unavailable).
`--remote-debugging-port` is refused by the app's own signed CDP gate.

**Scheduled tasks and wake scheduling do not work**, and the app says so:
`[wake-scheduler] DEV BUILD — daemon registration will fail`. Anything needing the
machine woken on a timer is inert. Everything interactive is unaffected.

### Startup noise that is not a problem

Three alarming lines appear on **every** launch, including healthy ones:

```
[error] Failed to handle pending folder: Error: Timed out waiting for mainView to become ready
ERROR:network_service_instance_impl.cc:721] Network service crashed or was terminated, restarting service.
CONSOLE "getInitialLocale failed ... did not pass origin validation"
```

The first two are startup races; the app carries on and logs in. The third is origin
validation working as designed — Electron loads the app through the `app.asar`
symlink, so the shell renderer's `file://` URL is not the one the validator expects,
and the locale falls back. `net::ERR_FAILED` on the bootstrap fetch is downstream of
the network-service restart, not a connectivity problem.

To tell whether a launch actually succeeded, grep for both of these:

```bash
grep -c "isLoggedOut: false" boot.log; grep -c "my-access] loaded" boot.log
```

Also expect `MISSING_TRANSLATION` warnings (the `resources/i18n` files were not in the
asar) and a one-off "Shell environment extraction timed out (attempt 1/5)".

### Reset

Delete `user-data/`.

---

## Documentation

| Document | What's in it |
|---|---|
| [openai-proxy/README.md](openai-proxy/README.md) | The proxy in depth: every knob, every behaviour fix and the bug that motivated it, the classifier measurements, the compaction ladder |
| [SESSIONS.md](SESSIONS.md) | How the desktop build relates to your real Claude install: shared memory, session sync, and why grouping behaves as it does |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the desktop app is built: which UI is local vs. remote, the IPC bridge the remote page uses to drive your machine, which layers can be modified |
| [ANTHROPIC_ENDPOINTS.md](ANTHROPIC_ENDPOINTS.md) | Every Anthropic endpoint the app calls, with payloads and what each is for |
| [FINDINGS.md](FINDINGS.md) | Notable things in the bundle — permission modes, the extension registry, companion-hardware pairing, the auto-approved tool list |
| [LINUX.md](LINUX.md) | What a Linux port would take, with the native-module and folded-conditional blockers |

## Contributing back

The proxy is self-contained (`openai-proxy/`, plus `settings/` for the GUI) and
carries no Anthropic code, so it can be developed and shared independently of the
bundle. If you extend it, add a test naming the behaviour you fixed — that is the
convention throughout, and it is what caught several regressions in the fixes
themselves.
