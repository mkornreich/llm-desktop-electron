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
- **OpenAI caps the tools array at 128**; the desktop agent sends ~227, so ~99
  tools are hidden from the model. Fine for most tasks, but a very tool-heavy
  request could reference a dropped tool. Not fixable by changing models.
- Translation covers text (streaming + non-streaming) and tool calls. Images are
  dropped (`[image omitted by proxy]`); `/v1/messages/count_tokens` is estimated.

## Config

- **API key** (and `maxTokens`/`temperature` defaults): `~/.dbeaver-ai-complete`
  (`KEY=VALUE`). The key is **never logged**.
- **Model** for this project: the repo-root dot file **`.openai-model`**
  (`OPENAI_MODEL=…`). Currently **`gpt-5.4`** — chosen as the best coding model
  that fully works through Chat Completions (newest gen that still supports
  function tools + temperature and stays fast). Model-resolution precedence:
  `OPENAI_MODEL` env → `.openai-model` → `~/.dbeaver-ai-complete` `model` →
  `gpt-4.1`.
- The proxy auto-uses `max_completion_tokens` for `gpt-5*`/`o*` models and drops
  `temperature` if a model rejects it.
- Other env overrides: `OPENAI_BASE_URL`, `PORT`, `OPENAI_MAX_OUTPUT_TOKENS`
  (default 32768), `OPENAI_MAX_TOOLS` (default 128).

> **Best-for-coding caveat:** OpenAI's SOTA coding models are the `*-codex` line
> (e.g. `gpt-5.3-codex`), but they're served **only** via the Responses API,
> which this Chat-Completions proxy doesn't speak. Adding a Responses-API path
> would unlock them. Among Chat-Completions models, `gpt-5.6`/reasoning variants
> refuse function tools or non-default temperature, so `gpt-5.4` is the sweet spot.

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
