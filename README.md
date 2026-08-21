# Run Claude's agent tooling on OpenAI, a local GPU model, or Anthropic

Claude Code and Claude Desktop are good agent harnesses. This repo lets you drive their
**agent layer** with a backend of your choice — an **OpenAI** key, an **on-device model on your
own GPU**, or stock **Anthropic** — by translating between the Anthropic and OpenAI APIs
locally. The chat window is always the real claude.ai web app; only the agent sub-layer
(Claude Code) is repointed.

Two independent things live here, and **you may only want the first**:

| | What it is | What you need |
|---|---|---|
| **1. The proxy** — [`openai-proxy/`](openai-proxy/) | A local server that speaks the **Anthropic Messages API** on the front and calls **OpenAI** (or any OpenAI-compatible server) on the back. Point any Anthropic-API client at it. | Node 22+ (native `fetch`), and an OpenAI key **or** a local server like Ollama |
| **2. The desktop build** | Anthropic's **Claude Desktop** app, unpacked and run under a stock Electron runtime, with the proxy wired in, a provider switch, and a settings GUI | Linux or macOS, plus **your own copy** of Claude Desktop |

The proxy is the generally useful part: it works with the ordinary `claude` CLI on any machine,
and needs nothing from this repo's `app/` directory. Everything below the
[Desktop build](#2-the-desktop-build) heading is specific to running Anthropic's Electron app.

> **Licensing, read this first.** `app/` is Anthropic's unpacked proprietary bundle (~40 MB of
> their JavaScript, native binaries and resources). It is **not** redistributable, which is why
> this repository is private. For part 2 you must supply that directory from your own licensed
> Claude Desktop install — see [Supplying the bundle](#supplying-the-bundle). Nothing in part 1
> touches it.

---

## 1. The proxy — Claude Code on OpenAI (or a local model)

### Quick start

```bash
export OPENAI_API_KEY=sk-...              # or point at a local server; see below
cd openai-proxy && node supervise.mjs     # listens on 127.0.0.1:8123, restarts on crash
```

`node proxy.mjs` still works and is right for a one-off. Prefer the supervisor for anything you
leave running: the proxy has taken itself down on a dropped upstream socket with nothing
noticing for hours — the app, the launcher and every agent kept running against a closed port.
The supervisor restarts it, logs why, and gives up loudly rather than looping if it cannot start.

Point the stock Claude Code CLI at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8123 ANTHROPIC_API_KEY=unused claude -p "hello"
```

`ANTHROPIC_API_KEY` must be set to *something* because the CLI insists on it, but the proxy
ignores it and authenticates to OpenAI with `OPENAI_API_KEY`.

Verified end-to-end with the unmodified CLI: a full agent turn, 221 tools, tool calls executed
and results fed back, with the proxy log showing `model=claude-opus-4-8->gpt-5.6-sol`. The CLI
still *says* "Opus" because it hardcodes that in its own prompt; the proxy log and the
`ANTHROPIC_BASE_URL` in the process environment are the ground truth.

### Point it at a local, on-device model

Set `OPENAI_BASE_URL` at any OpenAI-compatible server ([Ollama](https://ollama.com),
llama.cpp, LM Studio, vLLM) and the proxy translates to it exactly as it does to OpenAI. A
**loopback** base URL is treated as **keyless** — no `OPENAI_API_KEY` needed (a placeholder
bearer is sent, which local servers ignore):

```bash
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_MODEL=qwen2.5:7b-instruct OPENAI_API=chat \
  node openai-proxy/proxy.mjs
```

The desktop build wires this up as the [`local` provider](#on-device-model-local), which also
starts and tunes Ollama for you.

### Configuration

Everything has a default; set only what you want to change.

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for a remote endpoint; **optional for a loopback one**. Also read from `.openai-key` (see below). |
| `OPENAI_MODEL` | `gpt-5.6-sol` | Any model id. Names containing `codex` route to **Responses** automatically; anything else lands on Chat Completions unless `OPENAI_API=responses` is set. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint, including a local one. |
| `PORT` | `8123` | |
| `OPENAI_API` | `responses` | `responses` or `chat`, overriding the name heuristic. **Required for a non-codex remote model**: this app sends 200+ tools and Chat Completions caps at 128. |
| `OPENAI_REASONING_EFFORT` | `max` | The proxy steps down to the highest value your model accepts. |
| `OPENAI_CLASSIFIER_SAFETY_MODEL` | `gpt-5.4-2026-03-05` | Model for Claude Code's auto-mode safety verdict. It has a 60-second deadline and **denies the action** when it expires, so this wants a fast model — see [openai-proxy/README.md](openai-proxy/README.md) for the measurements. |

The full list — around thirty knobs, each documented with the bug that motivated it — is in
[openai-proxy/README.md](openai-proxy/README.md).

Instead of environment variables, put `KEY=VALUE` lines in `.openai-model` at the repo root
(checked in, for non-secrets). The secret **API key** goes in its own gitignored file,
**`.openai-key`** (`apiKey=…`; copy `.openai-key.example` to start). Precedence is
env var → `.openai-model` → `.openai-key` → default.

That precedence lives in exactly one place, [`openai-proxy/config.mjs`](openai-proxy/config.mjs),
which also produces the config hash below. To see what a launch would actually use:

```bash
node openai-proxy/config.mjs            # the effective config, with the source of each value
```

`--hash` prints just the config hash; `--validate` checks it and exits non-zero on an error. The
key never appears in any of them — only a `sha256:` fingerprint of it.

### Knowing which proxy is running

`/health` reports an identity, not just liveness:

```json
{ "ok": true, "instance": "8f3c…", "pid": 82110, "configHash": "38d9c8b2…",
  "codeVersion": "a8e08f01…", "inflight": 0, "model": "gpt-5.6-sol", "…": "…" }
```

- **`instance`** is a nonce generated at startup and also written to `proxy-runtime.json`. Only
  the process that generated it can serve it, so matching both proves ownership — which is what
  lets the launcher restart *its* proxy and refuse to touch anything else.
- **`configHash`** covers every behaviour-affecting setting plus a fingerprint of the key. The
  launcher compares it and restarts a proxy serving stale settings, instead of the old behaviour
  where any answer on `/health` counted as healthy and a changed model silently did not apply.
- **`codeVersion`** is a hash of the proxy sources, catching a process running older translation
  logic with current settings.
- **`inflight`** is how many turns are being answered right now, so a restart can say what it
  would interrupt.

Supervisor behaviour is tuned by environment variable; the defaults are meant to be left alone.
`PROXY_MAX_FAST_FAILURES` (8) bounds immediate restart attempts, `PROXY_RESTART_BASE_MS` (500)
and `PROXY_RESTART_MAX_MS` (30000) set the backoff, and `PROXY_HEALTH_EVERY_MS` (15000) /
`PROXY_HEALTH_TIMEOUT_MS` (5000) / `PROXY_HEALTH_MISSES` (3) control the watchdog that replaces a
proxy holding the port without answering. An externally-killed proxy always restarts and never
counts toward the give-up bound.

### Which API surface, and why it matters

| | Chat Completions | Responses |
|---|---|---|
| Tool limit | **128** (129 → HTTP 400) | none observed — probed to 512 |
| Reasoning controls | none | `reasoning.effort`, reasoning summaries |
| Local-server support | universal | recent Ollama; not all local servers |

Claude Code offers 27 tools; Claude Desktop offers over 200. On the chat surface the 128-tool cap
is real, so the proxy keeps the essential tools (read/write/edit/run/search/plan/web, plus
renderers) and fills the remainder in the agent's own order, logging what it dropped — a silently
truncated tool list is indistinguishable from a model that just declined to use a tool.

### What the translation covers

Text and tool calls in both directions, streaming and non-streaming, plus fixes for behaviour
differences between the two model families:

- **Rendering** — GPT models emit `\(…\)` / `\[…\]` for maths, which Claude's renderer shows
  literally. Rewritten to `$…$` / `$$…$$`, fence-aware so code samples stay verbatim.
- **Persistence** — GPT models routinely end a turn to check in ("If you want, I'll run that
  now"), which in an agent loop reads as a stall. An explicit persistence directive plus
  auto-continue when a turn announces an action and calls no tool.
- **Context overflow** — Claude Code sizes its own auto-compaction from the model it *thinks* it
  is talking to, so it never fires. The proxy compacts and retries, including when the overflow
  arrives as a mid-stream event rather than an HTTP 400.
- **Empty and truncated turns** — retried or resumed rather than surfaced as a blank reply.
- **Unsupported parameters** — the CLI sends `stop_sequences`, which some models reject. The
  proxy drops whichever parameter the API names and retries, so the next unsupported knob
  self-heals too.
- **Thinking** — OpenAI reasoning *summaries* are mapped to Anthropic thinking blocks. Raw
  chain-of-thought is not available from the API at any setting.

**Images work.** Anthropic `{type:"image", source:{…}}` blocks — base64 or url — become
`image_url` on Chat Completions and `input_image` on Responses. If the model has no vision the
picture is dropped and the question kept, with an honest note in its place, rather than failing
the turn.

Known gaps: `/v1/messages/count_tokens` is estimated, and the cost figures the CLI prints are
computed from Anthropic's price list and are meaningless when proxied.

### Evaluation baseline

```bash
npm run eval           # run the corpus, diff against the frozen baseline
npm run eval:freeze    # overwrite the baseline with what the code does NOW
```

`eval/` holds a synthetic, **network-free** corpus. Each case runs through the real proxy against
a fake upstream, and what gets recorded is the payload the proxy **decided** to send: resolved
model, tool count, whether a late tool survived, `tool_choice`, hint injection, reasoning,
verbosity, output cap, cache key, pricing tier. Every one of those decisions is settled before a
token is generated, which is what makes it a baseline rather than a sample. `npm test` checks the
frozen baseline on every run, so a behaviour change cannot arrive unnoticed inside an unrelated
commit. Alongside it are invariants the baseline is **not allowed to encode away** — a classifier
is never given tools, a safety verdict never resolves to the main model, an agent turn that
merely quotes the classifier contract keeps its full catalogue.

### Tests

```bash
npm test        # the whole suite: proxy + settings + launcher scripts + eval baseline
```

Most were written against a specific misbehaviour; the comments say which.

---

## 2. The desktop build

Runs Anthropic's Claude Desktop (`@ant/desktop` v1.24012.9, an Electron Forge + Vite build) from
its unpacked `app.asar` under a stock Electron runtime, with the proxy wired into the agent
layer, a provider switch, and a settings GUI over the launcher's config. Runs on **Linux and
macOS**.

### Supplying the bundle

`app/` **is** committed in this repository — Anthropic's code — and that is exactly why it is
private and must not be published. `node_modules/` and `app/node_modules/` are **not** committed;
you populate them from your own licensed install.

To rebuild `app/` from your own install:

1. Find `app.asar` in your Claude Desktop installation:
   - **Linux:** `/usr/lib/claude-desktop/resources/`
   - **macOS:** `/Applications/Claude.app/Contents/Resources/`
2. `npx @electron/asar extract app.asar app/`
3. Merge the sibling `app.asar.unpacked/node_modules/` back in over `app/node_modules/` — the
   native addons (`@ant/claude-native`, `node-pty`, and on macOS `@ant/claude-swift`) live there
   as platform binaries and the app expects them beside their JS. On Linux, `@ant/claude-swift`
   is absent by design and fails closed.

The version here is `@ant/desktop` v1.24012.9; a different version will not necessarily match the
env-gated patches, which are keyed to strings in this build.

### Setup

```bash
npm install        # stock Electron 42.9.2, once
./run.sh
```

Electron **42.9.2** is pinned to match the native modules harvested from a current Claude Desktop
install. A window opens on the `claude.ai` login screen; sign in as usual. `run.sh` re-creates the
`resources/app.asar → app/` symlink and reinstalls the `disclaimer` helper on every launch, so
reinstalling `node_modules` costs nothing.

**Linux note:** `npm install` downloads the Electron binary from GitHub's release CDN. If that host
is blocked on your network, use a mirror:

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ \
  ELECTRON_CUSTOM_DIR="v{{ version }}" node node_modules/electron/install.js
```

`run.sh` is cross-platform (`uname -s`): it resolves the Electron resources dir (`dist/resources`
on Linux, `Electron.app/Contents/Resources` on macOS), the Claude Desktop profile
(`~/.config/Claude` vs `~/Library/Application Support/Claude`), and the `disclaimer` helper path
per platform. See [LINUX.md](LINUX.md) for the port's design and the folded-conditional gotchas.

On modern Ubuntu (`kernel.apparmor_restrict_unprivileged_userns=1`) Electron's namespace sandbox is
blocked, so it needs a **setuid-root `chrome-sandbox`** — which the downloaded Electron isn't. `run.sh`
self-heals this by symlinking to the setuid-root `chrome-sandbox` the Claude Desktop `.deb` already
installed (same Electron build, byte-identical), keeping the renderer sandbox **on with no `sudo`**. If
no system copy matches, it prints the one-time `sudo chown root:root … && sudo chmod 4755 …` fix.

### The disclaimer helper

Stock Electron has no equivalent of Claude Desktop's TCC-attribution helper, and the app invokes
it as `disclaimer <command> <args…>` — which makes it the one supported boundary at which this
repo can choose the agent's *internal* model identity. The helper is repository-owned source
([scripts/claude-code-disclaimer.sh](scripts/claude-code-disclaimer.sh)), installed as an absolute
symlink by [scripts/install-disclaimer.mjs](scripts/install-disclaimer.mjs) at the per-platform
`Helpers/` path. In OpenAI/local mode it rewrites the bundled Claude Code executable to the
configured `[1m]` capability identity; in Anthropic mode it is an exact argv passthrough. It also
exports `CLAUDE_CODE_SUBAGENT_MODEL` so `Task`/`Explore`/teammate spawns — which run inside the
session process and have no argv to rewrite — get the right model. Nothing patches the Claude Code
binary or the app bundle.

### Requirements

Linux or macOS, and Node ≥ 22 (Electron 42 bundles its own Node for the app itself). The app
refuses to start below Electron 34.

### Settings GUI

```bash
./settings.sh
```

Every parameter, grouped, each with the reasoning behind it, plus live status and **Save &
restart**. The status line separates **configured** from **active**: a proxy serving previous
settings is labelled `STALE — restart to apply`; a launch-time `OPENAI_MODEL=x ./run.sh` override
is shown as an override; and in Anthropic mode the OpenAI-only settings are dimmed as not in
effect. **Save & restart** stops the app (it holds an exclusive LevelDB lock on the session
store), waits for exit, stops the proxy *only if it can prove the proxy is ours*, relaunches, and
confirms the new proxy reports the expected config hash before reporting success. It is a local
`127.0.0.1` page requiring a per-start token, because the API writes config and can restart the
app.

### Choosing the provider

Two modes: **`anthropic`** (Claude, direct) or **`proxy`** (via the local translation proxy). In
proxy mode a single **`DEFAULT_PROVIDER`** (in [`.provider`](.provider)) picks the upstream that
backs the default turns, the background classifier and compaction — one of `openai`, `local`
(on-device Ollama), `openrouter`, `cohere`, `gemini` — and any *individual* turn can run on a
different provider by picking a `<provider>:<model>` from the Code-tab model dropdown (the proxy
routes that turn to the named provider's key in `.openai-key`).

```bash
./run-proxy.sh        # via the local translation proxy — upstream = DEFAULT_PROVIDER in .provider
./run-anthropic.sh    # Claude, calling Anthropic directly (stock behaviour)
./run.sh              # whichever .provider says (default: proxy, upstream openai)
```

An old `PROVIDER=openai|local|openrouter|cohere|gemini` (in `.provider` or on the command line)
still works — it selects proxy mode with that provider as the default upstream.

| | `anthropic` | `proxy` |
|---|---|---|
| agent's `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | `http://127.0.0.1:8123` |
| translation proxy | not started | started, health-checked |
| backend the proxy calls | — | the `DEFAULT_PROVIDER` upstream (OpenAI / on-device Ollama / OpenRouter / Cohere / Gemini), plus any provider picked per-turn |
| API key | your Anthropic login | per upstream — `.openai-key` (remote) or none (loopback Ollama) |
| model | Claude, as shipped | the upstream's model, or a `<provider>:<model>` chosen in the dropdown |

Switching needs **no un-patching**: every edit to the bundle is env-gated
(`PROXY_ANTHROPIC_BASE_URL || <original host>`), so with the variable unset the app uses its own
Anthropic host. This affects only the **agent** — the chat window is the remote claude.ai web app
talking to Anthropic in every mode.

#### On-device model (`local`)

`DEFAULT_PROVIDER=local` points the proxy at a local OpenAI-compatible server instead of
api.openai.com, so the agent runs on **this machine's GPU** with no API key. It uses
[Ollama](https://ollama.com), configured in [`.local-model`](.local-model). The Code-tab dropdown
also lists your installed Ollama *thinking* models as `local:<model>` (discovered at launch), so
you can run a single turn on-device from any mode.

**It manages Ollama for you.** The agent's prompt (system + up to 128 tools) is large, and a
system Ollama is usually pinned to a small context by its service unit — which would silently
truncate that prompt, and can't be rebound without root. So `run.sh` starts its **own** Ollama on
a side port (`OLLAMA_MANAGED_PORT`, default 11435) with a big context, sharing the models you
already pulled, and leaves the system Ollama untouched for its other clients. It reuses that
instance across launches and restarts it only when the context changes. The GPU tuning that makes
a big context fit a laptop card is applied automatically: **`q8_0` KV cache** (≈half the VRAM of
`f16`), **flash attention**, and **`OLLAMA_NUM_PARALLEL=1`** so the *full* context goes to the
single agent request instead of being split across slots. Set `OLLAMA_AUTOSTART=0` to manage the
server yourself.

- **Context is per model.** `OLLAMA_CONTEXT_LENGTH` is the default; `CONTEXT_<model>` overrides it
  per model (a bigger native window can take more; a large model needs less to fit VRAM). The
  compaction window follows automatically — `run.sh` derives `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as
  3/4 of the context in effect, so switching models keeps a sane window (override per model with
  `COMPACT_<model>`, or globally with an explicit `CLAUDE_CODE_AUTO_COMPACT_WINDOW`).
- **A tool-calling model is required.** The agent is tool calls end to end, so the model must emit
  proper OpenAI `tool_calls`, not dump them as text. `qwen2.5:7b-instruct` (32K), `qwen3:8b` (40K)
  and `granite4.1:8b` (128K) do; `qwen2.5-coder:7b` does not. Pull it first (`ollama pull <model>`).

`local` speaks Chat Completions by default (universal across local servers; its 128-tool cap also
helps a small model fit context). A 7-8B model on a laptop GPU is far less capable than the hosted
models — this is for privacy/offline use, not maximum quality.

### Launcher configuration

Dot files at the repo root, all read by `run.sh` (or the proxy), each overridable by an env var of
the same name.

| File | Setting | Default | Effect |
|---|---|---|---|
| [`.provider`](.provider) | `PROVIDER` | `openai` | `openai` = agent via the proxy to api.openai.com; `local` = proxy → on-device GPU model; `anthropic` = agent calls Anthropic directly |
| [`.openai-model`](.openai-model) | `OPENAI_MODEL` and friends | `gpt-5.6-sol` | Everything in the proxy config table above, for `openai` mode |
| [`.local-model`](.local-model) | `OPENAI_MODEL`, context, Ollama tuning | Ollama `qwen2.5:7b-instruct` | The local server, model, per-model context and GPU tuning for `local` mode |
| `.openai-key` *(gitignored)* | `apiKey` | — | The secret OpenAI key for `openai` mode. Not read in `local`/`anthropic`. Copy [`.openai-key.example`](.openai-key.example) to start |
| [`.privacy`](.privacy) | `DISABLE_TELEMETRY` | `1` | Turns off first-party telemetry and Sentry, and sinkholes the analytics hosts |
| [`.sync`](.sync) | `SYNC_CLAUDE_SESSIONS`, `SYNC_CLAUDE_GROUPING` | `1` | Shares Claude Desktop's sessions and sidebar grouping with this build |

`user-data/` is an isolated profile with **one deliberate exception**: `claude-code-sessions` is a
symlink to the real install's store, so sessions are genuinely shared and written in both
directions ([issue #3]). A session created or renamed in either app is immediately the other's —
and deleting one deletes it for both. Everything else in `user-data/` (cookies, caches, Local
Storage) stays private to this build. Local Storage deliberately is **not** shared: LevelDB
permits one process at a time, so a shared directory would stop the second app from opening its
own UI state.

[issue #3]: https://github.com/mkornreich/llm-desktop-electron/issues/3

The app runs unpackaged (`app.isPackaged === false`).

### What works, and what cannot

**Works:** launches and stays up on Linux and macOS, renders the real Claude web UI, native addons
load, the desktop↔web IPC bridge is valid on the `claude.ai` origin, the agent runs through the
proxy on OpenAI or a local GPU model, telemetry is off (the `isolated-segment` beacon shows
`ERR_BLOCKED_BY_CLIENT`), and sessions sync with the real install.

**Cannot work outside the signed bundle** — auto-update, `claude://` deep links, and anything
gated on macOS entitlements the stock Electron binary does not carry (the VM/"virtualization"
features, which the app reports as unavailable). On Linux the macOS-only pieces (global hotkeys,
memory-pressure telemetry from `@ant/claude-swift`, computer-use frame streaming) are absent by
design and fail closed; the launcher polyfills the few macOS-only Electron APIs the bundle calls
unconditionally at startup so it boots cleanly.

### Startup noise that is not a problem

Alarming lines appear on **every** launch, including healthy ones — startup races, an
`@ant/claude-swift`/office365 `ERR_MODULE_NOT_FOUND` (macOS-only modules, fail closed), Wayland
binding warnings, and `MISSING_TRANSLATION` / "Cowork not supported" notices. To tell whether a
launch actually succeeded, grep for these:

```bash
grep -c "isLoggedOut: false" boot.log      # signed in
grep -c "loaded .* features" boot.log       # feature flags fetched
```

### Reset

Delete `user-data/`.

---

## Documentation

| Document | What's in it |
|---|---|
| [openai-proxy/README.md](openai-proxy/README.md) | The proxy in depth: every knob, every behaviour fix and the bug that motivated it, the classifier measurements, the compaction ladder |
| [SESSIONS.md](SESSIONS.md) | How the desktop build relates to your real Claude install: shared memory, session sync, and why grouping behaves as it does |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the desktop app is built: which UI is local vs. remote, the IPC bridge the remote page uses, which layers can be modified |
| [ANTHROPIC_ENDPOINTS.md](ANTHROPIC_ENDPOINTS.md) | Every Anthropic endpoint the app calls, with payloads and what each is for |
| [FINDINGS.md](FINDINGS.md) | Notable things in the bundle — permission modes, the extension registry, companion-hardware pairing, the auto-approved tool list |
| [LINUX.md](LINUX.md) | The Linux port: native-module harvest, folded-conditional blockers, and what degrades off macOS |

## Contributing back

The proxy is self-contained (`openai-proxy/`, plus `settings/` for the GUI) and carries no
Anthropic code, so it can be developed and shared independently of the bundle. If you extend it,
add a test naming the behaviour you fixed — that is the convention throughout, and it is what
caught several regressions in the fixes themselves.
