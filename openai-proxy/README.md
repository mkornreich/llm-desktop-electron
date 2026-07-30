# Anthropic → OpenAI translation proxy

The desktop app's chat is the **remote claude.ai web app**, and its only local
model calls go through the bundled **Anthropic SDK** (the Claude Code / agent
sub-layer). This proxy speaks the **Anthropic Messages API** on the front and
calls **OpenAI Chat Completions** on the back, so pointing the agent's
`ANTHROPIC_BASE_URL` at it makes Claude Code run on OpenAI.

## Status: verified end-to-end, in-app ✅

Confirmed with the app's own Claude Code agent (not just a standalone test):

```
clamping tools 227->128 (OpenAI cap)
/v1/messages model=claude-opus-4-8->gpt-4.1 msgs=5 stream=true tools=128
/v1/messages model=claude-opus-4-8->gpt-4.1 msgs=2 stream=false
/v1/messages model=claude-opus-4-8->gpt-4.1 msgs=7 stream=true tools=128
```

A real multi-turn agent session (full 227-tool set, streaming, tool loop), zero
OpenAI errors, and the agent child's env shows
`ANTHROPIC_BASE_URL=http://127.0.0.1:8123`. The reply still *says* "Opus 4.8" —
Claude Code hardcodes that in its system prompt and requests
`model: claude-opus-4-8`, so the model just reads it back. The proxy log and the
child's env are the ground truth; both say OpenAI.

## Scope / honest limits

- **Only the Claude Code / agent sub-layer** is affected. The main chat window is
  remote claude.ai and still talks to Anthropic — unproxyable.
- **Tool caps are per API surface, and the default path now has none.** Probed
  directly: Chat Completions hard-caps `tools` at 128 (129 → 400 *array too
  long*), but the **Responses API accepted 128/129/214/256/512**. Since the
  project model (`gpt-5.3-codex`) runs on Responses, all ~214 tools are sent and
  nothing is hidden from the model. On the chat path the 128 cap is real, so the
  proxy keeps **essential** tools (read/write/edit/run/search/plan/web, plus
  artifact/widget/diagram/chart renderers) and fills the rest in the agent's own
  order — instead of the old blind `slice(0, 128)`, which dropped whatever sat
  past index 128. Dropped names are logged; a silently truncated tool list is
  indistinguishable from a model that just declined to use a tool.
  *(An earlier version of this file called the 128 cap "not fixable by changing
  models" — that was wrong: it is fixable by changing API surface.)*
- Translation covers text (streaming + non-streaming) and tool calls. Images are
  dropped (`[image omitted by proxy]`); `/v1/messages/count_tokens` is estimated.

## Output shaping: math and SVG

The chat surface is the **remote claude.ai web app** — there is no math or
markdown renderer in the local bundle to patch (`katex`/`mathjax`/`react-markdown`
all appear zero times; the only `latex` hits are MIME tables). So the only lever
is what the model emits, and GPT models default to formats this client won't
render. Two fixes, both disabled by `OPENAI_OUTPUT_FIXUPS=0`:

1. **Math delimiters are rewritten** — `\(…\)` → `$…$`, `\[…\]` → `$$…$$`. This
   runs on streamed deltas as well as whole responses, and is **fence-aware**: it
   never rewrites inside a ` ``` ` block, so code samples (including LaTeX shown
   *as* code) stay verbatim.
2. **A short format note is appended to the system prompt**, built per request from
   the tools that request actually carries. It tells the model to use `$`/`$$`, and
   — when the request includes a file-writing tool — that it **MUST call that tool
   by name** to save the image to a `.svg` path. The app maps
   `IMAGE_EXT_TO_MIME ".svg" → "image/svg+xml"` and renders `.svg` files as images,
   while inline markup in a reply has no renderer. If no write tool is present, the
   note asks for a fenced ` ```svg ` block instead — never ordering a tool call that
   isn't available. The note is **suppressed for the safety-classifier call**, which
   has its own expected output shape.

   Naming the tool is what makes this work. A generic *"write the SVG to a .svg
   file"* reads as advice, and `gpt-5.3-codex` answered "render a svg picture of a
   pelican" with raw markup plus *"Save this as `pelican.svg` and open it in a
   browser"* — narrating the action instead of performing it, even with all 214
   tools (including `Write`) available. With the imperative, tool-named form it
   calls `Write(pelican.svg)` and stops telling the user to do its job.

   **Writing the file is only half of it.** With the write-only hint the model
   produced the file and replied *"I created a red pelican SVG file here:
   red-pelican.svg — you can open/download that file directly"* — still a path to
   open, not a picture. A file is *displayed* when it is **sent** with
   `display:"render"`, so when the request also carries a file-sending tool
   (`SendUserFile`) the hint demands both steps in the same turn: write the `.svg`,
   then send it with `display:"render"`. Verified over a full agent loop (feeding
   each tool result back): the sequence is now
   `Write(/tmp/red_pelican.svg) → SendUserFile(files=[…], display="render")`.

   The hint adapts to what each request actually carries — write+send, send only,
   write only, or neither — so it never orders a call to a tool that isn't there.
   To see the exact tool list a request carried, start the proxy with
   `PROXY_DUMP_TOOLS=1`; it writes `openai-proxy/tools-dump.txt`. The agent's real
   tool set is otherwise invisible from outside the app — the `claude` CLI exposes
   27 tools, the desktop app 214.

Verified end-to-end against the live API: the model returned
`$$ x=\frac{-b\pm\sqrt{b^2-4ac}}{2a} $$` and inline `$e^{i\pi}+1=0$` with no `\(`
or `\[`, while a `python` code block kept a literal `\(not math\)` untouched. A
214-tool request with the needed tool at **index 213** was called successfully on
both paths.

### Tests

```bash
node --test openai-proxy/proxy.test.mjs
```

13 tests covering the tool selector and the delimiter rewriter. The streaming
tests are the ones that matter: they assert streamed output equals one-shot output
for **every chunk size and every single split point**, because a delimiter or a
fence can straddle any chunk boundary. That property caught two real bugs — a
chunk ending in exactly ` ``` ` had its fence marker split (inverting the
in-code/out-of-code state, so math inside code got rewritten and math outside
didn't), and `"$$"` as a `replace()` *replacement string* is an escape for a
single `$`, which silently turned display math into inline math.

## Config

- **API key** (and `maxTokens`/`temperature` defaults): `~/.dbeaver-ai-complete`
  (`KEY=VALUE`). The key is **never logged**.
- **Model** for this project: the repo-root dot file **`.openai-model`**
  (`OPENAI_MODEL=…`). Currently **`gpt-5.3-codex`** — OpenAI's SOTA coding model.
  Model-resolution precedence: `OPENAI_MODEL` env → `.openai-model` →
  `~/.dbeaver-ai-complete` `model` → `gpt-4.1`.
- **API surface:** the proxy speaks both **Chat Completions** and the **Responses
  API**. Codex models are served only via Responses, so any model whose name
  contains `codex` auto-routes there; override with `OPENAI_API=responses|chat`
  (env or `.openai-model`).
- **Model picker → OpenAI models:** with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
  (set in `.openai-model`, forwarded by `run-openai.sh`), the app discovers models
  from the proxy's `GET /v1/models` and lists them in the picker. The served list is
  `OPENAI_PICKER_MODELS` (default: `gpt-5.3-codex`, `gpt-5.4`, `gpt-4.1`,
  `gpt-4.1-mini`, `gpt-4o`). Selecting one makes the agent request that id, which the
  proxy passes straight through — a functional OpenAI chooser for the code/agent
  surface. (The remote claude.ai chat picker is separate and unaffected.)
- **Safety classifier → fast model:** Claude Code's auto-mode runs a separate,
  latency-sensitive classifier LLM call before each risky action; on the slow
  codex model it intermittently timed out and fail-closed ("`claude-opus-4-8
  temporarily unavailable`"). The proxy detects that request by its system prompt
  (*"risk levels for actions…"*) and routes it to **`OPENAI_CLASSIFIER_MODEL`**
  (default here `gpt-4.1-mini`, Chat Completions) instead of the main model. The
  main agent still uses `OPENAI_MODEL`. Per-request routing: requests naming an
  OpenAI model directly are passed through; classifier requests → classifier
  model; everything else → main model.
- The proxy auto-uses `max_completion_tokens` for `gpt-5*`/`o*` models and drops
  `temperature` if a model rejects it.
- Other env overrides: `OPENAI_BASE_URL`, `PORT`, `OPENAI_MAX_OUTPUT_TOKENS`
  (default 32768), `OPENAI_MAX_TOOLS` (default 128).

> **Model notes:** `gpt-5.3-codex` (Responses API) is the current pick — verified
> end-to-end incl. tools, streaming, and tool-result round-trips. For a
> Chat-Completions model instead, `gpt-5.4` is the best (keeps function tools +
> temperature, fast); `gpt-5.6`/reasoning variants refuse tools or non-default
> temperature. Temperature is omitted on the Responses path (codex uses default).

## Run the app on OpenAI

```bash
./run-openai.sh          # from the repo root
```

`run-openai.sh` starts the proxy and launches the app with
`PROXY_ANTHROPIC_BASE_URL` + `CLAUDE_CODE_LOCAL_BINARY` set. Then open Claude Code
in the app and use it — its traffic flows to the proxy. (Quit the real
`~/Applications/Claude.app` first so you don't confuse its identical window with
this one.)

### What had to be patched to get there

All in `app/.vite/build/index.chunk-CnWKsyE_.js` (backup `.orig`; env-gated, so
with `PROXY_ANTHROPIC_BASE_URL` unset the app behaves normally):

1. **Agent base URL, path 1** — `ANTHROPIC_BASE_URL: e.apiHost` →
   `PROXY_ANTHROPIC_BASE_URL || e.apiHost`.
2. **Agent base URL, path 2** — the app spawns the agent via a *second* path
   (`u = provider.apiHostOverride()` → `api.anthropic.com`); patched to
   `PROXY_ANTHROPIC_BASE_URL || provider.apiHostOverride()`. This was the one
   that made the difference.

Plus two non-code fixes handled by `run.sh` / `run-openai.sh`:

- **`disclaimer` shim** — the app spawns every subprocess through
  `Contents/Helpers/disclaimer` (a macOS TCC wrapper absent from stock Electron);
  `run.sh` drops in a `exec "$@"` passthrough.
- **`CLAUDE_CODE_LOCAL_BINARY`** — the app pins an un-fetchable RC Claude Code
  build; `run-openai.sh` points it at a locally-installed `claude`. (The app's
  own downloaded 2.1.219 binary also works once the disclaimer shim exists.)

## Run standalone

```bash
node openai-proxy/proxy.mjs          # http://127.0.0.1:8123
curl -s http://127.0.0.1:8123/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-opus-4-8","max_tokens":60,
       "messages":[{"role":"user","content":"hello"}]}'
```

Endpoints: `POST /v1/messages` · `POST /v1/messages/count_tokens` ·
`GET /v1/models` · `GET /health`.
