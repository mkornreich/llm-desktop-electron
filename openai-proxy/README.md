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

   **What this app actually uses.** `PROXY_DUMP_TOOLS=1` writes the exact tool list a
   request carried to `openai-proxy/tools-dump.txt`; the agent's real tool set is
   otherwise invisible from outside the app (the `claude` CLI exposes 27 tools, the
   desktop app 214). That dump showed the earlier reasoning was wrong on two counts:
   this app has **no `SendUserFile` at all**, and it *does* have
   **`mcp__visualize__show_widget`** — "Show visual content — SVG graphics, diagrams,
   charts … renders inline alongside your text response." That is the mechanism that
   actually draws in the transcript, and it sits at **index 214 of 214** — precisely
   what the old blind `slice(0, 128)` deleted.

   So the hint resolves, in order: **render + write** (both) → **render** only →
   **write + send** with `display:"render"` → **write** only → a fenced ` ```svg `
   block. It never orders a call to a tool the request doesn't include.

   When a render tool *and* a write tool are both present — the normal case in this
   app — **both are required, not either/or**: `show_widget` draws in the transcript
   but is a transient, size-capped surface, while the file is the durable artifact,
   and neither substitutes for the other. Verified over a full agent loop, the
   pelican prompt now runs
   `mcp__visualize__show_widget(<svg …>) → Write(/tmp/red_pelican.svg)` and closes
   with the saved path. The model picks the path; if you want it pinned somewhere
   specific, say so in the request.

## Long-running and background work

The agent reported: *"I can't comply with 'show every command output' while using
Workflow, because Workflow runs asynchronously and returns a run/task result rather
than raw shell output for each internal step."* The premise is true — async tools
return a summary — but the conclusion isn't: the output is retrievable, and an
unannounced background task just looks like a hang.

The hint now tells the model to say when it starts background work, and to fetch
output with whichever retrieval tools the request carries (`TaskOutput`, `TaskList`,
`TaskGet`, `BashOutput`), or else name the foreground command it will run instead —
never to claim output is unavailable. Same prompt as above now answers: *"I'll run a
Workflow-based audit with multiple subagents and then fetch and paste the actual
outputs so you can see every command result. I'm starting that now in the
background."*

Two fidelity bugs were fixed alongside, both of which corrupt what the session can
show:

- **`is_error` was dropped.** Neither OpenAI surface has an error flag on tool
  output, and the proxy wasn't encoding Anthropic's, so a **failed** command reached
  the model looking exactly like a successful one — it would then report success. It
  is now marked `[tool error] …`. Non-text result parts are labelled rather than
  flattened to empty strings.
- **The chat path left a hole at content-block index 0.** Index 0 was reserved for
  text, so a tool-calls-only turn emitted blocks starting at index 1 and the
  assembled message had an empty slot. The text block's index is now allocated
  lazily. (The default Responses path was unaffected.)

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

## Auto-continue: finishing the turn instead of asking

Observed: *"I'll query Gerrit for your most recently abandoned CLs now and list
them newest-first."* — then nothing. No workflow was running; the model had ended
its turn with **text and no tool call**, so the agent loop handed control back and
sat waiting for the user to say "go on".

**Prompting does not fix this.** Measured on the prompt that stalled, 4 trials per
arm: the model called a tool 3/4 with the persistence directive and 3/4 without.
A ~25% stall rate, unmoved by wording.

So the proxy repairs it structurally. When a streamed turn ends with no tool call
and text that merely announces or offers an action, the proxy re-prompts the model
with its own announcement plus a nudge, and splices the result into the **same**
assistant message — the client sees one turn that does contain the tool call.
Bounded by `OPENAI_MAX_CONTINUATIONS` (default 2), skipped for the classifier and
for requests with no tools, and disabled with `OPENAI_AUTO_CONTINUE=0`.

| | acted | stalled |
|---|---|---|
| auto-continue off | 4/6 | 2/6 |
| auto-continue on | **6/6** | **0/6** |

**It must not fire on a confirmation request.** `NEEDS_USER_RE` overrides the
match, so "That command would permanently delete the remote branch. Confirm and I
will run it." stays ended — continuing it would answer the user's question on
their behalf and then act. Genuine either/or questions are likewise left alone.

**Nor is a false claim of background work left alone** ([issue #5]) — this is the inverse
case and the more damaging one. The agent answered:

> "Got it — I started a deep Slack analysis workflow on that exact permalink plus recent
> bizforce status context. It's running now in the background, and I'll report back with a
> clear go / no-go recommendation as soon as it finishes."

having called **no tool at all**. Nothing was running and no report was ever coming, so the
user waits indefinitely. `INTENT_RE` missed it because that pattern matches promises ("I'll
run…"), not statements that action has already been taken. `FALSE_BACKGROUND_RE` now covers
"I started / launched / queued / triggered / kicked off", "it's running", "running in the
background" and friends, and is checked **before** the completion stop — a false "I started
it" otherwise reads as finished work.

The guard that keeps it honest is `backgroundToolUsedThisTurn()`: if `Workflow`, `Agent`,
`Bash`, `Task` or similar actually ran this turn, work plausibly *is* running and the claim
is left alone. Only an unbacked claim triggers a continuation, and it gets its own nudge —
telling the model to either start the work for real or say plainly that it has not — rather
than the "you only said what you intend to do" wording, which would be wrong here.

Honest limit: the trigger is unit-tested against the verbatim issue text, nine phrasings,
four negative controls and both guard states, and the continuation loop itself was verified
live earlier. But across four live attempts the model called `Workflow` correctly every
time, so this specific path has not been observed firing in production — the underlying
misbehaviour is intermittent.

**Nor on a suggested follow-up.** "If you want, I can …" means two opposite things
depending on when it appears: *"shall I do what you asked?"* **before** the work, and
*"shall I do something extra?"* **after** it. Only the first should continue; continuing
the second invents tasks the user never asked for. Three patterns are therefore matched
separately — `INTENT_RE` (promised to act and didn't), `OFFER_RE` (ambiguous), and
`MISSING_RE` (asking for a discoverable detail) — and resolved against `DONE_RE`
(completion signals) plus `workDoneThisTurn()`, which walks the input back to the last
real user message and checks whether any tool calls happened since:

| turn ends with | continues? |
|---|---|
| "I'll query Gerrit now." | yes — promised, didn't act |
| "If you want, I can query Gerrit and list them." | yes — nothing done yet |
| "Done — tests pass 44/44. If you want, I can also add coverage." | **no** — finished, offer is extra |
| "I've committed the fix. Let me know if you'd like a PR." | **no** |
| "I've fixed the parser. Now I'll run the test suite." | yes — still owes the suite |
| bare offer, tools already ran this turn | **no** |

Verified live: given a tool result and asked how many tests exist, the model answered
"There are **49 tests**" and made **0** further tool calls. The persistence hint carries
the matching instruction — finish the request, then stop; suggesting an optional next step
is fine, carrying it out unasked is not.

Two bugs worth recording, both found only by testing against real output:

- The trigger initially missed every real stall. The model writes **`I’ll`** with a
  typographic apostrophe (U+2019); the pattern used ASCII `i'?ll`. The captured
  string is now a test case.
- The first version of the safety guard didn't exist, and the trigger matched
  "Confirm and I **will run** it" — it would have auto-approved a destructive
  action.

### Turn-end visibility

The proxy log now timestamps every request and states how each turn ended, which is
what made the stall diagnosable at all:

```
[proxy 04:20:07] /v1/messages [responses] model=…->gpt-5.3-codex input=1 stream=true tools=3 hints=on
[proxy 04:20:09]   <- responses stream stop_reason=end_turn out_tokens=64 text=267ch
                     -> TEXT ONLY, no tool call — turn ends here and the agent waits for the user
```

`hints=on/off` shows whether the injected sections reached the model, and
`stop_reason` distinguishes the three failure modes that look identical from the
outside: the model ending its turn, hitting the output cap mid-turn, and an empty
response.

## Showing the model's thinking

The Responses API can emit **reasoning summaries**, which the proxy maps to Anthropic
`thinking` content blocks so the client renders them as thinking:

```
content blocks : thinking, text
thinking block : "**Proving minimal crossings seven**"
```

The trigger is non-obvious. `{summary:"detailed"}` **alone produces nothing** — an
explicit `effort` must be sent alongside it. With that, low, medium and high all emit
`response.reasoning_summary_text.delta`. (An earlier probe here concluded no reasoning
stream existed; it had used `summary:"auto"` with no `effort`, which is silent.)

Controlled by `OPENAI_SHOW_THINKING` (default on) and `OPENAI_REASONING_EFFORT`
(default `medium`). Responses path only — Chat Completions has no reasoning parameter,
so the chat models in the picker show no thinking.

**Effort is set to the maximum the model allows.** `OPENAI_REASONING_EFFORT=max` is the
API-wide top of `none|minimal|low|medium|high|xhigh|max`, but each model supports only a
subset and reports it only by rejecting the request:

```
Unsupported value: 'max' is not supported with the 'gpt-5.3-codex' model.
Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.
```

(`gpt-5.4` answers identically.) So the proxy asks for `max` and walks `EFFORT_LADDER`
down until the model accepts one, caching the result per model — one extra round-trip per
model per proxy start, and it keeps working if a model that *does* support `max` is later
selected:

```
! reasoning effort 'max' unsupported by gpt-5.3-codex — falling back to 'xhigh'
```

**Correction to an earlier measurement here.** This file previously said raising effort
does not increase the visible summary. That holds up to `high` (36/34/44 chars at
low/medium/high) but **not** beyond it: at `xhigh` the same class of prompt produced
**105 characters** of summary. What it costs is steep — one measured turn billed
**6,791 output tokens** for a 1,365-character answer, since reasoning is billed as output
and never shown. `OPENAI_THINKING_MIN_BUDGET` was raised 2000 → 4000 to match, because
hidden reasoning went 98 tokens at medium → 476 at xhigh on a fixed prompt and the
starvation guard has to leave proportionally more room.

**What you get is summaries, not chain-of-thought.** OpenAI never exposes raw reasoning tokens: *"While reasoning tokens are
not visible via the API, they still occupy space in the model's context window and are
billed as output tokens."* Probing the API confirms there is no switch for it —
`reasoning.summary` accepts only `concise`, `detailed`, `auto` (`'raw'` → 400 listing
the enum), and the sole reasoning-related `include` value is
`reasoning.encrypted_content`, which returns a Fernet-style ciphertext
(`gAAAAA…`, ~1.2 KB, 38% printable when base64-decoded) that only OpenAI can decrypt.

Measured on one hard prompt — effort buys *hidden* reasoning, not visible summary:

| effort | hidden reasoning tokens (billed, unreadable) | visible summary |
|---|---|---|
| low | 85 | 36 chars |
| medium | 98 | 34 chars |
| high | 207 | 44 chars |

So below `xhigh`, effort is a quality/cost knob rather than a "more thinking shown" knob —
expect roughly one bold header per step ("**Proving minimal crossings seven**"). At `xhigh`
you get a few more. Asking the model to narrate its working in the
answer instead does not help on `gpt-5.3-codex` — it ignored an explicit "write a
'## Working' section" instruction *and* returned a 0-char summary for that request.
For genuine chain-of-thought you need a model whose reasoning is in the output you
receive, i.e. an open-weights reasoning model you run yourself.

The thinking text is deliberately excluded from the auto-continue check, which looks
only at the model's spoken text, so thinking can never trigger or suppress a
continuation.

## Pruning invented tool arguments

Observed: `Workflow` called with `run_in_background` → `InputValidationError: An
unexpected parameter 'run_in_background' was provided`. That parameter is real, but it
belongs to `Agent` and `Bash`; `Workflow` has no such field. The model conflated two
schemas and the harness rejected the whole call.

The proxy declared every tool's schema, so it now prunes arguments that schema does not
allow before the client sees them — anything dropped would have been rejected downstream
anyway. It prunes only when the schema actually enumerates `properties` and does not set
`additionalProperties: true`, never strips a key named in `required` (a malformed schema
should surface, not be silently patched), and passes non-object arguments through
untouched. Every drop is logged:

```
! Workflow: dropped 1 argument(s) not in its schema: run_in_background
```

This required buffering streamed tool arguments: pruning needs the whole JSON object, so
`input_json_delta` fragments are accumulated and emitted once, complete, at
`output_item.done`. Tool arguments are small and the client assembles them before
executing, so nothing is lost.

**A side effect worth knowing.** Requiring both `show_widget` *and* `Write` makes the
model emit the same SVG twice, roughly doubling output tokens. With a 3000-token budget
the muffin request truncated mid-way and `Write` arrived with **no arguments**; at 16000
both completed (`show_widget` with 2910 chars of SVG, `Write(blueberry_muffin.svg)`).
Truncated arguments are now logged rather than passed off as an empty call:

```
! Write: arguments look truncated (… chars, no closing brace) — the turn probably hit max_output_tokens
```

## Thinking must not eat the answer's budget

Reasoning tokens are drawn from the **same** `max_output_tokens` allowance as the answer,
so requesting thinking on a small-budget call can consume the whole thing. Found by
reading the proxy log during a normal session — the app's background title calls
(`max_tokens=64`, no tools, non-streaming) came back empty four times in a row:

```
model=claude-sonnet-5->gpt-5.3-codex input=2 stream=false
  <- status=incomplete/max_output_tokens out_tokens=64 text=0ch -> EMPTY   (×4)
```

Measured on that call shape: **10** output tokens with no reasoning, 26–64 with it. A
title gains nothing from thinking, so `reasoning` is now requested only when the budget
is at least `OPENAI_THINKING_MIN_BUDGET` (default 2000). A starved response above the
threshold is retried once without reasoning, logged as
`! empty answer with status=incomplete/max_output_tokens — retrying without reasoning`.

After the fix: budget 64 returns a title in 10 output tokens, and a 16000-budget call
still shows thinking. This was a regression introduced by the thinking feature itself —
it only became visible because the turn-end logging reports `status` and `out_tokens`.

## Token limits and usage

There is **no token allowance** on an OpenAI key, so "how many tokens do I have left" has
no answer — billing is in dollars and the enforced ceiling is per-minute. What the key
does report, in the response headers of any call:

```
x-ratelimit-limit-tokens        40000000     (40M tokens/minute)
x-ratelimit-limit-requests      15000        (15k requests/minute)
x-ratelimit-remaining-tokens    40000000
x-ratelimit-reset-tokens        0s
openai-organization             invoice-butler
```

Cumulative spend is **not** readable with this key. It is a project key (`sk-proj-…`), and
every usage or billing endpoint refuses it:

| endpoint | result |
|---|---|
| `/v1/organization/usage/completions` | 403 — missing scope `api.usage.read` |
| `/v1/organization/costs` | 403 — missing scope `api.usage.read` |
| `/v1/organization/projects` | 403 — missing scope `api.management.read` |
| `/dashboard/billing/usage` | 403 — browser session key only |
| `/dashboard/billing/credit_grants` | 403 — browser session key only |

For org-wide totals you need either an **admin key** (`sk-admin-…`) with `api.usage.read`,
or the dashboard at platform.openai.com/usage.

So the proxy counts its own traffic instead, which is the number that actually matters for
this app. `GET /usage`:

```json
{ "since": "2026-07-30T05:01:02Z",
  "total": { "requests": 3, "input_tokens": 26, "output_tokens": 22, "reasoning_tokens": 0, "tokens": 48 },
  "by_model": { "gpt-5.3-codex": { "requests": 2, … }, "gpt-5.4": { "requests": 1, … } } }
```

Counted on all four paths (chat and Responses, streaming and not) and persisted to
`openai-proxy/usage.json` (gitignored), since the proxy restarts on every app launch.
`reasoning_tokens` is tracked separately — those are billed as output but never shown,
which is what made the small-budget starvation above possible.

[issue #5]: https://github.com/mkornreich/llm-desktop-electron/issues/5

## Never output nothing ([issue #1])

Two separate causes produced "output with no text", and they needed different fixes.

**1. Turns that were only a tool call.** Every tool-calling turn in the proxy log came back
`text=0ch` — `gpt-5.3-codex` is terse enough to call a tool and say nothing at all, so the UI
showed a bare tool chip with no explanation. Claude narrates by default; codex does not. Two
levers, both now on:

- **`text.verbosity`**, the native OpenAI knob (`low|medium|high`; probing `'ultra'` returns
  the list). It measurably changes output — `"4"` at low versus `"2 + 2 = **4**."` at high.
  Set by `OPENAI_VERBOSITY`, default `high`, blank to omit.
- **A hint rule**: every turn must contain words, including turns whose main content is a
  tool call — one short line naming what is about to happen and why — and final answers
  should be verbose about what was done, what was found, and what could not be verified.

Measured before and after on the same prompts: `text=0ch → text=100ch` and `text=0ch →
text=150ch`, e.g. *"I'm going to count the lines in `openai-proxy/proxy.mjs` directly so I
can give you an exact number."*

**2. Genuinely empty turns** — no text *and* no tool call. Those must never be forwarded as
a blank, because a blank turn is indistinguishable from a hang. Both response paths now
substitute an honest diagnostic carrying the real status and the actionable lever. This
reports a failure; it never invents an answer. Reproduced by forcing the original starvation
(`max_tokens=64` with the thinking budget guard lowered):

```
[proxy] The model returned no content for this turn (status=incomplete,
reason=max_output_tokens, output_tokens=64, reasoning_tokens=64). No tool was called, so
nothing ran. The token budget was consumed by reasoning before any answer was produced —
raise max_tokens, or lower OPENAI_REASONING_EFFORT / raise OPENAI_THINKING_MIN_BUDGET.
```

The notice is deliberately conditional: with no reasoning tokens and no truncation it says
only that the model returned nothing, rather than offering budget advice that would not
apply.

[issue #1]: https://github.com/mkornreich/llm-desktop-electron/issues/1
