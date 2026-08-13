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

## What it cost, and why the old number was wrong

The ledger counted tokens per model and nothing else. Two things were wrong with pricing it.

### The long-context tier is per request

From the gpt-5.6-sol model page:

> "Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request."

So a 300K request is not "roughly a 200K request" — every token in it, cached ones included, costs
double, and output costs half again as much. Measured over 44,571 logged turns from this app:

| | share of requests | share of input tokens |
|---|---|---|
| ≤ 272K input | 83.7% | 47.7% |
| **> 272K input** | **16.3%** | **52.3%** |

A minority of requests carry the majority of the volume. Pricing the aggregate at short-context
rates therefore understated the measured figure by **43%** — $13,250 against roughly $19,007.

And because the tier is a property of an *individual* request, an aggregate cannot be priced at all:
once totals are summed the information is gone. That is why accounting is now per attempt. The first
version of the legacy migration made exactly this mistake in the other direction — it passed the
6.15-billion-token aggregate through the per-request pricer, which duly reported "greater than
272,000" and priced the entire history at 2×, producing a $23,536 "lower bound" *above* the real
figure. Choosing the tier is now explicit at the call site and cannot be reached by accident.

### Retries were never counted

`usage` was a single variable, reassigned by each `consume()`, and the ledger read it once at the
end of the turn. So a turn that retried recorded **only its last attempt**; the parameter, image,
effort and context retries inside `callResponses` were never recorded at all. Measured: 206 such
requests across 45,442 turns — **0.5%**, so worth fixing but never the headline. The tier was.

### Two meters, deliberately not added together

| Meter | Answers | Retries |
|---|---|---|
| **attempt** | what the account was billed | included — they were charged |
| **turn** | what the client was given | excluded from input; output is stitched |

A retry does not multiply the client's context meter: the conversation did not get bigger because
the proxy asked twice.

### Rules the ledger will not break

- **Unknown is never zero.** An interrupted stream reports no usage; recording 0 would claim it was
  free. It records `unknown` and counts how often, so a total can never quietly rest on absent data.
- **A rejected request is known-zero, not unknown.** A 400 for an unsupported parameter generated no
  tokens. Conflating it with a real unknown would hide the genuine ones in a crowd.
- **An unknown model is unpriced, never estimated.** A plausible number nobody verified looks like an
  answer and cannot be corrected. The startup log warns if a configured model has no rate.
- **Reasoning is never charged twice.** OpenAI bills it inside `output_tokens`; at effort `max`
  reasoning is ~57% of output here, so adding it would inflate every agent turn.
- **Integer micro-dollars.** A total that changes with the order it was summed in is not a total.
- **The rate-table version travels with the figures**, so totals priced under different tables are
  distinguishable rather than silently mixed.

`GET /usage` reports attempts by kind, by route, per model split by tier, and a cost that says
whether it is exact. The pre-existing aggregate is carried as a labelled **floor**, never folded into
the new totals — mixing an exact figure with an estimate produces something that is neither.

## The learned compaction level belongs to a conversation

When the context overflows, the proxy walks a ladder — keep the last 96 tool results, then 48, 24, 12,
6, 2 — and remembers the level that worked so the gentle steps are not paid for repeatedly.

That memory was **one variable for the whole process**, and the comment beside it even said "for this
session", which it was not:

```js
let compactStartIndex = 0;      // shared by every session and every model
```

So whatever one conversation last needed became the starting point for every other. A session with
enormous tool results overflows and learns `keep=6`; the next session, which would have fitted
comfortably at `keep=96`, starts at 6 and discards ninety items of its transcript that it never needed
to lose. Four agents were running against this proxy concurrently while that was being investigated,
so it is a live effect rather than a hypothetical one.

It is now keyed by `(surface, model, session)`: a transcript's shape is a property of that
conversation, and a context window is a property of the model. Bounded at 500 entries. The session id
comes from the header the client already sends (`x-claude-code-session-id`), threaded through both
call paths — which also fills a gap left earlier, where the streaming path recorded provenance with a
null session.

## Continuity and native compaction: available, and not enabled

Unlike the structured-output work, the capability here is **real**. Probed directly:

```
POST /responses/compact   400  "Compaction requires either `input` items or a `previous_response_id`."
POST /responses (store)   200  id: resp_0ba4fcaf0e90483a…
```

So `/responses/compact` exists with a real contract, and server-side state via `previous_response_id`
works. Neither is turned on, for three reasons that are worth stating rather than discovering later:

1. **`store: true` means OpenAI retains the conversation.** This repository ships a privacy posture with
   telemetry disabled at three levels and *verified zero bytes of egress*. Turning on server-side
   retention of full agent transcripts is a material change to that, and not one to make silently as a
   side effect of a performance feature.
2. **The token saving is marginal here.** Requests already run at a 95.7–96% cache hit rate, so the
   prefix is nearly free as it stands. Continuity would trade a small further saving for a large new
   failure surface.
3. **That failure surface is the worst kind.** Continuity is only valid when the transcript is an exact
   append-only extension; forks, ambiguous retries, client rewrites, tool or model changes and races
   all have to fall back to stateless input. A bug in any of those conditions is cross-session
   contamination — one conversation answering with another's context — which the phase gates list first
   among the reasons to stop.

The custom trimming and summarisation ladder therefore remains the only compaction path, and it is the
one that is tested. Whether native compaction retains facts better is a measurable question, and it
belongs with the paired evaluation that owns changing defaults.

## Attachments do not disappear

Content was collected into four separate buckets — text, tool calls, tool results, images — and
re-emitted bucket by bucket. Anything matching no bucket fell out of the loop with no `else`. Verified
by translating a message and reading the output:

| Input | Old output |
|---|---|
| `[image(A), text("what is in this picture?"), image(B)]` | `[text, image(A), image(B)]` — the question moved in front of both pictures |
| a message containing one `document` (PDF) | **nothing at all** — the whole message vanished |
| `{type:"image", source:{}}` | **nothing at all** — same reason: no URL, no image, no content, message skipped |
| a `tool_result` carrying an image (what `Read` gives for a screenshot) | `[image omitted by proxy]` — labelled, but lost |
| any future block type | silently dropped |

Two entire user messages disappeared without trace. A wrong answer about a picture nobody sent is far
harder to diagnose than an answer saying the picture is missing.

`content.mjs` replaces the buckets with **one ordered pass**:

- **Order is preserved.** `[image, text, image]` stays in that order on both surfaces.
- **A PDF becomes `input_file`** with a filename, which is the documented Responses shape. Chat has no
  file part, so it gets a labelled note that names the file and the fix (`OPENAI_API=responses`) rather
  than silently sending nothing.
- **Media in a tool result** follows as a companion user message, while the text stays **paired with
  its call** — breaking that pairing makes the transcript describe something that never happened. The
  paired text says where the attachment went, so the model does not read it as unrelated.
- **Anything unrepresentable becomes a labelled note** saying what was dropped and why: an unreadable
  image, an unknown block type, a file on a surface that cannot carry one.
- **Remote URLs are never fetched.** A proxy that downloads whatever a message points at is a
  request-forgery engine aimed at the user's own network. A URL goes upstream as a URL.

Live traffic for scale: **687 requests carried images, 2,856 image parts** — this path is well used.
Documents have never appeared, but the failure mode was silent loss, and translating a documented shape
is strictly better than discarding it: if the mapping is wrong the API says so, where a drop says
nothing.

`thinking` and `redacted_thinking` blocks are still dropped — deliberately, and named in the code so
the drop is a decision rather than an accident.

One thing deliberately unchanged: the automatic image-strip retry when a model rejects vision. The plan
asks for fail-by-default with opt-in degradation, but the current behaviour already **discloses** the
omission in the reply, and zero rejections have occurred in production — so switching the default would
be a behaviour change with no evidence behind it.

## A rejection must not be allowed to change what was asked

When the upstream rejects a parameter, the proxy drops it by name and retries. That was built for a
real problem — the CLI sends `stop_sequences`, the Chat surface forwards them as `stop`, gpt-5.x
rejects it, and twelve 400s appeared in one session — and keying off the API's own `param` field means
the next unsupported knob self-heals without its own rule.

It must not go near a field that **carries meaning**. If the upstream ever answers `"param": "tools"`
(a model without function calling would), the recovery would strip the tools and retry. The turn then
succeeds as text, the agent looks like it declined to act, and the per-model memo makes it permanent
for the rest of the process — the same failure shape as every silent tool-drop already fixed here.

So a small set of fields is never dropped: `tools`, `tool_choice`, `messages`, `input`, `model`,
`instructions`, and the structured-output fields. A request that cannot be sent *with* them is a
request that cannot be honoured, and the upstream error is surfaced instead.

Matching is by **path prefix**, not by root. A root-only check let `text.format.json_schema` through —
the root `text` is not itself a contract — so a schema rejection inside a structured-output field
would have been "fixed" by deleting the field. `text.verbosity` stays droppable, because it shapes how
an answer reads rather than what it must be.

## Structured Outputs: not implemented, and why

The bundled client has the strings — `output_config`, `output_format`, `json_schema`,
`structured_output` — including the API's own error text:

> "Both output_format and output_config.format were provided. Please use only output_config.format
> (output_format is deprecated)."

But **zero of 47,000+ logged requests carried any of them**, and the proxy has no handling. So there
are no fixtures to pin, and translating `output_config.format` into `response_format` /
`text.format.json_schema` would be speculative code with no test case and no traffic — the kind that
is wrong in a way nobody discovers until it matters.

Two consequences follow honestly rather than being worked around:

- **Strict mode is not sent**, so there is no strict contract to enforce locally. Argument pruning
  therefore stays a repair rather than becoming an error. Measured: pruning fired **once** across
  47,000+ requests, dropping an invented `intent` from an MCP call — and in doing so it rescued a call
  that would otherwise have been rejected wholesale. Making it fail would cost that and buy nothing.
- **The caller's schemas are shared by reference and never written to.** That holds today and is now
  pinned by test, because a normalizer is exactly the kind of code that would mutate them — and a
  mutation there would corrupt the client's own tool definitions for the rest of the session, with the
  symptom appearing somewhere else entirely.

The structured-output fields are already in the protected set above, so if the client ever does start
sending them, the recovery cannot quietly return unstructured text against a schema someone is parsing.

## A capability belongs to a surface, not to a model

The proxy learns what a model rejects and stops sending it. That memory was keyed by **model alone**,
and it should not have been.

`gpt-5.6-sol` on Chat Completions answers:

> "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions"

while the same model on the **Responses** API supports reasoning fully. With a model-only key, one
Chat rejection taught the process that the model rejects reasoning — and every later Responses call
silently went out without it. Reasoning off, effort quietly stepped down, and nothing in the log tying
either to a rejection that happened on a different surface.

Latent today, because `OPENAI_API` pins every call to one surface. But a blank `OPENAI_API` routes
`codex` names to Responses and everything else to Chat, so one process genuinely uses both. Being
latent is not a reason to leave a wrong key in place. The memo is now keyed by `(surface, model)`, and
the recorded value is a **field path** rather than a bare name, so a nested rejection cannot suppress
a top-level field that shares its last segment.

The effort ladder is keyed the same way: a step taken because Chat rejected `max` no longer lowers
effort on Responses, where the model accepts it.

### Route target versus model ceiling

These are separate facts and used to be one:

- the **route target** is what this kind of call wants — an agent turn wants the configured effort, a
  verdict wants no reasoning parameter at all
- the **model ceiling** is what a `(surface, model)` pair has been observed to accept

Collapsing them is what made a single rejection look like a configuration change. `null` effort (send
no parameter) is also kept distinct from an effort of `"none"`, which asks for reasoning at the lowest
setting and still pays for the field.

**No default moved.** The route table reproduces the incumbent behaviour exactly: `main` and
`compaction` take the configured effort, classifiers take none. A default may change only on paired
evaluation showing zero safety or tool regression plus either a credible quality improvement or
non-inferiority with a real speed gain — and none of that evidence exists yet, so a tuned table here
would be changing behaviour on taste. The output ceilings were already aligned (`min(client max_tokens,
OPENAI_MAX_OUTPUT_TOKENS)` on both surfaces, with validation warning when the cumulative turn ceiling
sits below the single-call cap), and nothing advertises 128K, so there is no oversized reservation to
shrink.

## What the model is shown, per route

Exposure decides what the model **sees**. It never decides what may **execute** — that is Claude
Code's `allowedTools`, and hiding or showing a tool cannot move it. A call still goes back to the
client, which still applies its own permissions.

| Route | Tools sent | Calls possible | Why |
|---|---|---|---|
| `main` | all | yes | an agent turn needs its tools |
| `compaction` | **all** | **no** | see below — the obvious fix was wrong |
| `prefix` | none | — | a verdict has no use for a tool |
| `safety:severity` / `safety:block` | none | — | as above |

### The compaction case, where measurement overturned the plan

A compaction request asks the model to summarise a transcript; the answer must be prose. Measured in
this app's own logs: **224 of 318** client compaction requests carried tools, ~115k tokens of schemas
each, **~25.8M tokens** in total attached to requests that must not call anything.

The obvious fix is to drop the tools. That would have cost more than it saved. Those same requests run
at a **95.7% cache hit rate** (39.3M of 41.1M input tokens served from cache; 299 of 300 above 50%),
and tools sit *before* messages in the prompt prefix — so removing them invalidates everything after.
Roughly **$177 of extra spend to avoid ~$13** of cached schema tokens.

So the tools stay and `tool_choice: "none"` makes a call impossible. Probed directly against the API
to confirm that parameter is not part of the cache key:

```
1 prime            input=4055 cached=0
2 same again       input=4055 cached=4052
3 + tool_choice    input=4055 cached=3980     <- still cached
4 tool_choice agn  input=4055 cached=3980
5 back to no tc    input=4055 cached=4052
```

98.2% retained; the 72-token gap is cache-block granularity, not a miss. Same guarantee, no bill.

### Two bugs the policy closed

**`tool_choice` could name a tool that was not sent.** On the Chat surface the 128-tool cap drops
tools, and `tool_choice` was translated independently of it. Verified against the live encoder: 200
tools in, 128 sent, and `tool_choice: {name: "zz_dropped_199"}` on the wire — which the API rejects,
with an error naming the parameter rather than the cap that caused it. It is now resolved against what
is actually being sent and **cleared** if the tool is absent, so the turn proceeds instead of failing.

**Hints could name a tool the model cannot see.** They were built from the client's full list rather
than from what was sent. Latent rather than live — every tool a hint names survives the essential-tool
selector — but it becomes live the moment a policy hides something, which is what this adds. Hints now
come from the exposed set.

### Deferred tool search: defined, and not enabled

The shape exists (`eager`, `deferred`, `allowed`) because the policy needs somewhere for it to live.
It is **off**. The real `ToolSearch` → load → call loop has not been proven end to end in the app, and
a deferral that loses a tool presents as a model that "chose" not to use it — the worst possible
failure to debug. `ToolSearch` itself is permanently eager: it is the entry point to every deferred
tool, so deferring it would make the rest unreachable.

There is consequently nothing to evaluate against an all-eager baseline: all-eager is what ships.

## A classifier cannot inherit a model

Claude Code asks the proxy whether a risky action is allowed, gives the answer a **60-second
budget**, and **denies the action** if no parseable verdict arrives. Every failure on this path has
one of two shapes: a verdict rendered by the wrong model, or no verdict at all. Both were reachable.

**Model resolution ran in the wrong order.** `pickModel` returned a requested OpenAI model id
*before* it looked at the classifier family:

```js
if (OPENAI_MODEL_RE.test(req)) return req;                    // <- passthrough won
if (family === "safety" && OPENAI_CLASSIFIER_SAFETY_MODEL) …  // <- never reached
```

So any request naming an OpenAI model inherited it, including a safety verdict. The gateway picker
is enabled here (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) and its default list contains
`gpt-4.1-mini` — the model measured to *allow* an `ssh backend-prod` that `gpt-5.3-codex` blocked,
and to emit no parseable verdict at all on another real prompt. Picking a fast model in the UI would
have silently downgraded the safety classifier to it.

Across 47k logged requests, all **20,160** real safety verdicts arrived asking for a `claude-*`
identity, so the passthrough never fired for safety in practice. The mechanism is demonstrably live
though — the log contains `model=gpt-4.1-mini[1m]->gpt-4.1-mini[1m]`. Latent, not theoretical.
Resolution is now **family-first**: only an ordinary agent turn honours a requested model.

**Tools reached classifiers.** Neither encoder gated its tools block on the route, so a verdict
carrying up to `OPENAI_CLASSIFIER_MAX_TOOLS` (4) tools sent them upstream with `tool_choice`. A
verdict has a rigid output contract; offering a tool invites a tool call *instead of* the verdict,
which is unparseable, which makes the CLI retry and then deny.

**The two surfaces disagreed on overflow.** The streaming path refused to compact for a classifier
(it gates on `allowContinue`), but `callResponses`/`callOpenAI` compacted regardless — so an
HTTP-path overflow shortened the transcript and re-asked, rendering a verdict on evidence the proxy
had just discarded, with the dangerous part possibly among what was trimmed. Both now fail closed.

### Typed routes

| Route | Model | Tools | Hints | Reasoning | Continue | Compact on overflow | Pool |
|---|---|---|---|---|---|---|---|
| `main` | requested, else `OPENAI_MODEL` | ✅ | ✅ | ✅ | ✅ | ✅ | shared |
| `compaction` | as `main` | ✅ | ✅ | ✅ | ✅ | ✅ | shared |
| `prefix` | `OPENAI_CLASSIFIER_MODEL` | ❌ | ❌ | ❌ | ❌ | ❌ | reserved |
| `safety:severity` | `OPENAI_CLASSIFIER_SAFETY_MODEL` | ❌ | ❌ | ❌ | ❌ | ❌ | reserved |
| `safety:block` | `OPENAI_CLASSIFIER_SAFETY_MODEL` | ❌ | ❌ | ❌ | ❌ | ❌ | reserved |

`compaction` deliberately matches `main` today: changing how a transcript is summarised is a
fact-retention question that belongs to the compaction phase. It is typed and logged so the
distinction exists.

**The stage split is diagnostic, not behavioural** — deliberately. All 13 real classifier prompts
recovered from the CLI's own error dumps are stage 2, each opening its *system* prompt with
`security monitor for autonomous AI coding agents` (at fraction 0.00–0.03 of the request). Three of
them also contain `<severity>N</severity>`, but at 0.21, 0.89 and 0.91 — inside the **user
transcript**, where the conversation quotes an earlier stage-1 exchange. With no stage-1 corpus to
validate against, the stages resolve to the same model and the same policy, so a mislabel can only
mislabel a log line. The discriminator is anchored to the system text for the same reason.

### The safety model is pinned to a snapshot

The default is `gpt-5.4-2026-03-05`, not the floating `gpt-5.4` alias: an alias moves, and a
decision about whether a risky action runs should not change behaviour because someone else shipped.
The snapshot was verified to exist before pinning — an id that does not exist would 400 every verdict
and the CLI fails closed, denying every action.

Setting it **blank** now means "use the main model and accept the latency", which the settings help
has always promised and the code never delivered: blank is falsy, so `||` walked past it to the
default. The resolver now distinguishes *defined-but-empty* from *absent* for this one setting, and
warns at startup when blank is chosen — it is the configuration measured to miss the deadline
(median 12.2s, p90 54s, 2 of 27 past the 60s cliff).

## Nothing malformed becomes runnable

A single helper used to parse both the client's request body and the model's tool arguments:

```js
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
```

`{}` is the wrong answer to both questions, and badly wrong to the second. A tool call's `input`
is not a suggestion — the client receives a complete, well-formed `tool_use` block and runs it. A
turn cut off at `{"command":"rm -r` arrived as **`Bash({})`**; a half-streamed write arrived as
`Write({})`. The agent cannot distinguish either from a call the model meant to make, so the
failure surfaced as a tool behaving strangely, blamed on the model.

Parsing is now split by whose input it is, and neither half has a fallback value:

| Input | Failure | Result |
|---|---|---|
| `/v1/messages` body | unparseable, or valid JSON that is not an object | **400** `invalid_request_error` |
| model tool arguments | unparseable, truncated, or not an object | the call is **withheld** and the turn ends with `stop_reason: error` |
| model tool arguments | no bytes at all | `{}` **only** if the schema requires nothing; otherwise withheld |

On the streaming path the `tool_use` block is not opened until its arguments have parsed. That is
the structural reason a malformed call cannot reach the client: while the block was opened on
`response.output_item.added`, the only remaining question was *which* input to put in an
already-open block — and `{}` was the answer. One bad call fails the whole turn rather than
delivering the good ones, because a partial tool-call set would have the agent run half the work
and believe the turn complete.

## One authority for tool names

OpenAI requires tool names matching `^[a-zA-Z0-9_-]{1,64}$`, so the proxy sanitizes them. That
mapping is **many-to-one**, and nothing checked for the collision. Both encoders built their own
pair of maps inline, and `nameMap.set(wire, original)` simply overwrote:

- `foo.bar` and `foo_bar` both become `foo_bar`.
- Two names sharing their first 64 characters become the same name.

When two tools collide, three things go wrong at once and none is visible: the wire carries two
tools with one name, a returned call maps back to whichever tool was declared **last**, and the
wrong schema prunes the arguments — dropping every argument the wrong schema does not declare. The
result is a call to the wrong tool with mangled arguments, attributed to the model.

**How close this is.** Measured against the 57 real MCP tool names this app sends: **32 are already
longer than 64 characters** and therefore truncated, and the closest pair is **two characters** from
colliding —

```
mcp__34c022b6-…-c999a7f65ec4__slack_search_public
mcp__34c022b6-…-c999a7f65ec4__slack_search_public_and_private
```

because `mcp__` + a 36-character UUID + `__` consumes 43 of the 64 characters, leaving 21 for the
tool name itself. No collision exists today. One more connector, or one longer tool name, and there
is.

`tool-registry.mjs` is now the single authority for wire names, reverse mapping and schema lookup.
It validates the **whole** declared catalog before any per-surface cap drops tools — so a collision
cannot depend on which tools happened to survive — and refuses the request with a 400 naming both
tools and the reason. It does not silently suffix an alias: that would keep the request working
while making the model's tool list disagree with its own documentation, and the failure would
resurface later as a model that "chose the wrong tool".

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
  passed through as `image_url` / `input_image` (issue #13); `/v1/messages/count_tokens`
  is estimated.

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

Every setting, its precedence and its coercion live in **`config.mjs`** — one declarative
table, not forty inline `process.env.X || PROJECT.X || default` expressions. That extraction
preserved the existing behaviour exactly, including two inconsistencies that are marked
`QUIRK` in the table rather than quietly fixed:

- `OPENAI_MAX_CONTINUATIONS=0` does **not** disable auto-continue; it resolves back to 2.
  `OPENAI_AUTO_CONTINUE=0` is the off switch.
- `OPENAI_THINKING_MIN_BUDGET` defaults to 4000, but an explicit `0` resolves to 2000.

One more, marked `KNOWN DEFECT`: setting `OPENAI_CLASSIFIER_SAFETY_MODEL=` blank is documented
to mean "use the main model" and does not — blank is falsy, so `||` walks past it to the
default and you silently get `gpt-5.4`. Honouring it needs "defined but empty" to be
distinguishable from absent, which is a safety-critical change and belongs to the phase that
owns classifier routing.

```bash
node config.mjs              # the effective config plus the source of every value
node config.mjs --hash       # just the config hash the launcher compares
node config.mjs --validate   # range and cross-field checks; non-zero on error
```

- **API key** (and `maxTokens`/`temperature` defaults): `~/.dbeaver-ai-complete`
  (`KEY=VALUE`). The key is **never logged**, never in a snapshot, and never in the hash —
  only a one-way `sha256:` fingerprint of it, so a rotated key still invalidates the hash.
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
- **Classifier calls are not agent turns.** Claude Code makes two kinds, both with a
  rigid output contract, and each is handled differently (issue #6):

  | family | prompt marker | output contract | model |
  |---|---|---|---|
  | `prefix` | `<policy_spec># Claude Code Code Bash command prefix detection` | a command prefix, or `command_injection_detected` | `OPENAI_CLASSIFIER_MODEL` (`gpt-4.1-mini`) |
  | `safety` | `You are a security monitor for autonomous AI coding agents` | stage 1 `<severity>N</severity>`; stage 2 `<block>yes\|no</block>` | the **main** model, unless `OPENAI_CLASSIFIER_SAFETY_MODEL` is set |

  For either family the proxy suppresses the format/persistence hints, requests **no
  out-of-band reasoning** (the prompt asks for reasoning in-band inside `<thinking>`
  tags, and hidden reasoning is charged to the same output budget), skips the
  verbosity knob, and never continues the turn. The log line shows
  `classifier=prefix` or `classifier=safety reasoning=off`.

  Only `prefix` is downgraded to a small model. The `safety` verdict is a security
  decision and keeps the main model: replaying six real classifier requests recovered
  from the CLI's own error dumps, 3 of the 5 `<block>`-stage verdicts disagreed and
  **every disagreement went one way** — `gpt-5.3-codex` blocked, `gpt-4.1-mini`
  allowed — and on a sixth `gpt-4.1-mini` emitted no verdict at all, echoing the
  action back as `{"tool":"Bash","input":"git -C …"}`. Both models answered in about
  2s, so downgrading buys nothing. The classifier's own prompt says to err on the
  side of blocking.

  Detection is corroborated by tool count (`OPENAI_CLASSIFIER_MAX_TOOLS`, default 4):
  a verdict call carries no tools, an agent turn carries the whole toolbox, so a
  session that merely *quotes* the contract — like one debugging this — is not
  misrouted. A vetoed match is logged once.

  Per-request routing: requests naming an OpenAI model directly are passed through;
  `prefix` → classifier model; `safety` → main model; everything else → main model.
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
`PROXY_ANTHROPIC_BASE_URL` set. Then open Claude Code
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

- **`disclaimer` helper** — the app spawns every subprocess through
  `Contents/Helpers/disclaimer` (a macOS TCC wrapper absent from stock Electron).
  `run.sh` installs `scripts/claude-code-disclaimer.sh` there as an absolute symlink.
  It is a passthrough in Anthropic mode; in OpenAI mode it additionally selects the
  agent's internal model identity (see below). It never modifies the Claude Code
  executable or the app bundle.
- **The agent executable is the bundled one.** `CLAUDE_CODE_LOCAL_BINARY` used to be
  set here, pointing at a `claude` on `PATH` — that was **ineffective**: in this
  packaged build the initializer that would honour it is never called (`initLocalBinary`
  has no caller and `getLocalBinaryPath()` always returns `null`), so resolution falls
  through to app resources and `user-data/claude-code/<version>`. It was reporting a
  standalone 2.1.217 while Electron actually launched the bundled **2.1.219**. `run.sh`
  now unsets it and prints the real cache location instead.

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
  "total": { "requests": 3, "input_tokens": 26, "output_tokens": 22, "reasoning_tokens": 0,
             "cached_input_tokens": 18, "uncached_input_tokens": 8, "cache_hit_rate_pct": 69.2,
             "tokens": 48 },
  "by_model": { "gpt-5.3-codex": { "requests": 2, … }, "gpt-5.4": { "requests": 1, … } } }
```

Counted on all five upstream paths — chat and Responses, streaming and not, plus the
compaction summariser's own call — and persisted to `openai-proxy/usage.json` (gitignored),
since the proxy restarts on every app launch. `reasoning_tokens` is tracked separately;
those are billed as output but never shown, which is what made the small-budget starvation
above possible.

**`input_tokens` includes cache reads**, following OpenAI's convention — which is the
*opposite* of the Anthropic-facing `input_tokens` this proxy hands back to the client, where
cache reads are reported separately as `cache_read_input_tokens`. That matters more than it
sounds: measured over 8,755 real turns, **96%** of this proxy's input tokens are cache reads,
so `input_tokens` alone overstates what is billed at the full rate by more than an order of
magnitude. `uncached_input_tokens` is the figure that predicts the bill.

Two earlier gaps here, both fixed ([issue #20]): the ledger recorded no cache split at all,
and the summariser's call was never counted despite the sentence above claiming it was.
Totals accumulated before that fix carry `cached_input_tokens: 0` — not a 0% hit rate, just
history from before the field existed.

[issue #20]: https://github.com/mkornreich/llm-desktop-electron/issues/20

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

## Automatic compaction ([issue #4])

The app showed *"Your context window is full … Compact, rewind, or start a new session. Prompt
is too long"*. Claude Code has its own auto-compaction, but it sizes the window from the model
it believes it is talking to (`claude-opus-4-8`) while the proxy actually calls
`gpt-5.3-codex` — so its threshold never trips and OpenAI rejects the request outright:

```
400  Your input exceeds the context window of this model. Please adjust your input and try again.
```

`GET /v1/models/gpt-5.3-codex` returns only `{id, object, created, owned_by}` — **no
`context_window`** — so the limit cannot be read ahead of time. Compaction is therefore
reactive: catch that error, shrink the conversation, retry, escalating through
`COMPACT_STEPS = [12, 6, 2]` recent items until it fits.

**What gets shrunk, and why only that.** Tool *output* is where an agent conversation's tokens
actually live — file contents and command output, measured at ~110k input tokens per request.
The proxy truncates that content and **never removes items**, because a `function_call` and its
`function_call_output` are separate top-level items joined by `call_id`: drop one side and
OpenAI rejects the whole request. Truncating content keeps the structure exactly intact. The
same applies on the chat surface, where tool results are `role:"tool"` messages.

Verified against a real overflow — 40 tool round-trips, 1.67 MB, ~419k estimated tokens:

```
! context exceeded — compacted 36 tool result(s), reclaimed ~374k tokens (keeping last 12 items); retrying
<- responses status=completed out_tokens=23
```

HTTP 200 on the retry with input down to 79,867 tokens, and the answer was still **correct**:
*"I read 40 files (src/file0.ts through src/file39.ts)."* That is the payoff of truncating
output rather than removing items — the file paths lived in the `function_call` arguments,
which are never touched.

### It summarises rather than discards

Dropped tool output is not replaced with a placeholder — a cheap model (`OPENAI_COMPACT_MODEL`,
default `gpt-4.1-mini`) condenses it into a factual digest that keeps what a coding agent still
needs: file paths, symbol names, key values, errors, counts and conclusions. The digest is
written into the **oldest trimmed slot**, so no items are added or removed and `call_id`
pairing stays untouched. Disable with `OPENAI_COMPACT_SUMMARY=0`.

Measured with three marker comments planted inside results 7, 19 and 31 of 40, then asking a
question answerable only from the *content* of the compacted region:

| | recalled |
|---|---|
| plain truncation | 0 / 3 — the content is gone |
| summarised, greedy budget | **2 / 3** |
| summarised, even budget | **3 / 3** |

All three came back with exact paths and exact comment text — `src/file7.ts — // TODO: fix the
race in scheduler.ts` and so on — out of 374k tokens of tool output compressed into a 634-char
digest.

The two-of-three result is worth recording, because it was a real bug. The summariser budget
was spent first-come-first-served, so 36 results at 4,000 characters each blew the 120k total
and the last items were fed **nothing** — the marker in result 31 never reached the summariser
at all. The budget is now split evenly (`SUMMARY_TOTAL / pieces.length`, floor 400), which is
what took it to 3/3. There is a regression test asserting every dropped result arrives with
content.

Summarising **can only add value**: any failure — non-2xx, empty digest, thrown error, or the
60s timeout — falls back to plain truncation, and no model call is made when there is nothing
to drop.

**Honest limits.** This is reactive, so the first over-limit request costs one wasted
round-trip, plus one more for the digest. The digest is lossy by construction — it is a summary,
not the original text — so a question needing verbatim detail from a compacted result may still
miss. Recent turns, every user message and the opening task are always preserved intact.

[issue #4]: https://github.com/mkornreich/llm-desktop-electron/issues/4

## Output-token limits ([issue #8])

Two problems, one of which the proxy had caused itself.

**Turns cut off by the output cap are now resumed.** When a response ends
`incomplete/max_output_tokens`, the proxy continues it and appends to the **same** assistant
message, with a prompt that forbids repeating anything already written. Measured with
`max_tokens=400` on a request that wanted ~900 words:

```
-> continue-on-truncation 1/2: cut off at the output cap after 400 token(s); resuming with 55600 left
-> continue-on-truncation 2/2: cut off at the output cap after 800 token(s); resuming with 55200 left
<- stop_reason=max_tokens out_tokens=1200 text=5760ch
```

5,760 characters delivered instead of ~1,900, and **zero repeated 8-grams** across both seams.
`stop_reason` stays `max_tokens` when it is still incomplete, so the client is not told a
truncated answer is finished. Controlled by `OPENAI_CONTINUE_ON_TRUNCATION`.

**The cumulative ceiling matters more than the continuation count.** Every continuation appends
to one message, and the client enforces its own per-response maximum — *"Claude's response
exceeded the 64000 output token maximum"*. Splicing without a budget is a plausible way to
produce exactly that error, which makes it a likely self-inflicted cause of the reported issue.
`OPENAI_MAX_TURN_OUTPUT_TOKENS` (default 56,000) stops continuations below it, and `run.sh` now
sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000` explicitly so the client-side limit is visible rather
than implicit. With realistic budgets the ceiling binds long before the continuation count does.

**Two bugs found while fixing it:**

- The default budget for requests that omit `max_tokens` was read from
  `~/.dbeaver-ai-complete`, which sets **`maxTokens=512`** — a DBeaver setting for a SQL
  assistant, far too small for an agent, and with reasoning attached such a request could return
  nothing at all. Now `OPENAI_DEFAULT_MAX_TOKENS`, default 8192.
- The empty-turn notice **hardcoded** `reason: "max_output_tokens"` whenever a stream reported
  incomplete, so it could blame the token budget for a content filter and print advice that did
  not apply. It now reports the reason the API actually gave, and only offers budget advice when
  the budget really was the cause. This is the notice quoted in the issue's comment, and its
  reason may well have been wrong.

[issue #8]: https://github.com/mkornreich/llm-desktop-electron/issues/8

## Showing the task list ([issue #7])

When the agent changes its task list the session shows a collapsed label — "Updated
tasks" — and not the tasks. That is not something this build can restyle: the chat UI
is the remote claude.ai app, and the local bundle holds only tool-name registries and
i18n ids (`builtinTool.TaskUpdate`), no renderer.

Nothing downstream carries the list either. Verified in CLI 2.1.217:

| tool | tool_result content |
|---|---|
| `TaskUpdate` | `Updated task #3 status` |
| `TodoWrite` | `Todos have been modified successfully. Ensure that you continue to use the todo list…` |

and `TodoWrite`'s `renderToolUseMessage()` returns `null`. The full list appears in
exactly one place — a **nudge** that only fires when the task tools have been idle,
`"Here are the existing tasks:\n\n#1. [completed] …"`, built as
`` `#${o.id}. [${o.status}] ${o.subject}` `` and marked `isMeta`.

So the proxy renders it, as its own text block after the tool calls:

```
**Tasks** — 2 done, 1 to do
- [x] #1 Read the bug report
- [x] #2 Reproduce it
- [ ] #3 Write the fix
```

`[x]` completed, `[~]` in progress, `[ ]` pending.

**Where the numbers come from.** Nothing is invented. `TodoWrite` carries the whole
list on every call, so that echo is exact. For `TaskCreate`/`TaskUpdate` the prior
state is rebuilt from the transcript — the nudge blocks give ids, statuses and
subjects, and earlier task tool calls are replayed on top — then this turn's call is
applied. A `TaskCreate` shows its tasks marked `_(new)_` **without an id**, because ids
are assigned server-side and the proxy does not have one yet; it never fabricates one.
A call that changes nothing (`TaskUpdate` with no id, `TodoWrite` with no todos) echoes
nothing.

**Placement.** The echo is emitted *after* the tool-call blocks using the same
`open`/`close` helper as the empty-turn notice, which allocates a fresh trailing index —
so no existing block's index moves. Verified on a live stream: blocks `text(0)`,
`tool_use(1)`, `text(2)`, indices contiguous from 0, every block opened and closed,
starts monotonic, `stop_reason=tool_use`.

Skipped entirely for classifier calls ([issue #6]) — a verdict must not gain a task
list. Disable with `OPENAI_TASK_ECHO=0`.

### Narration

The same issue asks for the agent to be verbose about what it is doing, so the
persistence hint gained a **Narrating your work** section: one short line naming the
next step before taking it, saying what actually came back afterwards, and restating
the task list in prose when it changes — *"The task tools do not show this to the user,
so if you do not write it down nobody sees it."*

The last bullet is the guard, and it is load-bearing: "be verbose" on its own invites
exactly the padding [issue #1] complained about, so the directive ends with
*"Narration is information, never padding"* plus an explicit ban on restating the
request, announcing summaries, and filler.

`OPENAI_VERBOSITY` was not the lever: it is already `high`, the top of the enum, and
`ultra` is a 400. Prompt wording is all there is.

### The collision this exposed

`NEEDS_USER_RE` is an override — a turn that ends asking permission for something
destructive must stay ended, or auto-continue would answer the user's question for them
and then act. It matched a **bare** `confirm` or `destructive` anywhere in the text, so
narration silenced the whole rescue:

| text | before | after |
|---|---|---|
| `I'll run the tests now to confirm the fix holds.` | `null` | `intent` |
| `Next I will check the file for anything destructive.` | `null` | `intent` |
| `This would delete the branch. Confirm and I will run it.` | `null` | `null` |

The permission half now matches the **construction** — `please confirm`,
`confirm and…`, `once you confirm`, `your confirmation`, `is/would be destructive`,
`destructive action|operation|…` — while the markers that are almost never incidental
(`irreversibl`, `cannot be undone`, `permanently`, `rm -rf`, `force push`,
`drop table`) stay bare. Fourteen genuine permission requests still stop the turn dead;
three narration sentences that used to be swallowed now continue.

This was a pre-existing bug, but asking for narration turned it from theoretical into
likely, so it is fixed here.

[issue #7]: https://github.com/mkornreich/llm-desktop-electron/issues/7
[issue #6]: https://github.com/mkornreich/llm-desktop-electron/issues/6

## Empty turns: retry instead of stalling

The symptom, from a real session ("predict cash flow"): send a message, wait ~40s, get

```
[proxy] The model returned no content for this turn (status=completed). No tool was called, so nothing ran.
```

Four times in a row. `proxy.log` held **20** of them across ~2.5 hours.

### They were three different failures

Classifying every `empty turn` line against the summary line that follows it — which is worth
doing before designing a fix, and which an earlier version of this section skipped:

| count | signature | cause |
|---|---|---|
| 9 | `end_turn`, no usage, 107ch notice | **a dropped `error` event** — see below |
| 10 | `max_tokens`, usage present, 338–340ch notice | the whole output budget went to hidden reasoning |
| 2 | `end_turn`, usage present | a genuine silent completion |

The **9** are the ones the user reported, all in one session. For those the status was
**inferred**, not reported — `incomplete ? "incomplete" : "completed"` — so a turn that produced
nothing was described as a normal completion in which the model chose to stay silent. Same class
of mistake as the hardcoded reason fixed in [issue #8]: asserting a cause the code had not
observed.

Their cause is now known, and it is not exotic: an **unhandled `error` event**. With no
`case "error"` in the switch, such an event set nothing at all — no content, no usage,
`incomplete` still false — which is exactly the 107ch / `out_tokens=?` signature. Once the event
was handled the session said what it had been saying all along:
*"Your input exceeds the context window of this model."* See the section below.

**A correction worth recording.** An earlier version of this section read that signature as
proof the stream had ended *without a terminal event*, and called it a transport failure. That
inference was unsound: `out_tokens=?` only means usage was absent, and usage is routinely absent
from perfectly ordinary **successful** turns — the log has plenty, e.g.
`stop_reason=end_turn out_tokens=? text=2291ch`. Since the explicit
`upstream stream ended with NO terminal event` instrumentation was added, it has fired **zero**
times. The retry for that case is kept because it is cheap and correct if it ever happens, but
no instance of it has actually been observed.

The **10** are a different bug in the same clothing, and they were the biggest group. A turn
whose budget is entirely consumed by reasoning has no content, so the continue-on-truncation
loop had nothing to continue from and spent two more starved calls trying — visible in the log
as `continue-on-truncation 1/2`, `2/2`, then the same empty notice. That loop now requires
something to resume from (`textLen > 0 || hasTool`), and starvation is routed to the retry
instead, which drops reasoning and is therefore the actual cure.

### Three fixes

**1. Events that were being dropped.** The streaming switch had no case for `error`, none for
`response.failed`, and none for refusals — so an upstream error mid-stream, or a refusal,
produced a silent empty turn. All three are handled now. A refusal is emitted as text, because
it is the answer and the user is entitled to see it. Unknown event types are collected and
named in the notice, so the next silent drop is explainable rather than mysterious.

Benign bookkeeping events (`response.created`, `response.in_progress`,
`response.content_part.*`, `rate_limits.updated`, …) are named in a known-benign set, so
`unhandled_events` in the notice only ever reports something genuinely unexpected — without
that it said `unhandled_events=response.created` on every failure, which points at nothing.

**2. The truth, and a measurement.** The notice reports the status the stream actually reached —
`failed` with the upstream's own message when there was an error, `no terminal event` when the
stream really did just stop — instead of inferring "completed". The log records how long the
stream ran and how many bytes it carried, so a future occurrence is measurable rather than
anecdotal. (That instrumentation is also what proved the *no terminal event* case has never
actually happened here.)

**3. It retries.** Up to `OPENAI_MAX_EMPTY_RETRIES` (default 2), and the retry **drops
reasoning** — a turn that burned 40s and returned nothing was almost certainly in a long silent
reasoning phase, which is exactly the window that gets cut, so asking for the same hidden
reasoning again reproduces the failure.

Retrying is skipped where it is wrong, each with a test:

| case | why not |
|---|---|
| refusal | the refusal *is* the answer; asking again just refuses again |
| `error` / `response.failed` | a hard upstream failure; the message is the useful output |
| `incomplete` for any reason but the output cap | e.g. `content_filter` — not something a retry fixes |

`incomplete` **because of the output cap with no output at all** is deliberately still retried:
that is the starvation group above, and dropping reasoning is the fix. The first version of this
change vetoed on `incomplete` wholesale and so left the largest of the three groups unfixed —
caught by an adversarial review agent that classified the log lines instead of trusting the
summary.

Classifier calls pass `allowContinue=false`, so a safety verdict is never retried ([issue #6]).

### A bug found by a failing test

Adding the retry broke `issue #8: the cumulative total is what gets reported` — it asserted
exactly **two** usage-accumulation sites. Chasing that turned up a real defect: of the four
places that consume an upstream response, the **auto-continue** loop never added its tokens to
the turn total, so `out_tokens` under-reported every time that loop fired. Fixed, and the test
now asserts the invariant — every `await consume(` is followed by an accumulation — instead of
a magic number that passed while the property was false.

[issue #8]: https://github.com/mkornreich/llm-desktop-electron/issues/8

### Verified deterministically

The failure is intermittent, so it was reproduced against a stub upstream that ends its stream
with no terminal event — the exact fingerprint — rather than by waiting for it to happen again:

| scenario | result |
|---|---|
| upstream always empty | `NO terminal event after 1ms and 35 byte(s)` → `retry 1/2` → `retry 2/2` → notice reading `status=no terminal event, retries=2` |
| empty once, then content | `retry 1/2` → `recovered after 1 empty-turn retry`, no notice shown |

The stub echoes back whether it was sent a `reasoning` field, and on the retry it reports
`reasoning=false` — confirming the retry really does drop it.

### The actual cause: a context overflow arriving as an event

Once `error` events stopped being dropped, the session said what had been wrong all along:

```
[proxy] The model returned no content for this turn (status=failed). No tool was called, so
nothing ran. The upstream reported: Your input exceeds the context window of this model.
Please adjust your input and try again.
```

The proxy has had compaction for this since [issue #4] — but it lived in `callResponses` and
only ever saw the **HTTP 400** form. This arrives as an `error` **event on a 200 response**,
mid-stream, so compaction never ran and the turn surfaced as "no content" with no recovery.
Claude Code's own auto-compaction cannot help either: it sizes the window from the model it
believes it is talking to (a 1M-context Claude), not the model actually being called.

The streaming path now runs the same compaction ladder (`COMPACT_STEPS = [12, 6, 2]` tool
results kept, summarising what it drops) and retries. Verified against a stub that reproduces
the exact shape — 200, then that error, succeeding once the payload fits:

```
call 1: 61 items / 124689 bytes -> context error
        -> context exceeded mid-stream — compacted 24 tool result(s), reclaimed ~24k tokens
           (keeping last 12); retrying
call 3: 61 items /  30513 bytes -> OK
```

and the client received the model's real answer, not a notice.

Two related decisions:

- A context overflow is **not** retried by the empty-turn loop — re-sending the same oversized
  input cannot help, so `shouldRetryEmpty` vetoes it and the compaction loop owns it.
- Compaction is gated on `allowContinue`, so a **classifier** turn that overflows fails closed
  rather than being judged on a silently shortened transcript ([issue #6]).

[issue #4]: https://github.com/mkornreich/llm-desktop-electron/issues/4

## Is the classifier still calling Anthropic? ([issue #11])

[issue #11] is the same message as [issue #6], for `WebFetch` on `claude-opus-4-8`, and asks the
right question. The answer has two halves.

**The app's classifier calls do not go to Anthropic.** They are served by this proxy —
119 `classifier=safety` requests logged, all `hints=off reasoning=off`, mapped to
`gpt-5.3-codex`. The model name in the CLI's error message is simply the name the CLI *asked*
for; the proxy maps it and the CLI echoes its own name back.

**But some classifier failures in the dump directory genuinely are Anthropic.** Six of the 30
dumps carry

```
529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},
     "request_id":"req_011Cdjnjpn88pMEb3LYdfahN"}
```

HTTP 529, `overloaded_error` and a `req_011C…` id are Anthropic's shapes — this proxy only ever
emits `type: "api_error"`. All six are on a `claude-sonnet-5[1m]` model, and **no `claude-*[1m]`
model ever appears in the proxy log**, so those requests never went through it. They are ordinary
terminal Claude Code sessions talking to `api.anthropic.com`, sharing the same dump directory
because the dumps are per-user, not per-app.

### Nothing further to fix, and here is why

The cause was the [issue #6] detection gap, and the numbers say it is closed:

| | |
|---|---|
| issue #11's own dump | 12:34, **before** the fixed proxy was serving |
| last classifier failure of any kind | 14:30 |
| classifier requests served since | 119, zero errors |
| gap since the last failure | ~113 minutes of active use |
| measured round-trip on #11's own prompt | **7.3s** (2.1–7.3s across runs), against a 60s budget |

The budget matters because the CLI **fails closed**: when its classifier deadline expires the
action is *denied*, which is what "temporarily unavailable" means. A verdict is ~11 output
tokens, so the deadline is only ever reached when the proxy is slow.

### Two diagnostic fixes, because this was measured wrong twice

Working out that latency produced two confidently-stated wrong answers — a "median 34s" and then
a "median 483s" — before the cause was spotted: log lines carried **time of day only**, and the
log spans more than one day, so every duration computed across the wrap was nonsense. On top of
that, requests are concurrent, so pairing a start line with the next completion line pairs
unrelated requests.

Both are fixed at the source rather than worked around:

- Log timestamps now include the date (`[proxy 08-05 20:22:41]`).
- A classifier verdict is **timed directly** and logged as
  `<- classifier=safety verdict in 7252ms`, with an explicit warning above
  `OPENAI_CLASSIFIER_SLOW_MS` (default 20s) naming the consequence:
  *"The CLI aborts its classifier at 60s and then DENIES the action."*

No more inferring latency from interleaved log lines.

[issue #11]: https://github.com/mkornreich/llm-desktop-electron/issues/11

### Correction: the safety classifier WAS too slow

The section above concluded, from a single 7.3s measurement, that classifier latency was "not
close" to the CLI's deadline. The direct timing added at the same time then disproved that within
the hour. Over 27 live verdicts on `gpt-5.3-codex`:

| | |
|---|---|
| median | 12.2s |
| p90 | **54s** |
| max | **287s** |
| past the 60s cliff | **2 of 27** |

and a fresh `Request was aborted.` dump appeared while the "no failures in 113 minutes" claim was
still on screen. The CLI aborts its classifier at 60s and then **denies the action**, so those
are exactly the "temporarily unavailable" denials the user reported.

Replaying the four largest real classifier prompts through candidate models:

| dump | gpt-5.3-codex | gpt-5.4 | gpt-4.1 |
|---|---|---|---|
| 612d01f5 | no / 26804ms | **yes** / 3499ms (Irreversible Local Destruction) | no / 2659ms |
| 87f6bc08 | no / 25100ms | no / 2705ms | no / 7726ms |
| b6e29189 | **yes** / 37667ms (Production Reads) | **yes** / 2510ms (Production Reads) | **no** / 1760ms |
| b0f45511 | no / 31035ms | no / 1376ms | no / 1041ms |

`gpt-5.4` is ~10x faster and **not** more permissive: it matched the one block codex made and
blocked one more that codex allowed — the right direction for a prompt that says to err on the
side of blocking. `gpt-4.1` allowed the Production Reads case, the same failure `gpt-4.1-mini`
showed, so it is not a candidate however fast it is.

So `OPENAI_CLASSIFIER_SAFETY_MODEL` now defaults to **`gpt-5.4`**. This reverses the earlier
"keep the main model" decision, and the reason it is not a contradiction is worth stating: that
decision was made to avoid a *weaker* verdict, and `gpt-5.4` is not weaker. Verified on issue
#11's own prompt: **2015ms**, and it blocked (`Auto Mode Bypass`) where codex allowed.

The invariant kept from both rounds, with a test: the safety default may never be a `gpt-4.1`
variant, because both were measured allowing something codex blocked.

## Why the context window feels small ([issue #14])

Measured by bisection against the live API with `max_output_tokens=16`:

| model | result |
|---|---|
| `gpt-5.3-codex` | **253,339 accepted**, ~284k rejected → a **272k** window |
| `gpt-4.1` | **618k accepted** → ~1M |

Claude Code packs its prompt for the model it *believes* it is talking to — a 1M-context
Claude — so on a 272k model overflow is routine rather than exceptional. The log shows **173**
context-overflow events.

### The proxy was making it worse

The compaction ladder was `[12, 6, 2]`: on the first overflow it cut straight to the last **12**
tool results. Across **168** logged compactions the first step succeeded *every single time* and
the 6 and 2 steps were never reached — so every overflow was resolved with far more cutting than
it needed. One logged example reclaimed **~112k tokens** to clear an overflow that a gentle trim
would have fixed, and that discarded history is exactly what surfaces as the model having lost
the thread.

The ladder is now `[96, 48, 24, 12, 6, 2]` — gentlest first. Starting gentle costs an extra
round trip when a large cut really is needed, so the level that worked is remembered for the
rest of the process and reused as the starting point, the same shape as the per-model reasoning
effort and unsupported-parameter memos.

### If you want a bigger window

`OPENAI_MODEL=gpt-4.1` has roughly four times the context and would make overflow rare. It is a
weaker coding model than `gpt-5.3-codex`, so it is a genuine trade, not a free upgrade — which
is why the default is unchanged and this is written down rather than decided for you.

### Telling the CLI the truth: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`

Set in `.openai-model` and exported by `run.sh` in openai mode only (in anthropic mode the real
Claude genuinely has a 1M window and forcing this would shrink it).

Semantics, read out of the CLI's own resolver:

```
window = Math.min(<the model's own window>, Math.max(100000, value))    value capped at 1e6
usable = window - Math.min(maxOutputTokens, 20000)                      a 20k output reserve
```

The critical word is **`Math.min`**: this value is an *upper bound*, not an override. If the
CLI resolves its own model's window to something smaller, the smaller number wins and this
setting does nothing. That is exactly what [issue #17] turned out to be — see below. Below
100000 the value is ignored; above 1000000 it is capped, not rejected.

**Honest status: set and correct by construction, but not yet shown to help.** The A/B I ran
was inconclusive and the reason is worth recording — I fed a ~300k-token document as a single
user message, and *neither* compactor can do anything with that. Both the CLI's and this
proxy's compaction work on conversation history and tool results, so a single oversized
message just produces:

```
! context exceeded mid-stream and nothing left to compact (keep=96)
```

That is a real gap in its own right: **an oversized single message cannot be compacted by
anything here.** The setting targets the actual failure mode — long multi-turn sessions with
many tool results, which is what all 173 logged overflows were — so measuring it needs real
use over time rather than one synthetic prompt. The number to watch is the count of
`context exceeded` lines in `proxy.log`.

[issue #14]: https://github.com/mkornreich/llm-desktop-electron/issues/14

## Switching the main model to gpt-5.6-sol

Measured on the identical 236-tool request this app really sends, four samples each:

| | gpt-5.3-codex | gpt-5.6-sol |
|---|---|---|
| latency | 105.5s / 77.5s / 54.2s / 63.8s | **4.2s / 5.4s / 7.1s / 4.9s** |
| context | 272k (253,339 ok, ~284k rejected) | **≥622,229 accepted** |
| `reasoning.effort: max` | steps down to `xhigh` | **accepted** |
| tool call | ✓ correct, out=19 | ✓ correct, out=19 |

~14× faster at the median with more than twice the window. What these numbers say nothing
about is **output quality on real coding work**, which is the axis that matters most and is not
measured here.

`OPENAI_API=responses` is **mandatory** alongside it. The surface heuristic is "does the name
contain codex", so sol would otherwise land on Chat Completions where the 128-tool cap drops
108 of 236 tools, and where the API refuses the request outright:

```
400 Function tools with reasoning_effort are not supported for gpt-5.6-sol
    in /v1/chat/completions
```

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` moved 272000 → 600000 to match. Change it whenever the model
changes: too high and the CLI never compacts and the proxy truncates instead, too low and it
compacts for nothing.

Verified live after the switch — `model=gpt-5.6-sol api=responses`, real turns at `tools=236`
with **zero** tool-cap drops, zero context overflows, zero effort fallbacks and zero empty turns.

## Compacting immediately on a new chat ([issue #17])

> *"i sometimes see it compact the conversation immediately when i start a chat"*

Two separate faults, one visible symptom.

### The recurring cluster at 157k–175k

`CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000` was set and being exported, yet across 14 non-subagent
sessions there were **59** `compact_boundary` records, all but one with
`compactMetadata.trigger="auto"`, clustering at a minimum of **157,287** and a median of
**174,634** `preTokens`. A 900k window cannot compact at 167k, so the setting was not in force.

It was being clamped. Reading the resolver out of the **bundled** Claude Code — 2.1.219, the one
under `user-data/claude-code/`, *not* a standalone `claude` on `PATH` — the 1M window for
`claude-opus-4-8` requires one of three things, and this configuration had none of them:

| gate | state here |
|---|---|
| `[1m]` model suffix | absent — the app launches plain `claude-opus-4-8` |
| `context-1m-2025-08-07` beta header | not sent |
| native first-party provider | fails: `ANTHROPIC_BASE_URL` is `127.0.0.1` |

The registry entry does say `window: 1e6, native_1m: true, supports_1m_suffix: true` — the model
is *recognised* and *capable*. Recognition is not activation. With all three gates shut it fell
to the **200,000** fallback, and 900000 was then clamped to it:

```
200,000 - 20,000 (output reserve) - 13,000 (auto-compaction reserve) = 167,000
```

Which is the cluster, arithmetically.

**Confirmed by A/B**, not by inference — the bundled 2.1.219 driven against a localhost stub
with a dummy key, one session id reused across two turns, synthetic context just over the
threshold:

| `--model` | init identity | what happened |
|---|---|---|
| `claude-opus-4-8` | `claude-opus-4-8` | `status="compacting"`, then `compact_error="too_few_groups"` |
| `claude-opus-4-8[1m]` | `claude-opus-4-8[1m]` | no compaction |

Both arms sent `"model": "claude-opus-4-8"` on the wire. The suffix is a **client-internal**
capability marker that Claude Code strips before calling `/v1/messages`, which is why fixing
this in the proxy is impossible: by the time a request arrives, the window is already resolved.

### The fix, and where it had to go

The internal identity has to be right *at spawn*. Four surfaces were ruled out first:
`CLAUDE_CODE_LOCAL_BINARY` (dead code in this build), proxy-side model rewriting (too late),
patching the Claude Code binary (proprietary, and out of bounds), and wrapping the cached
executable path (fails the CLI's own Mach-O validation and gets the version directory purged).

What remains is the `disclaimer` boundary the app already spawns everything through.
`scripts/claude-code-disclaimer.sh` ignores any `--model claude-*` identity selected by Desktop
and rewrites it to `--model claude-opus-4-8[1m]` for the bundled/cached Claude executable
*only*, then `exec`s, so pid, signals and exit status are unchanged. This covers newer Opus,
Sonnet, Haiku, and future Claude labels: every `--model claude-*` argument receives the same 1M
client capability in OpenAI mode. It is gated on a private OpenAI-mode variable, so Anthropic
mode is byte-identical argv passthrough, and it matches
`user-data/claude-code/*/claude.app/Contents/MacOS/claude` so a future pinned version keeps
working.

That covers the session process, and **only** the session process. Subagents — `Task`,
the built-in `Explore` agents, teammate spawns — are not separate processes: they run inside the
session and pick their model from Claude Code's own resolver, so no argv rewrite can reach them.
They were resolving `claude-sonnet-5` at Sonnet's ordinary window, visible in the log as
`model=claude-sonnet-5->gpt-5.6-sol` requests that never exceed ~299k tokens and account for
**344 of 402** `CLIENT-SIDE COMPACTION` events, against 42 for the 1M main loop.

The resolver reads `CLAUDE_CODE_SUBAGENT_MODEL` first — ahead of the Task tool's `model`
argument and an agent definition's `model:` frontmatter — so the helper exports it alongside the
argv rewrite. It cannot be exported from `run.sh`: the desktop bundle builds the agent env itself
and sets `CLAUDE_CODE_SUBAGENT_MODEL: getDefaultSubagentModel()`, which is where
`claude-sonnet-5` came from and which would clobber an inherited value. The helper is the CLI's
direct parent, so it assigns last and wins. Verified against the real 2.1.219 binary on the
cache path: with the desktop's `claude-sonnet-5` preset in the environment, the process still
receives `claude-opus-4-8[1m]`.

`CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP` is deliberately left unset. The Explore cap it
disables is guarded by a first-party base-URL check, so it is already inert against a localhost
proxy, and `CLAUDE_CODE_SUBAGENT_MODEL` outranks it in any case.

Three identities, deliberately distinct:

```
claude-opus-4-8[1m]   Claude Code's internal identity   -> decides the context window
claude-opus-4-8       what reaches /v1/messages         -> the CLI strips the suffix
gpt-5.6-sol           what the proxy calls              -> OPENAI_MODEL, unchanged
```

With `[1m]` active, the 900k bound applies: **~880,000** shown as available (after the 20k
output reserve) and ordinary auto-compaction near **~867,000** (after the additional 13k). Those
two figures are different on purpose; reactive/precompute thresholds are different again.

### The two that looked instant

`preTokens=317980` and `preTokens=268862`, both ~112 seconds after session creation. Neither was
an empty chat: both had reached **record 20**, and were genuinely that large — this app sends
~236 tool schemas, about **121.8k estimated tokens** of fixed overhead present on turn one,
before any conversation. A bare CLI first turn measures 21,815 input tokens with 27 tools; the
comparison is not close.

They are the same bug: 167k arrives quickly when 121.8k of it is spent before you type. But the
log actively hid it, because `~ctx` summed system + messages and **excluded the tool schemas** —
understating every Desktop request by more than its entire conversation. The accounting now
reports each part, and names the largest single item (`tool_schema:<name>` included):

```
/v1/messages [responses] model=claude-opus-4-8->gpt-5.6-sol msgs=41 \
  ~system+messages=64.2ktok ~tools=121.8ktok ~total=186ktok biggest=~24.1ktok/tool_result
```

### What the compaction line does and does not claim

Every `~` figure is `chars/4` — the proxy has no tokenizer, and `in_tokens=` from the response is
the only authoritative count. The warning names which of the three prompt families fired and what
that family actually retains ("discards the transcript" was true of the full path only), and then
stops:

- **Automatic or manual `/compact`?** Not knowable here — both send the identical prompt. Only
  the transcript's `compactMetadata.trigger` settles it.
- **The effective window?** Not knowable here either. It resolves inside the client from the
  internal suffix, beta headers, base URL, registry and disable flags. The proxy reports the
  *configured* identity and the *configured upper bound*, labelled as such.
- **Not the proxy's own compaction.** That is a separate fallback that runs only after an
  upstream context error and logs `context exceeded`.

[issue #17]: https://github.com/mkornreich/llm-desktop-electron/issues/17
