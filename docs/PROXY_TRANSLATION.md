# Proxy translation — what the proxy receives and returns

Exactly what `openai-proxy/proxy.mjs` accepts from the client and sends to the upstream, and
back, captured from real runs against a mock upstream. There are **two translation boundaries**:

```
Client (Claude Code / Code tab)  ⇄  [Anthropic Messages API]  ⇄  PROXY  ⇄  [OpenAI Chat or Responses API]  ⇄  upstream provider
```

- **Boundary A** (client ⇄ proxy): always the **Anthropic Messages API** (`POST /v1/messages`).
- **Boundary B** (proxy ⇄ upstream): the **OpenAI Chat Completions** (`/chat/completions`) or
  **Responses** (`/responses`) API, chosen per provider by `providers.<id>.api` in `config.jsonc`.

The **client-facing Anthropic response is identical** whichever upstream API is used — the proxy
normalizes both `/chat` and `/responses` back to the same Anthropic shape.

Every visible response is **led by a one-line text block naming the model that answered** —
`model → <provider>:<model>`, or `composite → …` / `compaction → …` (see
[the model note](#the-model-note) at the end). It is stripped back off the assistant's turns on the
way upstream so the model never echoes it.

---

## Boundary A — the Anthropic request the proxy receives

`POST /v1/messages`

```json
{
  "model": "composite",                     // "composite" | "<provider>:<model>" | "claude-opus-4-8" | bare id
  "max_tokens": 64000,
  "stream": true,
  "system": "You are a coding agent…",      // string OR [{ "type":"text", "text":"…" }]
  "messages": [
    { "role": "user",      "content": "hi" },                          // string, OR:
    { "role": "user",      "content": [ { "type":"text", "text":"…" },
                                        { "type":"image", "source": {…} },
                                        { "type":"tool_result", "tool_use_id":"…", "content":"…" } ] },
    { "role": "assistant", "content": [ { "type":"text", "text":"…" },
                                        { "type":"thinking", "thinking":"…", "signature":"…" },
                                        { "type":"tool_use", "id":"…", "name":"…", "input": {…} } ] }
  ],
  "tools": [ { "name":"get_weather", "description":"…",
               "input_schema": { "type":"object", "properties": {…}, "required": [ … ] } } ],
  "tool_choice": { "type":"auto" },          // "auto" | "any" | "none" | { "type":"tool", "name":"…" }
  "thinking": { "type":"adaptive", "display":"summarized" },
  "temperature": 1, "top_p": 1, "stop_sequences": [ … ],
  "metadata": {…}, "output_config": {…}, "context_management": {…}
}
```

Headers that matter: `anthropic-version`, `anthropic-beta`
(`interleaved-thinking-…`, `effort-…`, `thinking-token-count-…`, `context-1m-…`),
`x-api-key`, `x-claude-code-session-id`.

The Anthropic **response** the proxy returns has this shape in every scenario:

```json
{
  "id": "msg_…", "type": "message", "role": "assistant", "model": "<the requested model>",
  "content": [ { "type":"text", "text":"…" }, { "type":"tool_use", "id":"…", "name":"…", "input": {…} } ],
  "stop_reason": "end_turn" | "tool_use" | "max_tokens" | "error",
  "stop_sequence": null,
  "usage": { "input_tokens": 10, "output_tokens": 3 }
}
```

Streaming returns the same content as an Anthropic SSE event sequence (see D below).

---

## Upstream = Chat Completions (`api: "chat"`)

Providers: cloudflare, cohere, gemini, mistral, nvidia, llm7, freetoken, on-device ollama.

### A — plain text turn

**② proxy → upstream** (`POST /chat/completions`):
```json
{
  "model": "demo-model",
  "messages": [
    { "role": "system", "content": "You are helpful.\n\n## Output formatting for this client\n- Math: use $...$ …" },
    { "role": "user",   "content": "hi" }
  ],
  "stream": false,
  "max_tokens": 100
}
```
- Anthropic `system` (string or array) → an OpenAI **`system` message**, with the client
  **format-hint block appended** (math delimiters, "always say something in words", etc.).
- `max_tokens` stays `max_tokens` (→ `max_completion_tokens` for gpt-5.x / o-series).
- `stream_options: {include_usage:true}` is added when `stream:true`.

Upstream returns `{ choices:[{ message:{ content:"Hi there!" }, finish_reason:"stop" }], usage:{ prompt_tokens:10, completion_tokens:3 } }`.

**③ proxy → client**:
```json
{
  "content": [ { "type":"text", "text":"model → ollama:demo-model" },
               { "type":"text", "text":"Hi there!" } ],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 10, "output_tokens": 3 }
}
```
`finish_reason:"stop"` → `stop_reason:"end_turn"`; `prompt_tokens`/`completion_tokens` →
`input_tokens`/`output_tokens`.

### B — the model calls a tool

**② proxy → upstream** — Anthropic `tools[]` become OpenAI `function` tools (`input_schema` → `parameters`):
```json
"tools": [ { "type":"function",
             "function": { "name":"get_weather", "description":"Weather",
                           "parameters": { "type":"object", "properties":{ "city":{"type":"string"} }, "required":["city"] } } ]
```
Upstream returns `finish_reason:"tool_calls"` with
`message.tool_calls:[{ id:"call_1", function:{ name:"get_weather", arguments:"{\"city\":\"Paris\"}" } }]`.

**③ proxy → client** — `tool_calls` → `tool_use` blocks; the `arguments` **string** is parsed into
an `input` **object**; `finish_reason:"tool_calls"` → `stop_reason:"tool_use"`:
```json
"content": [ { "type":"text", "text":"model → ollama:demo-model" },
             { "type":"tool_use", "id":"call_1", "name":"get_weather", "input": { "city":"Paris" } } ],
"stop_reason": "tool_use"
```

### C — the client sends the tool RESULT back

**① client → proxy**: an assistant `tool_use` block, then a user `tool_result` block.
**② proxy → upstream** splits them into OpenAI's shape:
```json
[
  { "role": "user",      "content": "weather?" },
  { "role": "assistant", "content": null,
    "tool_calls": [ { "id":"call_1", "type":"function",
                      "function": { "name":"get_weather", "arguments":"{\"city\":\"Paris\"}" } } ] },
  { "role": "tool",      "tool_call_id": "call_1", "content": "18C sunny" }
]
```
- `tool_use`   → the assistant message's **`tool_calls`** (`input` object → `arguments` string).
- `tool_result` → a separate **`role:"tool"`** message keyed by `tool_call_id`.
- Incoming `thinking` blocks are dropped; the leading `model → …` note is stripped off assistant text.

### D — streaming (Anthropic SSE the client receives)

```
event: message_start        {message:{id,role:"assistant",model,content:[],usage}}
event: ping
event: content_block_start   {index:0, content_block:{type:"text",text:""}}          ← the model-name note
event: content_block_delta   {index:0, delta:{type:"text_delta", text:"model → ollama:demo-model"}}
event: content_block_stop    {index:0}
event: content_block_start   {index:1, content_block:{type:"text",text:""}}          ← the answer
event: content_block_delta   {index:1, delta:{type:"text_delta", text:"Hi "}}
event: content_block_delta   {index:1, delta:{type:"text_delta", text:"there!"}}
event: content_block_stop    {index:1}
event: message_delta         {delta:{stop_reason:"end_turn", stop_sequence:null}, usage:{…}}
event: message_stop
```
A streaming **tool call** opens a further block `content_block_start {type:"tool_use",id,name,input:{}}`
with `input_json_delta` deltas — but only **after** its arguments have fully arrived and parsed. A
truncated call is withheld and the stream ends `stop_reason:"error"`, never a runnable `Bash({})`.

---

## Upstream = Responses API (`api: "responses"`)

Providers: openai, groq, ollama-cloud. Same scenarios; the upstream request shape differs, the
client-facing response does not.

### A — plain text turn

**② proxy → upstream** (`POST /responses`):
```json
{
  "model": "demo-model",
  "input": [ { "role":"user", "content": [ { "type":"input_text", "text":"hi" } ] } ],
  "stream": false,
  "max_output_tokens": 100,
  "instructions": "You are helpful.\n\n## Output formatting for this client\n- Math: use $...$ …"
}
```
Differences vs Chat:
- `system` → the top-level **`instructions`** field (not a message), still with the format hints appended.
- `messages` → **`input`**, with content parts `{type:"input_text"}` (user) / `{type:"output_text"}` (assistant).
- `max_tokens` → **`max_output_tokens`**.
- reasoning turns add **`reasoning: { "effort": "…" }`** (chat uses `reasoning_effort`).

Upstream returns `{ output:[{ type:"message", content:[{ type:"output_text", text:"Hi there!" }] }], usage:{ input_tokens:10, output_tokens:3 } }`.

**③ proxy → client** — identical to the Chat scenario A output (note + text, `end_turn`).

### B — the model calls a tool

**② proxy → upstream** — tools carry **`name` at the top level** (not nested under `function`):
```json
"tools": [ { "type":"function", "name":"get_weather", "description":"Weather",
             "parameters": { "type":"object", "properties":{ "city":{"type":"string"} }, "required":["city"] } } ]
```
Upstream returns `output:[{ type:"function_call", call_id:"call_1", name:"get_weather", arguments:"{\"city\":\"Paris\"}" }]`.
**③ proxy → client** — identical to Chat scenario B (`tool_use`, `stop_reason:"tool_use"`).

### C — the client sends the tool RESULT back

**② proxy → upstream** `input`:
```json
[
  { "role":"user", "content": [ { "type":"input_text", "text":"weather?" } ] },
  { "type":"function_call",        "call_id":"call_1", "name":"get_weather", "arguments":"{\"city\":\"Paris\"}" },
  { "type":"function_call_output", "call_id":"call_1", "output":"18C sunny" }
]
```
- `tool_use`   → an **`input` item** `{type:"function_call", call_id, name, arguments}`.
- `tool_result` → an **`input` item** `{type:"function_call_output", call_id, output}`.

### D — streaming

The proxy consumes these upstream events — `response.created`, `response.output_item.added`,
`response.output_text.delta`, `response.function_call_arguments.delta`, `response.output_item.done`,
`response.completed` (plus `response.reasoning_summary_*`, `response.refusal.delta`,
`response.incomplete`, `response.failed`) — and emits the **exact same Anthropic SSE sequence** as
Chat scenario D (`message_start` → `content_block_*` → `message_delta` → `message_stop`).

---

## Translation rules (summary)

| Anthropic (client)              | Chat Completions                          | Responses API                                   |
|---------------------------------|-------------------------------------------|-------------------------------------------------|
| `system`                        | `system` message (+ format hints)         | `instructions` field (+ format hints)           |
| `messages[]`                    | `messages[]`                              | `input[]`                                        |
| user text                       | `content` string / `[{type:text}]`        | `[{type:"input_text"}]`                          |
| assistant text                  | `content` string                          | `[{type:"output_text"}]`                         |
| image block                     | `[{type:"image_url", image_url}]`         | `[{type:"input_image"}]`                         |
| `tool_use` (assistant)          | `assistant.tool_calls[]`                  | `input` item `{type:"function_call"}`            |
| `tool_result` (user)            | `role:"tool"` message                     | `input` item `{type:"function_call_output"}`     |
| `tools[].input_schema`          | `tools[].function.parameters`             | `tools[].parameters` (`name` at top level)       |
| `max_tokens`                    | `max_tokens` / `max_completion_tokens`    | `max_output_tokens`                              |
| `stop_sequences`                | `stop`                                    | `stop`                                           |
| **response** `message.content`  | → `text` block                            | `output[].content[].output_text` → `text` block  |
| **response** `tool_calls`       | → `tool_use` block (`arguments`→`input`)  | `output[]` `function_call` → `tool_use` block    |
| `finish_reason` `stop`/`tool_calls` | → `end_turn` / `tool_use`             | `status`/`incomplete_details` → same             |
| `usage.prompt/completion_tokens`| → `input_tokens` / `output_tokens`        | `usage.input/output_tokens` → same               |

## Model routing (from the request's `model`)

| Requested `model`              | Routes to                                                            |
|--------------------------------|----------------------------------------------------------------------|
| `composite`                    | the ordered fallover chain; the winner answers (`composite → <winner>`) |
| `<provider>:<model>`           | that provider + its `.openai-key` key (`model → <provider>:<model>`) |
| bare / unrecognized id (e.g. `claude-sonnet-5`) | the **default provider** (`OPENAI_MODEL`) — a weak default gives an empty turn |

## Auxiliary upstream calls per turn (never shown to the client)

- **Prefix** and, for dangerous tools, **safety** classifiers — separate `/chat` or `/responses`
  calls to the classifier model, parsed for a `<block>yes/no</block>` verdict (no tools, no hints,
  no reasoning; fail-closed on overflow).
- **Compaction** — on a context-overflow `400`, one or more calls to the compaction model that
  summarize old tool results, then the turn is retried.

## Provider-specific quirks (boundary ②)

- **cloudflare** — every message `content` is flattened to a plain **string** (its schema rejects the
  array-of-parts form). Model must be tool-capable and big enough (Cloudflare hard-caps context per model).
- **gemini** — a historical `tool_use` is re-sent with `tool_calls[].extra_content.google.thought_signature`,
  round-tripped through the proxy, or gemini 400s.
- **OpenAI-only fields** (`prompt_cache_key`, `verbosity`) are sent only to `isOpenAI` providers.

## The model note

Every visible turn is prepended with a one-line **text** block naming the model that actually
answered: `model → <provider>:<model>` (single provider), `composite → <winner>` (fallover chain),
or `compaction → <model>` (a compaction summary). It is a text block — not an Anthropic `thinking`
block — because the Code-tab client requests `thinking:{display:"summarized"}`, and that mode only
renders server-summarized thinking carrying a real Anthropic signature, which a translation proxy
cannot forge. `toOpenAI` strips the note back off assistant turns on the way upstream.

---

*Captured with `openai-proxy/proxy.mjs` against a mock upstream (chat + responses). The
`model → ollama:demo-model` label reflects the test's default provider; a real turn shows the
provider you picked (`composite → cohere:…`, `model → cloudflare:@cf/qwen/qwen3.8-27b`, etc.).*
