// Read/write the launcher's dot files for the settings GUI.
//
// The one hard requirement: these files are mostly DOCUMENTATION — each carries the
// reasoning for why a setting exists and what breaks without it. So a write must replace
// only the `KEY=value` line and leave every other byte alone. Rewriting the file from the
// schema would silently delete all of that, which is why writeValues() does surgical line
// replacement and appends (with a marker comment) only when a key is genuinely absent.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const filePath = (f) => path.join(ROOT, f);

// Every parameter the launcher or the proxy actually reads. `file` is where it is persisted.
const SCHEMA = [
  { group: "Provider", file: ".provider", key: "PROVIDER", type: "enum",
    options: ["proxy", "anthropic"], default: "proxy",
    label: "Model backing the agent",
    help: "anthropic = the agent calls Anthropic directly with Claude (stock behaviour). proxy = route the agent through the local translation proxy (Anthropic Messages in, OpenAI out) to whichever upstream you choose below — OpenAI, an on-device Ollama, OpenRouter, Cohere or Gemini. A single turn can also run on any provider you hold a key for by picking a <provider>:<model> from the Code-tab model dropdown. Only the agent is affected; the chat window is always remote claude.ai." },
  { group: "Provider", file: ".provider", key: "DEFAULT_PROVIDER", type: "enum",
    options: ["openai", "local", "openrouter", "cohere", "gemini", "mistral", "groq", "ollama"], default: "openai",
    label: "Default upstream (proxy mode)",
    help: "In proxy mode, which upstream backs the DEFAULT (un-picked) turns, the background classifier and compaction. Configure each provider's model in its own group below (openai -> OpenAI model, local -> Local model, etc.) and put remote keys in .openai-key. Each turn can still route elsewhere by picking a <provider>:<model> in the Code-tab dropdown. Ignored in anthropic mode." },

  // The local (on-device) model, its own file. .local-model reuses the OPENAI_MODEL/OPENAI_API
  // keys the proxy reads, so these entries carry a distinct `key` (the unique id the GUI tracks)
  // plus a `fileKey` (the actual line written to .local-model) to avoid colliding with the
  // .openai-model group above.
  { group: "Local model", file: ".local-model", key: "LOCAL_MODEL", fileKey: "OPENAI_MODEL",
    type: "ollama", default: "", placeholder: "qwen2.5:7b-instruct",
    label: "On-device model",
    help: "The Ollama model the agent runs when PROVIDER=local. The dropdown lists models installed in Ollama (managed :11435 and system :11434); pull more with `ollama pull <name>` and reopen this window. Give a model its context with a CONTEXT_<model>=<tokens> line in .local-model — run.sh sizes the managed instance from it." },
  { group: "Local model", file: ".local-model", key: "LOCAL_API", fileKey: "OPENAI_API",
    type: "enum", options: ["chat", "responses"], default: "chat",
    label: "API surface",
    help: "Ollama's OpenAI-compatible endpoint speaks Chat Completions, so this is normally 'chat'. Chat caps tools at 128 while this app sends 200+, so some are dropped — a limit of the local server, not the proxy." },
  { group: "Local model", file: ".local-model", key: "OLLAMA_AUTOSTART", type: "bool",
    default: "1", label: "Auto-start a managed Ollama",
    help: "On: run.sh brings up its own Ollama on the managed port with the context and GPU tuning below, sharing the system Ollama's models. Off: you run and size Ollama yourself and the proxy talks to OPENAI_BASE_URL from .local-model." },
  { group: "Local model", file: ".local-model", key: "LOCAL_CONTEXT", type: "ollama-context",
    default: "32768", label: "Context window (tokens)",
    help: "Per model: the tokens the managed Ollama loads the SELECTED model with. Saved as a CONTEXT_<model> line in .local-model — run.sh reads it and it overrides the OLLAMA_CONTEXT_LENGTH default. Picking a different model above shows that model's context. Bigger costs VRAM; the q8_0 KV cache and flash attention roughly halve it." },
  { group: "Local model", file: ".local-model", key: "OLLAMA_KEEP_ALIVE", type: "text",
    default: "30m", placeholder: "30m",
    label: "Keep the model loaded for",
    help: "How long Ollama keeps the model resident after the last request (e.g. 30m, 1h, 0 to unload immediately, -1 to keep forever). run.sh also unloads it from the GPU when the app exits." },
  { group: "Local model", file: ".local-model", key: "OLLAMA_MANAGED_PORT", type: "int",
    default: "11435", label: "Managed Ollama port",
    help: "The side port run.sh runs its own Ollama on, kept off the system Ollama's 11434 so the two never fight over a bound port." },

  // OpenRouter, its own file. Like .local-model it reuses OPENAI_MODEL/OPENAI_API, so these carry a
  // distinct `key` plus a `fileKey` (the line written to .openrouter-model). The sk-or- key lives in
  // .openai-key (gitignored), not here. OPENAI_EXTRA_HEADERS is a documented .openrouter-model line,
  // not a GUI field.
  { group: "OpenRouter model", file: ".openrouter-model", key: "OPENROUTER_MODEL", fileKey: "OPENAI_MODEL",
    type: "openrouter", default: "poolside/laguna-s-2.1:free", placeholder: "vendor/model[:free]",
    label: "OpenRouter model",
    help: "Any OpenRouter model id that supports tool calling (the agent is tool calls end to end). The dropdown lists tool-capable models from openrouter.ai and flags the free (:free) ones. Free models are limited to 20 req/min and 50 req/day (1000/day with >= $10 credit) and need data-sharing enabled at openrouter.ai/settings/privacy. Put your sk-or- key in .openai-key." },
  { group: "OpenRouter model", file: ".openrouter-model", key: "OPENROUTER_API", fileKey: "OPENAI_API",
    type: "enum", options: ["chat", "responses"], default: "chat",
    label: "API surface",
    help: "chat = /chat/completions (broadest OpenRouter model support; caps tools at 128 — the app sends ~93, so it fits). responses = /responses (stateless; OpenRouter supports it per-model and it sends every tool, avoiding the 128 cap). Leave as chat unless your model needs responses." },

  // Cohere, its own file. Same OPENAI_MODEL/OPENAI_API reuse as the OpenRouter group; the Cohere key
  // lives in .openai-key (gitignored). Cohere's compatibility API is Chat Completions only, and its
  // model list is not a public catalog, so the model is a text field (not a live picker).
  { group: "Cohere model", file: ".cohere-model", key: "COHERE_MODEL", fileKey: "OPENAI_MODEL",
    type: "text", default: "command-a-03-2025", placeholder: "command-a-03-2025",
    suggestions: ["command-a-03-2025", "command-a-plus-05-2026", "command-r-plus-08-2024", "command-r7b-12-2024"],
    label: "Cohere model",
    help: "Any Cohere model id that supports tool calling (the agent is tool calls end to end) — e.g. command-a-03-2025 (default), command-a-plus-05-2026, command-r-plus-08-2024. Put your Cohere key in .openai-key. Trial keys are rate-limited (~20 req/min plus a monthly cap); a production key is recommended for agentic use." },
  { group: "Cohere model", file: ".cohere-model", key: "COHERE_API", fileKey: "OPENAI_API",
    type: "enum", options: ["chat"], default: "chat",
    label: "API surface",
    help: "Cohere's OpenAI-compatible endpoint speaks Chat Completions only (no /responses), so this is fixed at chat. Chat caps tools at 128 — the app sends ~93, so it fits." },

  // Gemini, its own file. Same OPENAI_MODEL/OPENAI_API reuse as the Cohere group; the Gemini key lives
  // in .openai-key (gitignored). Gemini's compatibility API is Chat Completions only, and its model
  // list is fetched per-key rather than a public catalog, so the model is a text field (no live picker).
  { group: "Gemini model", file: ".gemini-model", key: "GEMINI_MODEL", fileKey: "OPENAI_MODEL",
    type: "text", default: "gemini-3-flash-preview", placeholder: "gemini-3-flash-preview",
    suggestions: ["gemini-3-flash-preview", "gemini-3.6-flash", "gemini-flash-latest", "gemini-3.1-pro-preview"],
    label: "Gemini model",
    help: "Any Gemini model id that supports tool calling (the agent is tool calls end to end) — e.g. gemini-3-flash-preview (default), gemini-3.6-flash, gemini-flash-latest. gemini-2.5-flash is retired for new keys. Put your Gemini (AI Studio) key in .openai-key. Free-tier keys are rate-limited and popular models can return transient 'high demand' errors." },
  { group: "Gemini model", file: ".gemini-model", key: "GEMINI_API", fileKey: "OPENAI_API",
    type: "enum", options: ["chat"], default: "chat",
    label: "API surface",
    help: "Gemini's OpenAI-compatible endpoint speaks Chat Completions only (/responses returns 404), so this is fixed at chat. Chat caps tools at 128 — the app sends ~93, so it fits." },

  // Mistral, its own file. Same OPENAI_MODEL/OPENAI_API reuse as the Cohere/Gemini groups; the Mistral key
  // lives in .openai-key (mistralApiKey=). Mistral's OpenAI-compatible surface is Chat Completions only
  // (/responses 404s), and its model list is fetched per-key, so the model is a text field with suggestions.
  { group: "Mistral model", file: ".mistral-model", key: "MISTRAL_MODEL", fileKey: "OPENAI_MODEL",
    type: "text", default: "mistral-large-latest", placeholder: "mistral-large-latest",
    suggestions: ["mistral-large-latest", "mistral-medium-latest", "devstral-medium-latest", "codestral-latest", "magistral-medium-latest"],
    label: "Mistral model",
    help: "Any Mistral model id that supports tool calling (the agent is tool calls end to end) — e.g. mistral-large-latest (default), mistral-medium-latest, devstral-medium-latest (agentic coding), codestral-latest, magistral-medium-latest (reasoning). Put your Mistral key in .openai-key as mistralApiKey=." },
  { group: "Mistral model", file: ".mistral-model", key: "MISTRAL_API", fileKey: "OPENAI_API",
    type: "enum", options: ["chat"], default: "chat",
    label: "API surface",
    help: "Mistral's OpenAI-compatible endpoint speaks Chat Completions only (/responses 404s), so this is fixed at chat. Chat caps tools at 128 — the app sends ~93, so it fits." },

  // Groq (fast LPU inference — NOT xAI's Grok). Same OPENAI_MODEL/OPENAI_API reuse; key lives in
  // .openai-key (groqApiKey=). Groq serves BOTH /chat/completions and /responses, so the API surface is a
  // real choice — default to responses (no 128-tool cap, reasoning). Model ids can contain a "/".
  { group: "Groq model", file: ".groq-model", key: "GROQ_MODEL", fileKey: "OPENAI_MODEL",
    type: "text", default: "openai/gpt-oss-120b", placeholder: "openai/gpt-oss-120b",
    suggestions: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b", "groq/compound", "groq/compound-mini"],
    label: "Groq model",
    help: "Any Groq model id that supports tool calling (the agent is tool calls end to end) — e.g. openai/gpt-oss-120b (default), openai/gpt-oss-20b, qwen/qwen3.6-27b, groq/compound (agentic). Put your Groq key in .openai-key as groqApiKey=. Full list: GET https://api.groq.com/openai/v1/models. (This is Groq the inference cloud, not xAI's Grok.)" },
  { group: "Groq model", file: ".groq-model", key: "GROQ_API", fileKey: "OPENAI_API",
    type: "enum", options: ["responses", "chat"], default: "responses",
    label: "API surface",
    help: "Groq serves both. responses = /responses (no tool cap, reasoning) — recommended. chat = /chat/completions (caps tools at 128; the app sends ~93, so it fits). Leave as responses unless a model needs chat." },

  // Ollama Cloud (ollama.com) — REMOTE hosted models, keyed; DISTINCT from the on-device "Local model"
  // group above (which is keyless, 127.0.0.1). Key lives in .openai-key as ollamaApiKey=. Serves both
  // surfaces, so the API surface is a choice — default responses.
  { group: "Ollama Cloud model", file: ".ollama-model", key: "OLLAMA_MODEL", fileKey: "OPENAI_MODEL",
    type: "text", default: "gpt-oss:120b", placeholder: "gpt-oss:120b",
    suggestions: ["gpt-oss:120b", "gpt-oss:20b", "qwen3.5:397b", "deepseek-v4-pro:preview", "kimi-k3"],
    label: "Ollama Cloud model",
    help: "A model hosted on Ollama Cloud (ollama.com) — e.g. gpt-oss:120b (default), qwen3.5:397b, deepseek-v4-pro:preview, kimi-k3. Put your Ollama key in .openai-key as ollamaApiKey=. This is the REMOTE cloud service, not your on-device Ollama (that's the Local model group). Full list: GET https://ollama.com/v1/models with your key." },
  { group: "Ollama Cloud model", file: ".ollama-model", key: "OLLAMA_API", fileKey: "OPENAI_API",
    type: "enum", options: ["responses", "chat"], default: "responses",
    label: "API surface",
    help: "Ollama Cloud serves both. responses = /responses (no tool cap, reasoning) — recommended. chat = /chat/completions (128-tool cap). Leave as responses unless a model needs chat." },

  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_MODEL", type: "text",
    default: "gpt-5.6-sol", placeholder: "gpt-5.6-sol",
    suggestions: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.3-codex", "gpt-5.4", "gpt-4.1"],
    label: "Model", help: "Any OpenAI model id. Measured on this app's real 236-tool request: gpt-5.6-sol answered in 4-7s with a >=622k context and accepted reasoning effort 'max'; gpt-5.3-codex took 54-105s with a 272k window and steps down to 'xhigh'. Names containing 'codex' route to Responses automatically — ANY OTHER model needs the API surface below set to 'responses', or it lands on Chat Completions and 108 of the 236 tools are dropped." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_API", type: "enum",
    options: ["", "chat", "responses"], default: "responses",
    label: "API surface",
    help: "Blank = auto, which only means Responses for models with 'codex' in the name. Set it to 'responses' for anything else, including the default gpt-5.6-sol: Chat Completions caps tools at 128 and this app sends 236, so 108 get dropped, and some models refuse outright ('Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions'). Responses has no observed tool cap (probed to 512) and is the only surface with reasoning controls." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_CLASSIFIER_MODEL", type: "text",
    default: "gpt-4.1-mini", suggestions: ["gpt-4.1-mini", "gpt-5.4", "gpt-5.3-codex"],
    label: "Prefix-detection model",
    help: "For the Bash command-prefix detection call only. Latency-sensitive and low-stakes, so a small model is the point. Measured accuracy: gpt-4.1-mini 12/14, gpt-5.4 and gpt-5.3-codex 13/14." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_CLASSIFIER_SAFETY_MODEL", type: "text",
    default: "gpt-5.4-2026-03-05", suggestions: ["gpt-5.4-2026-03-05", "gpt-5.4", "", "gpt-5.3-codex"],
    placeholder: "(blank = use the main model)",
    label: "Auto-mode safety-verdict model",
    help: "Claude Code aborts its safety classifier at 60s and then DENIES the action. Measured over 27 live verdicts on the main model: median 12.2s, p90 54s, max 287s, 2 past the cliff. Replaying the four largest real prompts, gpt-5.4 answered in 1.4-3.5s vs 25-38s for gpt-5.3-codex, matched its one block and blocked one more that it allowed — faster and no more permissive. gpt-4.1 and gpt-4.1-mini were fast but allowed what codex blocked, so avoid them here. The default is the DATED SNAPSHOT of the model that was measured, not the floating gpt-5.4 alias: an alias moves, and a decision about whether a risky action runs should not change behaviour because someone else shipped. Blank = use the main model and accept the latency — which now actually works. It never did before: blank is falsy, so the old resolver walked past it to the default and you silently got gpt-5.4 instead of the main model. Whatever you set here, it is used for EVERY safety verdict; a classifier can no longer inherit a model from the picker or from the request." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_CLASSIFIER_MAX_TOOLS", type: "int",
    default: "4",
    label: "Classifier tool-count ceiling",
    help: "A classifier call is a verdict and carries no tools. Above this many tools, a prompt that matches the classifier contract is treated as a normal agent turn instead — which stops a session that merely quotes the contract from having its own turns misrouted. Raise only if a real classifier call starts being missed." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_PICKER_MODELS", type: "text",
    default: "", placeholder: "gpt-5.3-codex:GPT-5.3 Codex,gpt-5.4:GPT-5.4",
    label: "Models offered in the picker", help: "Comma-separated id:Label pairs served from the proxy's /v1/models. Blank uses the built-in list." },

  // Composite (fallback) model. OPENAI_COMPOSITE_MODELS is an ordered comma-separated member list edited by
  // the reorderable picker (type "composite"); it is stored as a single .openai-model line. The "Composite"
  // entry appears first in the Code-tab dropdown and is the default for new sessions.
  { group: "Composite model", file: ".openai-model", key: "OPENAI_COMPOSITE_MODELS", type: "composite",
    default: "", placeholder: "openai:gpt-5.6-sol,gemini:gemini-3-flash-preview,local:qwen3:8b",
    label: "Fallback chain (ordered)",
    help: "The models the 'Composite' entry tries in turn. When a turn runs on Composite — the FIRST entry in the Code-tab dropdown and the default for new sessions — the proxy calls each member until one answers, falling over on any transport/HTTP error and honoring Retry-After on 429s. Add / remove / reorder members below; each is a specific provider model you hold a key for (openai:/gemini:/cohere:/openrouter:) or a local Ollama model (local:). Empty = no Composite entry. Every OTHER model keeps its normal single-shot behaviour. Changing this restarts the proxy." },
  { group: "Composite model", file: ".openai-model", key: "OPENAI_COMPOSITE_MAX_WAIT_MS", type: "int",
    default: "30000",
    label: "Max wait when all members are rate-limited (ms)",
    help: "Fast-failover means a 429 never blocks while another member is still available. Only once EVERY member is rate-limited does the proxy wait — for the soonest member's Retry-After, capped here per-member and cumulatively — then retry. Past the cap it returns the 429 with Retry-After so the agent backs off. Default 30000 (30s)." },

  { group: "Reasoning", file: ".openai-model", key: "OPENAI_REASONING_EFFORT", type: "enum",
    options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], default: "max",
    label: "Reasoning effort",
    help: "API-wide enum; each model supports only a subset and the proxy steps down to the highest it accepts (gpt-5.3-codex and gpt-5.4 cap at xhigh; gpt-5.6-sol accepts max). Effort is billed as output and mostly invisible — one xhigh turn billed 6,791 output tokens for a 1,365-character answer." },
  { group: "Reasoning", file: ".openai-model", key: "OPENAI_SHOW_THINKING", type: "bool",
    default: "1", label: "Show the model's thinking",
    help: "Maps OpenAI reasoning summaries to Anthropic thinking blocks. Summaries only — raw chain-of-thought is not available from the API at any setting." },
  { group: "Reasoning", file: ".openai-model", key: "OPENAI_THINKING_MIN_BUDGET", type: "int",
    default: "4000", label: "Minimum budget for thinking",
    help: "Reasoning shares max_output_tokens with the answer, so thinking is only requested above this budget. Set too low and small calls (e.g. 64-token title generation) come back empty." },

  { group: "Reasoning", file: ".openai-model", key: "OPENAI_VERBOSITY", type: "enum",
    options: ["", "low", "medium", "high"], default: "high",
    label: "Output verbosity",
    help: "Native OpenAI text.verbosity. gpt-5.3-codex is terse enough that tool-calling turns came back with zero prose — a bare tool chip and no explanation (issue #1). Blank omits the parameter." },

  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_PERSISTENCE", type: "bool",
    default: "1", label: "Persistence directive",
    help: "Tells the model to finish the request before ending its turn, and not to offer to act when it can just act. Note: A/B testing could not show this changes behaviour on its own." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_AUTO_CONTINUE", type: "bool",
    default: "1", label: "Auto-continue unfinished turns",
    help: "When a turn ends announcing an action but calling no tool, the proxy re-prompts and splices the result into the same message. Measured 6/6 acted with it on vs 4/6 off. Never fires on confirmation requests for destructive actions." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_MAX_CONTINUATIONS", type: "int",
    default: "2", label: "Max continuations per turn", help: "Upper bound on the above." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_OUTPUT_FIXUPS", type: "bool",
    default: "1", label: "Output shaping (math + SVG)",
    help: "Rewrites \\(…\\) to $…$ and \\[…\\] to $$…$$ (fence-aware), and tells the model to render images with the widget tool rather than pasting raw markup." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_CLASSIFIER_SLOW_MS", type: "int",
    default: "20000", label: "Warn when a safety verdict takes this long (ms)",
    help: "Claude Code gives its auto-mode safety classifier a 60s wall-clock budget and fails CLOSED when it expires — you get \"<model> is temporarily unavailable, so auto mode cannot determine the safety of X\" and the action is denied. A verdict is about 11 output tokens, so anything near that budget means the proxy is the bottleneck. This only controls when the log warns." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_EMPTY_RETRY", type: "bool",
    default: "1", label: "Retry a turn that came back empty",
    help: "Sometimes the upstream stream ends without reporting a result — no content, no usage, no completed/incomplete event. That used to surface as a diagnostic and stall the session: send a message, wait ~40s, get nothing. It now asks again (dropping reasoning, which shortens the silent phase that gets cut). Skipped for refusals, for hard upstream errors, and for truncated turns, which have their own resume path." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_MAX_TRANSPORT_RETRIES", type: "int",
    default: "2", label: "Retries when the upstream connection drops",
    help: "A dropped socket is not an answer. undici reports one as TypeError('terminated') mid-stream, and until this existed nothing retried it: the proxy ended the turn, and the CLI could not step in because it had already been handed HTTP 200 and a partial stream — 97 turns in one log died that way. Scope is the Responses STREAMING path: retried only while NOTHING has been sent to the client yet, because past the first delta a fresh response would renumber content blocks the client already holds. A drop after that point, or one that outlives these retries, ends the turn with an explicit error event and stop_reason=error — never end_turn, and never a half-assembled tool call the agent might execute. Chat Completions streaming and the initial pre-header fetch are not covered. Never fires for an API refusal or a context-window error, which are answers rather than transport faults. 0 disables it. Separately, a dropped connection can no longer kill the proxy itself: process-level guards log it and keep serving other sessions (a read ETIMEDOUT took the whole proxy down on 08-13)." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_MAX_EMPTY_RETRIES", type: "int",
    default: "2", label: "Max empty-turn retries",
    help: "How many times to re-ask before giving up and showing the diagnostic. Each retry costs a full request, so keep it small." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_TASK_ECHO", type: "bool",
    default: "1", label: "Show the task list when it changes",
    help: "When the agent calls TaskCreate, TaskUpdate or TodoWrite, appends the actual list as a markdown checklist. The session otherwise shows only a collapsed label, and neither tool result carries the list — TaskUpdate returns just \"Updated task #3 status\". Rendered from the model's own tool arguments plus the task list the CLI puts in the transcript; never invented." },

  { group: "Claude CLI", file: ".openai-model", key: "CLAUDE_CODE_BG_CLASSIFIER_MODEL", type: "modelpicker",
    default: "gpt-4.1-mini",
    suggestions: ["gpt-4.1-mini", "groq:openai/gpt-oss-20b", "gemini:gemini-3-flash-preview", "mistral:mistral-small-latest", "cohere:command-r7b-12-2024"],
    label: "Background classifier model",
    help: "The small/fast model Claude Code uses for background classification. Pick from your providers' models (the list is your live catalog) or type any id: a bare id (e.g. gpt-4.1-mini) runs on the default upstream, while a <provider>:<model> pick routes to that provider. Prefer a small, cheap model. Forwarded to the agent in proxy mode only — it holds a non-Claude id, so Anthropic mode drops it deliberately." },
  { group: "Claude CLI", file: ".openai-model", key: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", type: "bool",
    default: "1", label: "Gateway model discovery",
    help: "Makes the app list the proxy's /v1/models in its picker. OpenAI mode only." },
  { group: "Claude CLI", file: ".openai-model", key: "OPENAI_CLAUDE_CODE_MODEL", type: "text",
    default: "claude-opus-4-8[1m]", placeholder: "claude-opus-4-8[1m]",
    label: "Claude Code internal identity",
    help: "Client capability identity, not the OpenAI answering model. In OpenAI mode the repository-owned disclaimer helper ignores whichever claude-* model Desktop selected and rewrites the bundled/cache Claude main-model argument to this value. The supported [1m] suffix activates Claude Code's 1M capability; Claude Code then strips it before /v1/messages, so the proxy receives claude-opus-4-8 and maps that normalized identity to the OpenAI Model setting. Subagents get the same identity through CLAUDE_CODE_SUBAGENT_MODEL, which the helper sets because subagents run in-process with no argv to rewrite — they were previously going out as claude-sonnet-5 with Sonnet's ordinary window, and caused 344 of 402 measured client-side compactions. Anthropic mode is an exact passthrough and injects nothing. Do not put an OpenAI model id here: proxy routing happens too late to affect the client's context resolver." },

  { group: "Output limits", file: ".openai-model", key: "OPENAI_CONTINUE_ON_TRUNCATION", type: "bool",
    default: "1", label: "Continue when cut off by the output cap",
    help: "When a turn ends truncated at max_output_tokens, the proxy resumes it and appends to the same message instead of handing back a half-finished answer (issue #8)." },
  { group: "Output limits", file: ".openai-model", key: "OPENAI_MAX_TURN_OUTPUT_TOKENS", type: "int",
    default: "56000", label: "Max total output per turn",
    help: "Ceiling on output tokens spliced into a single assistant message across continuations. Kept under the client's own per-response maximum, which reports 'Claude's response exceeded the 64000 output token maximum'." },
  { group: "Output limits", file: ".openai-model", key: "OPENAI_DEFAULT_MAX_TOKENS", type: "int",
    default: "8192", label: "Default budget when unspecified",
    help: "Used only when the client omits max_tokens. Previously inherited maxTokens=512 from ~/.dbeaver-ai-complete, a DBeaver setting, which starved such requests." },

  { group: "Compaction", file: ".openai-model", key: "OPENAI_MAX_TEXT_CHARS", type: "int",
    default: "400000", label: "Truncate an oversized message above (chars)",
    help: "Last resort when the context overflows and there are no tool results left to trim. Both compactors only touch tool results, so one giant message — a pasted log, a 300k-token document — used to make compaction give up entirely and fail the turn with no content. The largest text payload above this size is cut down, oldest first, never the most recent message, and the cut is stated in the text rather than hidden. 400000 chars is roughly 100k tokens." },
  { group: "Compaction", file: ".openai-model", key: "OPENAI_COMPACT_SUMMARY", type: "bool",
    default: "1", label: "Summarise instead of discarding",
    help: "When the context window fills, old tool output is compacted. With this on, a cheap model condenses what is being dropped into a factual digest — file paths, symbols, errors, conclusions — instead of replacing it with a placeholder. Costs one extra call per compaction and falls back to plain truncation on any failure." },
  { group: "Compaction", file: ".openai-model", key: "OPENAI_COMPACT_MODEL", type: "text",
    default: "gpt-4.1-mini", suggestions: ["gpt-4.1-mini", "gpt-4.1", "gpt-5.4"],
    label: "Summarising model",
    help: "Used only for compaction digests. Small and fast is the point; it never answers the user." },

  { group: "Privacy", file: ".privacy", key: "DISABLE_TELEMETRY", type: "bool", default: "1",
    label: "Disable all telemetry",
    help: "Three levers at once: env vars for the agent, PRIVACY_DISABLE_TELEMETRY plus bundle patches for the desktop shell (whose gates are otherwise MDM-only), and DNS sinkholing for the renderer's Datadog/Sentry and the first-party-proxied analytics hosts. Verified 0 bytes egress." },

  { group: "Compaction", file: ".openai-model", key: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", type: "int",
    default: "900000", label: "Client context upper bound (tokens)",
    help: "An upper bound, not an unconditional override: Claude Code first resolves the capability of its internal identity, then clamps this value to it. Bundled 2.1.219 resolved unsuffixed claude-opus-4-8 over localhost to 200,000, so the 900,000 setting could not prevent ordinary auto-compaction near 167,000 (200k minus the 20k output reserve and 13k compaction reserve). With the supported [1m] internal identity, this 900,000 bound yields about 880,000 tokens shown as available after the output reserve and ordinary auto-compaction near 867,000 after the additional compaction reserve. gpt-5.6-sol accepted 920,011 measured input tokens and rejected 930,000; the lower bound leaves room for its 64k maximum response. Change this with the OpenAI answering model; per-model measurements are not interchangeable. OpenAI mode only. Proxy overflow compaction is a separate fallback after an upstream context error." },

  { group: "Sessions", file: ".sync", key: "SYNC_CLAUDE_SESSIONS", type: "bool",
    default: "1", label: "Share the session store with Claude Desktop",
    help: "Makes user-data/claude-code-sessions a symlink to Claude Desktop's store, so sessions are one set of files and travel both ways instantly (issue #3). This replaced a one-way copy that let the two stores drift apart — 13 sessions existed only in the real install and 64 only here. Two consequences: this build now writes into the real install's data, and deleting a session deletes it for both apps. Unmerged sessions block the link; run scripts/merge-sessions.mjs first." },
  { group: "Sessions", file: ".sync", key: "SYNC_CLAUDE_GROUPING", type: "bool",
    default: "1", label: "Merge sidebar grouping with Claude Desktop",
    help: "Merges the claude.ai sidebar grouping between both apps, in both directions, at launch and again after quit (issue #3). The authority is dframe-store.state.customGroupsByScope — the groups, the assignments map saying which session is in which group, and the per-group order — plus the groupBy mode and starred groups. LSS-persisted.dframe-group-scopes is only a legacy mirror the app regenerates: merging into it looked like it worked, then the app relaunched and put its own value straight back. Everything else is left alone, including sidebarWidth and which groups you have collapsed. This replaced a one-way whole-directory copy that replaced all ~371 of the destination's claude.ai keys to fix 3, and that discarded the other side's work: the real install had 69 assignments and this build 61, each with some the other lacked, for a union of 71. Deletions do not propagate — remove a group in one app and the merge restores it from the other. Local Storage still cannot be shared like the session store: LevelDB allows one process at a time, so a profile is only written while its own app is closed, and skipped with a note if not; reads use a snapshot and need no lock. Backs the directory up to Local Storage.grouping-bak and verifies by reading back. Needs node and classic-level." },

  // Tools. Whether the proxy forwards specific MCP tool groups to the model. Off strips the group
  // from every request (it never reaches the model and does not eat the tool budget / context).
  { group: "Tools", file: ".openai-model", key: "PROXY_SEND_CHROME_TOOLS", type: "bool",
    default: "1", label: "Send Chrome browser tools (mcp__claude-in-chrome)",
    help: "On: forward the Claude-for-Chrome browser tools (~22 tools) to the model. Off: strip them from every request, so they don't reach the model or consume its tool budget / context. Applies to any proxy mode (openai/local/openrouter); changing it restarts the proxy." },
  { group: "Tools", file: ".openai-model", key: "PROXY_SEND_IOS_TOOLS", type: "bool",
    default: "1", label: "Send iOS Simulator tools (mcp__Claude_Code_iOS)",
    help: "On: forward the Claude Code iOS Simulator tools to the model. Off: strip them from every request. Useful for shrinking the ~40k-token tool block a small local model has to fit in its context. Changing it restarts the proxy." },
  { group: "Tools", file: ".openai-model", key: "PROXY_WEB_SEARCH", type: "bool",
    default: "1", label: "Run web search locally (DuckDuckGo)",
    help: "On: the proxy executes Claude Code's WebSearch by scraping DuckDuckGo and injecting the results, since a local model can't run Anthropic's server-side search. Off: WebSearch is left to the (unrunnable) server tool. Changing it restarts the proxy." },
  { group: "Tools", file: ".openai-model", key: "PROXY_WEB_SEARCH_PROXY", type: "text",
    default: "", placeholder: "http://host:port",
    label: "Web-search proxy (optional)",
    help: "Route the DuckDuckGo fetch through an HTTP/SOCKS proxy (e.g. http://host:port or socks5://host:port) when DuckDuckGo rate-limits your IP. Empty = direct." },

  // Diagnostics. Both live in .diagnostics, which run.sh reads and exports into the launch
  // environment — DESKTOP_LOG_LEVEL for the app, PROXY_DUMP_TOOLS for the proxy.
  { group: "Diagnostics", file: ".diagnostics", key: "DESKTOP_LOG_LEVEL", type: "enum",
    options: ["error", "warn", "info", "debug"], default: "info",
    label: "App log level",
    help: "Verbosity of the desktop app's own logs (user-data/logs-dev/main.log and the console). The app reads DESKTOP_LOG_LEVEL at launch: 'debug' logs far more, 'warn'/'error' quieten it. Default 'info'. Restart the app to apply." },
  { group: "Diagnostics", file: ".diagnostics", key: "PROXY_DUMP_TOOLS", type: "bool",
    default: "0",
    label: "Dump the tool list of each request",
    help: "When on, the proxy writes the exact tool list of every request to openai-proxy/tools-dump.txt (overwritten each request) — useful for seeing which tools, and how many, reach the local model. Only the proxy (openai/local mode) reads it. Changing it restarts the proxy." },

  // Code-mode behaviour. Also persisted in .diagnostics (run.sh reads it and exports into the app's
  // launch env). There is no CLAUDE_CODE_* env hook for ultracode, so run.sh maps this to LLMD_ULTRACODE
  // and a patch to the app's session-start (index.chunk-DT0P6tKR.js) injects ultracode:true from it.
  { group: "Code mode", file: ".diagnostics", key: "ULTRACODE_DEFAULT", type: "bool",
    default: "0",
    label: "Ultracode by default",
    help: "When on, EVERY Code-tab session starts in ultracode — xhigh effort plus standing dynamic-workflow orchestration on every turn, without typing the 'ultracode' keyword. (The composer has no ultracode toggle — that UI is served remotely by claude.ai — so this Settings switch is how you turn it on.) Requires an xhigh-capable model and workflows enabled; restart the app to apply." },

  // The Code-tab model dropdown list. An ordered reorderable list of <provider>:<model> ids injected into
  // the picker (run.sh -> LLMD_DROPDOWN_MODELS -> the renderer-unlock preload). Empty = a short built-in
  // default. Reuses the reorderable "composite" widget + /api/composite-choices.
  { group: "Code mode", file: ".diagnostics", key: "DROPDOWN_MODELS", type: "composite",
    default: "",
    label: "Code-tab dropdown models (ordered)",
    help: "Which provider models appear in the Code-tab model dropdown, and in what order — the app assigns keys 1-9 to the first selectable entries (after Composite and Claude's own models). Add / remove / reorder with the picker (OpenAI / Gemini / Cohere / OpenRouter / Mistral / Groq / Ollama Cloud, plus live on-device Ollama). Empty = a short built-in default (one flagship per keyed provider). Your on-device local thinking models are always appended after this list. Restart the app to apply." },
];

// Parse `KEY=value` lines, ignoring comments and blanks.
function readFile(f) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(filePath(f), "utf8"); } catch { return { values: out, exists: false }; }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return { values: out, exists: true };
}

// Current value of every parameter, falling back to the schema default.
function readValues() {
  const cache = {};
  const result = {};
  for (const item of SCHEMA) {
    cache[item.file] ||= readFile(item.file).values;
    const raw = cache[item.file][item.fileKey || item.key];
    result[item.key] = { value: raw === undefined ? item.default : raw, fromFile: raw !== undefined };
  }
  return result;
}

// Surgical write: replace the KEY= line in place, or append if absent. Everything else in
// the file — every comment, blank line and ordering — is preserved byte for byte.
function writeValues(updates) {
  const byFile = new Map();
  for (const [key, value] of Object.entries(updates)) {
    const item = SCHEMA.find((s) => s.key === key);
    // Per-model context lines (CONTEXT_<model>) are written straight to .local-model even though
    // they are not fixed schema keys — the model picker generates the key from the selection.
    const file = item ? item.file : (/^CONTEXT_.+/.test(key) ? ".local-model" : null);
    const fileKey = item ? (item.fileKey || item.key) : key;
    if (!file) continue;                                   // ignore unknown keys
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([fileKey, String(value)]);
  }
  const written = [];
  for (const [file, pairs] of byFile) {
    const p = filePath(file);
    let text = "";
    try { text = fs.readFileSync(p, "utf8"); } catch { text = ""; }
    const hadTrailingNewline = text.endsWith("\n") || text === "";
    let lines = text.split(/\r?\n/);
    if (hadTrailingNewline && lines[lines.length - 1] === "") lines.pop();
    for (const [key, value] of pairs) {
      const re = new RegExp(`^\\s*${key}\\s*=`);
      const idx = lines.findIndex((l) => re.test(l) && !l.trim().startsWith("#"));
      if (idx >= 0) lines[idx] = `${key}=${value}`;
      else lines.push("", `# Added by the settings window.`, `${key}=${value}`);
    }
    fs.writeFileSync(p, lines.join("\n") + "\n");
    written.push(file);
  }
  return written;
}

module.exports = { SCHEMA, ROOT, readFile, readValues, writeValues, filePath };
