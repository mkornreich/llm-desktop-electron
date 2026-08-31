// The one place that decides what the proxy is configured to do.
//
// WHY THIS EXISTS. The settings used to be forty separate expressions at the top of
// proxy.mjs, each spelling out its own precedence inline:
//
//   const VERBOSITY = process.env.OPENAI_VERBOSITY || PROJECT.OPENAI_VERBOSITY || "high";
//
// That works, and it is readable, but nothing outside the process could answer "what is
// this proxy actually running?" — so three things went wrong at once:
//
//   * run.sh reused ANY proxy that answered /health. Change a model, relaunch, and the old
//     process kept serving the old model while the launcher reported success. The config on
//     disk and the config in memory could disagree indefinitely.
//   * /health returned a default model and nothing else, so the settings window showed what
//     was CONFIGURED and called it what was RUNNING.
//   * a proxy found on the port had no identity at all. On 08-13 a crashed proxy left the
//     port free and a hand-started replacement ran as PPID 1, which is indistinguishable
//     from a foreign process to anything trying to decide whether it may restart it.
//
// So: one declarative table, one resolver, and a hash of the result. The hash is what lets
// the launcher tell "already running what I want" from "running something else".
//
// PRECEDENCE IS PRESERVED EXACTLY, NOT TIDIED. This file was extracted from the working
// expressions, quirks included, because a config refactor that also changes behaviour is
// two changes wearing one coat. Two of those quirks are real inconsistencies, marked
// QUIRK below; they are recorded here rather than fixed so that fixing them is a separate,
// visible decision with its own test.
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// The comment-preserving JSONC reader/editor is CommonJS so settings/config.js (CJS) can share it too;
// an ESM module reaches a .cjs through createRequire.
const require = createRequire(import.meta.url);
const { readConfig, CONFIG_FILE } = require("./jsonc.cjs");

// ---------- sources ----------

// KEY=VALUE, `#` comments, blank lines ignored. Identical to the parser this replaces and to
// settings/config.js's, deliberately: three parsers for one file format is how a value reads
// differently depending on who asked.
export function loadKV(path) {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* file may be absent — that's fine */ }
  return cfg;
}

export const HOME_FILE = os.homedir() + "/.dbeaver-ai-complete";
export const PROJECT_FILE = fileURLToPath(new URL("../.openai-model", import.meta.url));
export const PROVIDER_FILE = fileURLToPath(new URL("../.provider", import.meta.url));
// The secret OpenAI API key lives in its OWN file in the application folder, `.openai-key`
// (`apiKey=…`, gitignored). Kept out of the committed `.openai-model` and out of DBeaver's
// `~/.dbeaver-ai-complete`, so the key has a single, private, app-local home on every platform.
export const KEY_FILE = fileURLToPath(new URL("../.openai-key", import.meta.url));

// The consolidated config lives in one JSONC file (config.jsonc). This is the single source for every
// non-secret setting; the four KV files above are legacy (the migration removes all but .openai-key).
// Tolerant of a missing/broken file — returns {} so a fresh checkout degrades to env-vars + defaults
// rather than crashing the proxy (mirrors loadKV's forgiveness).
export function loadConfig(file = CONFIG_FILE) {
  try { return readConfig(file); } catch { return {}; }
}
export { CONFIG_FILE };
const getPath = (obj, dot) => String(dot).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ---------- types ----------
//
// Each type reproduces one of the coercion shapes used inline before. `zero` is not
// decoration: `parseInt(x, 10) || 8192` swallows both NaN AND a real 0, and the value it
// swallows to differs per setting. Spelling it out per setting is the only way to move the
// expression without moving its behaviour.
const TYPES = {
  // First non-empty source wins; `default` may itself be "".
  str: (raw, s) => (raw === undefined || raw === "" ? s.default : raw),
  // parseInt over the first non-empty source, then `|| zero`.
  int: (raw, s) => {
    const n = parseInt(raw === undefined || raw === "" ? s.default : raw, 10);
    return "zero" in s ? (n || s.zero) : n;
  },
  // "anything but the string 0 is true" — including "false", "no" and "off". That is what
  // the inline `!== "0"` meant, so that is what this means.
  bool01: (raw, s) => (raw === undefined || raw === "" ? s.default : raw) !== "0",
  // Opt-IN diagnostics: only the exact string "1" enables them.
  flag1: (raw) => raw === "1",
  // Like `str`, except an explicitly-empty value SURVIVES instead of falling through to the
  // default. Needed for exactly one setting, where blank has its own meaning ("use the main
  // model") that `||` could never express — see the safety-model entry below.
  strBlankOk: (raw, s) => (raw === undefined ? s.default : raw),
};

// ---------- the table ----------
//
// `env`      environment variable, always highest precedence
// `project`  key(s) in ./.openai-model, in order — a list where an older key name is still
//            honoured (OPENAI_MODEL then the legacy `model`)
// `keyfile`  key in ./.openai-key, the application-folder file dedicated to the secret API
//            key. Its own gitignored file — not the committed .openai-model, not DBeaver's
//            ~/.dbeaver-ai-complete. Only OPENAI_API_KEY reads from it.
// `home`     key in ~/.dbeaver-ai-complete. That file belongs to DBeaver; only the two keys
//            still listed here (`model`, `temperature`) are read from it, and `maxTokens` is
//            deliberately NOT one of them (it carries 512, which starves an agent request that
//            omits max_tokens). The API key no longer comes from here — see `keyfile`.
// `secret`   never appears in a snapshot, a log, or the hash input — only its fingerprint
// `derived`  computed from other settings; see resolve()
//
// A setting with no `project` is environment-only. That asymmetry is inherited: these are
// the wire-level and probe-level knobs that were never meant to be persisted per project,
// and the settings window does not offer them.
export const SETTINGS = [
  { name: "OPENAI_API_KEY", env: "OPENAI_API_KEY", project: ["apiKey"], keyfile: "apiKey",
    type: "str", default: "", secret: true },

  { name: "OPENAI_MODEL", env: "OPENAI_MODEL", project: ["OPENAI_MODEL", "model"], home: "model",
    type: "str", default: "gpt-4.1" },
  // Depends on OPENAI_MODEL, so it is resolved after the plain settings. Only 'codex' names
  // auto-select Responses; everything else lands on Chat Completions unless set explicitly.
  { name: "OPENAI_API", env: "OPENAI_API", project: ["OPENAI_API"], derived: true },

  { name: "OPENAI_CLASSIFIER_MODEL", env: "OPENAI_CLASSIFIER_MODEL",
    project: ["OPENAI_CLASSIFIER_MODEL"], type: "str", default: "" },
  // MEASURED, then pinned. eval/reports/safety-classifier.md replays the 14 real classifier prompts
  // through this snapshot and the alias it replaced: the decision is identical on every case, including
  // both blocks, so the pin did not move behaviour. gpt-5.4-nano allowed an action the incumbent
  // blocked, and the main model returned 8 unparseable verdicts out of 14 — neither is usable here.
  //
  // PINNED TO A SNAPSHOT, not the floating `gpt-5.4` alias. This model decides whether a risky
  // action is allowed to run, and an alias moves under you: the behaviour that was measured is
  // not necessarily the behaviour you get next month. The snapshot was verified to exist
  // (`GET /v1/models` lists gpt-5.4, gpt-5.4-2026-03-05, -mini, -nano, -pro and their
  // snapshots), because pinning an id that does not exist would 400 every verdict and the CLI
  // fails CLOSED — every risky action denied.
  //
  // `strBlankOk`: an explicitly blank value now means "use the main model and accept the
  // latency", which is what the settings help has always promised and what the previous `str`
  // type could not express — blank is falsy, so `||` walked past it to the default and you
  // silently got gpt-5.4 instead. An ABSENT setting still takes the default; only a defined,
  // empty one selects the main model. That is a measurably worse configuration (median 12.2s,
  // p90 54s, 2 of 27 past the CLI's 60s fail-closed cliff), so validate() warns about it.
  { name: "OPENAI_CLASSIFIER_SAFETY_MODEL", env: "OPENAI_CLASSIFIER_SAFETY_MODEL",
    project: ["OPENAI_CLASSIFIER_SAFETY_MODEL"], type: "strBlankOk",
    default: "gpt-5.4-2026-03-05", blankOk: true },
  // zero: 0 — "0 would be defensible" is the comment on the original, and 0 tools is a
  // coherent setting, so a literal 0 must survive rather than snapping back to 4.
  { name: "OPENAI_CLASSIFIER_MAX_TOOLS", env: "OPENAI_CLASSIFIER_MAX_TOOLS",
    project: ["OPENAI_CLASSIFIER_MAX_TOOLS"], type: "int", default: "4", zero: 0 },
  { name: "OPENAI_CLASSIFIER_SLOW_MS", env: "OPENAI_CLASSIFIER_SLOW_MS",
    project: ["OPENAI_CLASSIFIER_SLOW_MS"], type: "int", default: "20000", zero: 20000 },

  { name: "OPENAI_PICKER_MODELS", env: "OPENAI_PICKER_MODELS", project: ["OPENAI_PICKER_MODELS"],
    type: "str",
    // The answering model must be in this list or the picker cannot offer what is actually
    // running — gpt-5.6-sol was once the default while missing from here, so /v1/models
    // advertised five models, none of them the one answering.
    default: "gpt-5.6-sol:GPT-5.6 Sol,gpt-5.5:GPT-5.5,gpt-5.3-codex:GPT-5.3 Codex," +
             "gpt-5.4:GPT-5.4,gpt-4.1:GPT-4.1,gpt-4.1-mini:GPT-4.1 mini,gpt-4o:GPT-4o" },

  // Composite (fallback) model. An ordered comma-separated list of member ids the composite tries in
  // turn: when a MAIN request names the reserved id "composite", the proxy runs each member until one
  // answers, falling through on any transport/HTTP error and honoring Retry-After on 429s. Each member is
  // a "<provider>:<model>" id (openai:/gemini:/cohere:/openrouter:/local:) or a bare id (-> the default
  // provider). Empty = feature off (no composite dropdown entry, no chain). Edited by the reorderable
  // Settings picker; every OTHER model keeps its current single-shot behaviour.
  { name: "OPENAI_COMPOSITE_MODELS", env: "OPENAI_COMPOSITE_MODELS", project: ["OPENAI_COMPOSITE_MODELS"],
    type: "str", default: "" },
  // Upper bound (ms) on how long the composite waits when EVERY member is rate-limited (429). Fast-
  // failover means a 429 never blocks while another member is still available; only once the whole chain
  // is exhausted does it sleep to the soonest member's Retry-After — capped here per-member AND
  // cumulatively — then retry. Past the cap it surfaces the 429 (with Retry-After) so the agent backs off.
  { name: "OPENAI_COMPOSITE_MAX_WAIT_MS", env: "OPENAI_COMPOSITE_MAX_WAIT_MS",
    project: ["OPENAI_COMPOSITE_MAX_WAIT_MS"], type: "int", default: "30000", zero: 30000 },

  // Upper bound (ms) on how long ONE upstream member may take to send RESPONSE HEADERS (the HTTP status
  // + headers, which arrive before any streamed token). A member that connects but never responds — the
  // classic "API Error: The operation timed out" — otherwise stalls the whole turn to undici's 300s
  // default, long past the client's own timeout. This bounds it: undici throws UND_ERR_HEADERS_TIMEOUT,
  // which the composite treats as a fall-over to the NEXT model. It is time-to-HEADERS only (undici
  // clears it the instant headers arrive), so a healthy-but-slow STREAM — a reasoning model emitting for
  // minutes — is never cut; only the connect / first-response phase is capped. 0 disables it.
  { name: "OPENAI_UPSTREAM_HEADERS_TIMEOUT_MS", env: "OPENAI_UPSTREAM_HEADERS_TIMEOUT_MS",
    project: ["OPENAI_UPSTREAM_HEADERS_TIMEOUT_MS"], type: "int", default: "30000", zero: 0 },

  { name: "OPENAI_BASE_URL", env: "OPENAI_BASE_URL", type: "str",
    default: "https://api.openai.com/v1" },
  // Extra headers sent to the upstream, as comma-separated `Key:Value` pairs. Used for OpenRouter's
  // optional attribution headers (HTTP-Referer / X-Title); harmless and empty for other backends.
  { name: "OPENAI_EXTRA_HEADERS", env: "OPENAI_EXTRA_HEADERS", project: ["OPENAI_EXTRA_HEADERS"],
    type: "str", default: "" },
  { name: "PORT", env: "PORT", type: "int", default: "8123" },   // no `zero`: see resolve()

  { name: "OPENAI_DEFAULT_MAX_TOKENS", env: "OPENAI_DEFAULT_MAX_TOKENS",
    project: ["OPENAI_DEFAULT_MAX_TOKENS"], type: "int", default: "8192", zero: 8192 },
  { name: "OPENAI_MAX_OUTPUT_TOKENS", env: "OPENAI_MAX_OUTPUT_TOKENS",
    type: "int", default: "32768", zero: 32768 },
  { name: "OPENAI_MAX_TURN_OUTPUT_TOKENS", env: "OPENAI_MAX_TURN_OUTPUT_TOKENS",
    project: ["OPENAI_MAX_TURN_OUTPUT_TOKENS"], type: "int", default: "56000", zero: 56000 },
  // Chat Completions rejects a 129th tool; Responses showed no cap when probed to 512.
  { name: "OPENAI_MAX_TOOLS", env: "OPENAI_MAX_TOOLS", type: "int", default: "128", zero: 128 },
  { name: "OPENAI_MAX_TOOLS_RESPONSES", env: "OPENAI_MAX_TOOLS_RESPONSES",
    type: "int", default: "0", zero: Infinity },
  // Whether to forward specific MCP tool groups to the model. Off strips that group from every
  // request (it never reaches the model and does not eat the tool budget / context) — useful when a
  // group's schemas are large (the Chrome + iOS groups are ~40 tools between them). Default: send.
  { name: "PROXY_SEND_CHROME_TOOLS", env: "PROXY_SEND_CHROME_TOOLS",
    project: ["PROXY_SEND_CHROME_TOOLS"], type: "bool01", default: "1" },
  { name: "PROXY_SEND_IOS_TOOLS", env: "PROXY_SEND_IOS_TOOLS",
    project: ["PROXY_SEND_IOS_TOOLS"], type: "bool01", default: "1" },
  // Execute Claude Code's WebSearch locally: the proxy runs the search (DuckDuckGo) and injects the
  // results, since a local model can't run Anthropic's server-side web_search. Off = leave it broken
  // (the search sub-request just goes to the model, which can't browse). Default: on. See websearch.mjs.
  { name: "PROXY_WEB_SEARCH", env: "PROXY_WEB_SEARCH", project: ["PROXY_WEB_SEARCH"],
    type: "bool01", default: "1" },
  // Optional proxy for the web-search fetch (curl -x), e.g. http://host:port or socks5://host:port.
  // Use it when DuckDuckGo rate-limits your IP. Empty = direct.
  { name: "PROXY_WEB_SEARCH_PROXY", env: "PROXY_WEB_SEARCH_PROXY", project: ["PROXY_WEB_SEARCH_PROXY"],
    type: "str", default: "" },

  { name: "OPENAI_OUTPUT_FIXUPS", env: "OPENAI_OUTPUT_FIXUPS", project: ["OPENAI_OUTPUT_FIXUPS"],
    type: "bool01", default: "1" },
  { name: "OPENAI_PERSISTENCE", env: "OPENAI_PERSISTENCE", project: ["OPENAI_PERSISTENCE"],
    type: "bool01", default: "1" },
  { name: "OPENAI_BARE_MODE", env: "OPENAI_BARE_MODE", project: ["OPENAI_BARE_MODE"],
    type: "bool01", default: "0" },
  { name: "OPENAI_SHOW_THINKING", env: "OPENAI_SHOW_THINKING", project: ["OPENAI_SHOW_THINKING"],
    type: "bool01", default: "1" },
  // Default reasoning effort for MAIN turns, applied to every model. "high" is the ceiling every
  // OpenAI-compatible model here accepts (xhigh/max are Claude-only; the proxy self-heals a rejected
  // effort DOWN the ladder anyway, so "high" gets each model its real maximum without a per-restart
  // 400-dance). Classifier/compaction turns override this to their own (lower/none) effort.
  { name: "OPENAI_REASONING_EFFORT", env: "OPENAI_REASONING_EFFORT",
    project: ["OPENAI_REASONING_EFFORT"], type: "str", default: "high" },
  // QUIRK: default is 4000 but an explicit 0 resolves to 2000, not 4000. Preserved from the
  // original expression `parseInt(... || "4000", 10) || 2000`. Either number is defensible
  // as a floor; having two is not. Left alone here so the change is its own decision.
  { name: "OPENAI_THINKING_MIN_BUDGET", env: "OPENAI_THINKING_MIN_BUDGET",
    project: ["OPENAI_THINKING_MIN_BUDGET"], type: "int", default: "4000", zero: 2000 },
  { name: "OPENAI_VERBOSITY", env: "OPENAI_VERBOSITY", project: ["OPENAI_VERBOSITY"],
    type: "str", default: "high" },

  { name: "OPENAI_EMPTY_RETRY", env: "OPENAI_EMPTY_RETRY", project: ["OPENAI_EMPTY_RETRY"],
    type: "bool01", default: "1" },
  { name: "OPENAI_MAX_EMPTY_RETRIES", env: "OPENAI_MAX_EMPTY_RETRIES",
    project: ["OPENAI_MAX_EMPTY_RETRIES"], type: "int", default: "2", zero: 0 },
  { name: "OPENAI_CONTINUE_ON_TRUNCATION", env: "OPENAI_CONTINUE_ON_TRUNCATION",
    project: ["OPENAI_CONTINUE_ON_TRUNCATION"], type: "bool01", default: "1" },
  { name: "OPENAI_MAX_TRANSPORT_RETRIES", env: "OPENAI_MAX_TRANSPORT_RETRIES",
    project: ["OPENAI_MAX_TRANSPORT_RETRIES"], type: "int", default: "2", zero: 0 },
  { name: "OPENAI_AUTO_CONTINUE", env: "OPENAI_AUTO_CONTINUE", project: ["OPENAI_AUTO_CONTINUE"],
    type: "bool01", default: "1" },
  // QUIRK: zero 2, so OPENAI_MAX_CONTINUATIONS=0 does NOT disable auto-continue — it resolves
  // back to 2. OPENAI_AUTO_CONTINUE=0 is the off switch. Preserved from the original.
  { name: "OPENAI_MAX_CONTINUATIONS", env: "OPENAI_MAX_CONTINUATIONS",
    project: ["OPENAI_MAX_CONTINUATIONS"], type: "int", default: "2", zero: 2 },
  { name: "OPENAI_TASK_ECHO", env: "OPENAI_TASK_ECHO", project: ["OPENAI_TASK_ECHO"],
    type: "bool01", default: "1" },

  { name: "OPENAI_MAX_TEXT_CHARS", env: "OPENAI_MAX_TEXT_CHARS", project: ["OPENAI_MAX_TEXT_CHARS"],
    type: "int", default: "400000", zero: 400000 },
  { name: "OPENAI_COMPACT_SUMMARY", env: "OPENAI_COMPACT_SUMMARY",
    project: ["OPENAI_COMPACT_SUMMARY"], type: "bool01", default: "1" },
  // Falls back to the prefix-classifier model before its own default: both want "small and
  // fast", so configuring one used to configure the other. Derived for that reason.
  { name: "OPENAI_COMPACT_MODEL", env: "OPENAI_COMPACT_MODEL", project: ["OPENAI_COMPACT_MODEL"],
    derived: true },
  // Composite (fallback) COMPACTION chain: an ordered comma-separated list of "<provider>:<model>" ids the
  // summariser tries in turn (each routed to its own provider + key), falling over on any failure. The
  // summariser calls /responses, so only responses-capable providers belong here (the Settings picker
  // enforces that). Empty -> the single OPENAI_COMPACT_MODEL on the default provider (today's behaviour).
  { name: "OPENAI_COMPACT_MODELS", env: "OPENAI_COMPACT_MODELS", project: ["OPENAI_COMPACT_MODELS"],
    type: "str", default: "" },

  // Client-side capability identity and context bound. The proxy only reports these; the
  // launcher and the disclaimer helper are what apply them.
  { name: "OPENAI_CLAUDE_CODE_MODEL", env: "OPENAI_CLAUDE_CODE_MODEL",
    project: ["OPENAI_CLAUDE_CODE_MODEL"], type: "str", default: "" },
  { name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", env: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    project: ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], type: "int", default: "0", zero: 0 },

  // Diagnostics. In the hash because they change what the process does, even though nothing
  // user-visible depends on them.
  { name: "PROXY_DUMP_TOOLS", env: "PROXY_DUMP_TOOLS", type: "flag1" },
  { name: "PROXY_RECORD_SESSION", env: "PROXY_RECORD_SESSION", type: "flag1" },
  { name: "PROXY_LOG_CLASSIFIER", env: "PROXY_LOG_CLASSIFIER", type: "flag1" },
  { name: "PROXY_ASK_ON_BLOCK", env: "PROXY_ASK_ON_BLOCK", type: "flag1" },
];

const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));

// A loopback OPENAI_BASE_URL is an on-device server (Ollama etc.): it serves the OpenAI API without a
// key. Used to relax the key requirement — a missing key is fine for a local server, but an error for
// any remote endpoint (OpenRouter, Cohere, OpenAI).
export function isLocalEndpoint(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(url || "");
}
// Only OpenAI's own API serves the gpt-5.x model ids that the classifier/compaction settings default
// to. Every other upstream — a loopback local server, OpenRouter, Cohere — can only run its own models,
// so on those the auxiliary LLM calls must fall back to the model actually in use (see resolve()).
export function servesOpenAiDefaults(url) {
  return /^https?:\/\/api\.openai\.com(:|\/|$)/i.test(url || "");
}

// ---------- provider registry (BUILT from config.jsonc) ----------
//
// The OpenAI-compatible upstreams the proxy can target — defined ENTIRELY in config.jsonc `providers`
// (endpoint, api, keyNames, capabilities). Adding a provider = adding one `providers.<id>` block; nothing
// here is hardcoded per-provider. Historically single-provider (one OPENAI_BASE_URL/OPENAI_API_KEY); this
// registry is what also lets the proxy recognize other providers — resolve the default provider's key from a
// provider-named line in .openai-key, and (in proxy.mjs) aggregate each active key's models and route a
// picked "<provider>:<model>" to its own upstream. Fields per config.jsonc `providers.<id>`:
//   label      display name          keyNames  .openai-key field names, in order ("active" when one is present)
//   endpoint   OpenAI-compatible /v1  isOpenAI  send OpenAI-only fields (prompt_cache_key/verbosity)?
//   api        default surface        responses serves /responses? (compaction members must; also true if api="responses")
//   loopback   keyless on-device (local): matches any loopback host, base rediscovered at launch (LLMD_LOCAL_BASE)
//   match      OPTIONAL regex string overriding the endpoint-host matcher (rarely needed)
const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i;
// Substitute {name} tokens in a provider endpoint with values from the key file. Cloudflare's account id
// belongs in the URL path but is account-specific, so it lives in .openai-key (gitignored) beside the
// token rather than in the PUBLIC config.jsonc; `endpoint: ".../accounts/{cloudflareAccountId}/ai/v1"`
// resolves it at build/resolve time. An unknown token is left verbatim, so a missing value fails loudly
// against the literal URL rather than silently pointing somewhere wrong.
export function fillEndpoint(url, keys = {}) {
  return String(url || "").replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => keys[name] ?? m);
}
function hostMatcher(endpoint) {
  let host = "";
  try { host = new URL(endpoint).host; } catch { /* unparseable -> never matches */ }
  return host ? new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : /(?!)/;
}
export function buildProviders(config = loadConfig(), keys) {
  const out = {};
  // Only touch the key file when a provider actually templates its endpoint (Cloudflare), so the common
  // case still builds the registry without reading .openai-key.
  const K = keys ?? (Object.values(config.providers || {}).some((p) => /\{[^}]+\}/.test(p.endpoint || ""))
    ? providerKeys() : {});
  for (const [id, p] of Object.entries(config.providers || {})) {
    // The managed on-device Ollama rediscovers its base at launch (run.sh's ensure_ollama serves on a
    // DIFFERENT port than the endpoint), so LLMD_LOCAL_BASE overrides it. Keyed off the managed engine,
    // NOT the id, and NEVER applied to freetoken (whose fixed port is already its endpoint).
    const baseURL = fillEndpoint(p.managed?.engine === "ollama"
      ? (process.env.LLMD_LOCAL_BASE || p.endpoint || "http://127.0.0.1:11434/v1")
      : (p.endpoint || ""), K);
    out[id] = {
      id, label: p.label || id, baseURL,
      api: p.api || "chat",
      keyNames: Array.isArray(p.keyNames) ? p.keyNames : [],
      isOpenAI: !!p.isOpenAI,
      responses: !!p.responses,   // /responses CAPABILITY (explicit) — distinct from the default `api` surface
      // Context window (tokens), for PROACTIVE size-triggered compaction. `contextWindow` is the per-provider
      // scalar; `context`/`contextWindows` are optional model->window maps (the managed Ollama already uses
      // `context`). 0 / absent => the proxy does NOT proactively compact for this provider (reactive 413
      // compaction still backstops). Looked up by id from this registry, so it need not be threaded through
      // the trimmed member-provider objects resolvePickedProvider builds.
      contextWindow: Number(p.contextWindow) || 0,
      context: p.context || null,
      contextWindows: p.contextWindows || null,
      // Wire protocol. "openai" (default) => the proxy TRANSLATES Anthropic<->OpenAI for this provider
      // (the historic behaviour). "anthropic" => PASS-THROUGH: the provider natively speaks the Anthropic
      // Messages API, so the proxy forwards /v1/messages almost verbatim (model swap + auth), skipping the
      // toOpenAI/toAnthropic round-trip. `anthropicEndpoint` is the ANTHROPIC_BASE_URL (the proxy appends
      // /v1/messages) — required when protocol is "anthropic". Leaving protocol unset keeps OpenAI mode.
      protocol: p.protocol === "anthropic" ? "anthropic" : "openai",
      anthropicEndpoint: fillEndpoint(p.anthropicEndpoint || "", K) || "",
      // Optional per-provider reasoning directive merged into the request. Mainly for pass-through
      // providers (whose body bypasses the proxy's own reasoning-effort injection): e.g. OpenRouter
      // honours a top-level {effort:"high"} on its Anthropic endpoint to force a model's reasoning.
      reasoning: (p.reasoning && typeof p.reasoning === "object") ? p.reasoning : null,
      loopback: !!p.loopback,     // keyless on-device server — exposed so callers key off the flag, not the id
      managed: p.managed || null, // the launcher's autostart block (engine/port/launch/...), or null
      // Curated model allowlist. When non-empty it is the ONLY set of this provider's models offered to
      // the UI — both the Settings pickers (settings/*) and gateway model discovery (GET /v1/models),
      // which otherwise advertises the provider's WHOLE live catalog. Set for openrouter (its catalog is
      // ~400 models, most unusable on the key); empty for everyone else, so they still expose everything.
      suggestions: Array.isArray(p.suggestions) ? p.suggestions : [],
      match: p.match ? new RegExp(p.match, "i") : (p.loopback ? LOOPBACK_RE : hostMatcher(baseURL)),
    };
  }
  return out;
}
export const PROVIDERS = buildProviders();

// Providers that serve the OpenAI Responses API (/responses) — a compaction-chain member must be one, and
// the settings picker's responses-only filter mirrors this. Derived from each provider's `responses` flag.
export const RESPONSES_PROVIDER_IDS = new Set(Object.values(PROVIDERS).filter((p) => p.responses).map((p) => p.id));
// Models that CANNOT do tool calling, so they must never serve an agent turn, sit in a fallback chain, or
// be offered as a selectable model. groq's "compound" systems are agentic pipelines that reject a `tools`
// array outright ("tool calling is not supported with this model"), and an agent turn always carries tools —
// so a chain member that is one is a guaranteed-dead slot. Evidence-based (probed against each provider's
// API); extend the patterns as more surface. Matched against the model segment of a `<provider>:<model>` id
// AND the whole id. Mirrored verbatim in settings/server.js (CommonJS — cannot import this ESM module).
export const NON_TOOL_MODEL_RES = [/(^|[:/])compound(-mini)?$/i];
export function isNonToolModel(id) {
  const s = String(id || "");
  const model = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
  return NON_TOOL_MODEL_RES.some((re) => re.test(model) || re.test(s));
}
// The registry entry whose host matches this base URL, or null (loopback / unknown host).
export function providerForBase(url) {
  return Object.values(PROVIDERS).find((p) => p.match.test(String(url || ""))) || null;
}
// The keys present in .openai-key, as { <keyName>: value }. Every named key, verbatim (loadKV).
export function providerKeys(keyfile) {
  return keyfile ?? loadKV(KEY_FILE);
}
// Registry providers that have a usable key in .openai-key — the ones to advertise/route.
export function activeProviders(keyfile) {
  const K = providerKeys(keyfile);
  return Object.values(PROVIDERS).filter((p) => p.keyNames.some((n) => K[n]));
}

// ---------- config.jsonc path map ----------
//
// Where each SETTING lives in config.jsonc. A string is a dot-path; `{ field }` reads the ACTIVE
// provider's sub-field (providers.<defaultProvider>.<field>) so OPENAI_MODEL/API/BASE_URL/… follow the
// selected provider. OPENAI_API_KEY has no entry — it is the one secret, read only from .openai-key.
// This map + `toRaw` are the whole bridge from the JSONC's native types to the string-based resolver;
// everything downstream (TYPES coercion, precedence, configHash) is byte-identical to the KV-file era.
const PATHS = {
  OPENAI_MODEL: { field: "model" }, OPENAI_API: { field: "api" }, OPENAI_BASE_URL: { field: "endpoint" },
  OPENAI_CLAUDE_CODE_MODEL: { field: "claudeCodeModel" }, OPENAI_EXTRA_HEADERS: { field: "extraHeaders" },
  OPENAI_CLASSIFIER_MODEL: "classifier.prefix", OPENAI_CLASSIFIER_SAFETY_MODEL: "classifier.safety",
  OPENAI_CLASSIFIER_MAX_TOOLS: "classifier.maxTools", OPENAI_CLASSIFIER_SLOW_MS: "classifier.slowMs",
  OPENAI_PICKER_MODELS: "picker.models",
  OPENAI_COMPOSITE_MODELS: "composite", OPENAI_COMPOSITE_MAX_WAIT_MS: "compositeMaxWaitMs",
  OPENAI_UPSTREAM_HEADERS_TIMEOUT_MS: "upstreamHeadersTimeoutMs",
  OPENAI_COMPACT_MODELS: "compact", OPENAI_COMPACT_MODEL: "compaction.model",
  OPENAI_COMPACT_SUMMARY: "compaction.summary", OPENAI_MAX_TEXT_CHARS: "compaction.maxTextChars",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "compaction.autoCompactWindow",
  OPENAI_DEFAULT_MAX_TOKENS: "output.defaultMaxTokens", OPENAI_MAX_OUTPUT_TOKENS: "output.maxOutputTokens",
  OPENAI_MAX_TURN_OUTPUT_TOKENS: "output.maxTurnOutputTokens", OPENAI_CONTINUE_ON_TRUNCATION: "output.continueOnTruncation",
  OPENAI_MAX_TRANSPORT_RETRIES: "output.maxTransportRetries", OPENAI_EMPTY_RETRY: "output.emptyRetry",
  OPENAI_MAX_EMPTY_RETRIES: "output.maxEmptyRetries",
  OPENAI_PERSISTENCE: "agent.persistence", OPENAI_AUTO_CONTINUE: "agent.autoContinue",
  OPENAI_MAX_CONTINUATIONS: "agent.maxContinuations", OPENAI_OUTPUT_FIXUPS: "agent.outputFixups",
  OPENAI_TASK_ECHO: "agent.taskEcho", OPENAI_BARE_MODE: "agent.bareMode",
  OPENAI_SHOW_THINKING: "reasoning.showThinking", OPENAI_REASONING_EFFORT: "reasoning.effort",
  OPENAI_THINKING_MIN_BUDGET: "reasoning.minBudget", OPENAI_VERBOSITY: "reasoning.verbosity",
  PROXY_SEND_CHROME_TOOLS: "tools.sendChromeTools", PROXY_SEND_IOS_TOOLS: "tools.sendIosTools",
  PROXY_WEB_SEARCH: "tools.webSearch", PROXY_WEB_SEARCH_PROXY: "tools.webSearchProxy",
  PORT: "advanced.port", OPENAI_MAX_TOOLS: "advanced.maxTools", OPENAI_MAX_TOOLS_RESPONSES: "advanced.maxToolsResponses",
  PROXY_DUMP_TOOLS: "diagnostics.dumpTools",
  PROXY_RECORD_SESSION: "diagnostics.recordSession",
  PROXY_LOG_CLASSIFIER: "diagnostics.logClassifier",
  PROXY_ASK_ON_BLOCK: "classifier.askOnBlock",
};

// A config.jsonc value (native JSON type) rendered back into the KV-string form the TYPES coercions
// expect: boolean -> "1"/"0", array -> comma-joined, number -> its digits. `undefined`/`null` mean
// "not set" so precedence falls through, exactly like an absent KV line.
function toRaw(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Array.isArray(v)) return v.join(",");
  return String(v);
}

// ---------- resolution ----------

// Returns { values, sources } where sources[name] is
// "env" | "project" | "keyfile" | "home" | "default", so a snapshot can say WHERE a value came
// from. That distinction is the whole point of item 6 of the phase: a one-launch
// `OPENAI_MODEL=x ./run.sh` override and a persisted setting look identical in the resolved
// value and could not be told apart before.
export function resolve({ env = process.env, config, project, home, keyfile } = {}) {
  const C = config ?? loadConfig();
  const P = project ?? {};   // explicit flat override by file-key (tests, and any precise caller); NOT a file
  const H = home ?? loadKV(HOME_FILE);
  const K = keyfile ?? loadKV(KEY_FILE);
  // Which provider backs the active/main turns — its sub-block feeds OPENAI_MODEL/API/BASE_URL/…
  let dp = env.DEFAULT_PROVIDER || C.defaultProvider || "openai";
  // On-device engine toggle: when the default is a managed on-device engine, the ACTIVE one is whichever
  // onDeviceEngine selects, so the toggle switches the default's model/base/api. Env override still wins.
  if (!env.DEFAULT_PROVIDER && C.onDeviceEngine && C.providers?.[dp]?.managed && C.providers?.[C.onDeviceEngine]?.managed) dp = C.onDeviceEngine;
  const values = {};
  const sources = {};

  // The config.jsonc value for this setting, rendered to KV-string form (or undefined when unset).
  const cfgRaw = (s) => {
    const p = PATHS[s.name];
    if (!p) return undefined;
    return toRaw(typeof p === "object" ? getPath(C, `providers.${dp}.${p.field}`) : getPath(C, p));
  };

  // First non-empty wins: env > config.jsonc > keyfile (secret only) > home > default. Empty string
  // counts as absent, matching `||` — EXCEPT where the setting opts into `blankOk`, for which a
  // defined-but-empty value is a real choice and must not be confused with having said nothing.
  const pick = (s) => {
    const usable = (v) => v !== undefined && (s.blankOk || v !== "");
    if (s.env && usable(env[s.env])) return [env[s.env], "env"];
    for (const k of s.project || []) { if (usable(P[k])) return [P[k], "project"]; }
    const c = cfgRaw(s);
    if (usable(c)) return [c, "config"];
    if (s.keyfile && usable(K[s.keyfile])) return [K[s.keyfile], "keyfile"];
    if (s.home && usable(H[s.home])) return [H[s.home], "home"];
    return [undefined, "default"];
  };

  for (const s of SETTINGS) {
    if (s.derived) continue;
    const [raw, src] = pick(s);
    values[s.name] = TYPES[s.type](raw, s);
    sources[s.name] = src;
  }

  // PORT has no `zero`, on purpose: the original `parseInt(process.env.PORT || "8123", 10)`
  // had no fallback either, so PORT=abc yields NaN and the listen fails loudly. Silently
  // serving on 8123 when asked for something else is worse — that is how you end up with two
  // proxies and a launcher that trusts the wrong one.
  // Fill any {name} tokens (e.g. Cloudflare's {cloudflareAccountId}) from the key file before anything
  // downstream — providerForBase below, the config hash, and the proxy — sees the base URL.
  values.OPENAI_BASE_URL = fillEndpoint(values.OPENAI_BASE_URL, K).replace(/\/$/, "");

  // The key file may hold provider-named keys (googleApiKey, cohereApiKey, …) rather than the generic
  // `apiKey`. If OPENAI_API_KEY did not resolve above, fill it from the DEFAULT provider's keyName —
  // the default provider is the registry entry whose host matches OPENAI_BASE_URL. Env/`apiKey` still
  // win (they resolve in the loop above); this only covers the named-key case.
  if (!values.OPENAI_API_KEY && !isLocalEndpoint(values.OPENAI_BASE_URL)) {
    const dp = providerForBase(values.OPENAI_BASE_URL);
    for (const kn of dp?.keyNames || []) {
      if (K[kn]) { values.OPENAI_API_KEY = K[kn]; sources.OPENAI_API_KEY = "keyfile:" + kn; break; }
    }
  }

  // Derived, in dependency order.
  const [apiRaw, apiSrc] = pick(BY_NAME.get("OPENAI_API"));
  values.OPENAI_API = (apiRaw || (/codex/i.test(values.OPENAI_MODEL) ? "responses" : "chat"))
    .toLowerCase();
  sources.OPENAI_API = apiRaw ? apiSrc : "derived";

  const [cmRaw, cmSrc] = pick(BY_NAME.get("OPENAI_COMPACT_MODEL"));
  values.OPENAI_COMPACT_MODEL = cmRaw || values.OPENAI_CLASSIFIER_MODEL || "gpt-4.1-mini";
  sources.OPENAI_COMPACT_MODEL = cmRaw ? cmSrc
    : values.OPENAI_CLASSIFIER_MODEL ? "OPENAI_CLASSIFIER_MODEL" : "default";

  // Unless the upstream is OpenAI's own API, the classifier/compaction settings' remote gpt-5.x
  // defaults (and any BARE value carried over from .openai-model) point at models the upstream cannot
  // serve — so every prefix/safety verdict and compaction call would 404 ("auto mode cannot determine
  // the safety of …"). On a local server, OpenRouter or Cohere, default those auxiliary calls to the
  // model actually in use. Two things are respected and NOT clobbered: an explicit env override (a
  // smaller/cheaper classifier), and an explicit "<provider>:<model>" pick — the proxy resolves a classifier
  // model's provider prefix now, so e.g. local:qwen3:1.7b or groq:… routes to THAT provider and is servable.
  // Only a bare id (no known provider prefix), which would hit this non-OpenAI default upstream, is rewritten.
  if (!servesOpenAiDefaults(values.OPENAI_BASE_URL)) {
    for (const name of ["OPENAI_CLASSIFIER_MODEL", "OPENAI_CLASSIFIER_SAFETY_MODEL", "OPENAI_COMPACT_MODEL"]) {
      if (sources[name] === "env") continue;                        // an explicit env override always wins
      const v = values[name], i = typeof v === "string" ? v.indexOf(":") : -1;
      if (i > 0 && PROVIDERS[v.slice(0, i)]) continue;              // routable <provider>:<model> pick -> keep it
      values[name] = values.OPENAI_MODEL;
      sources[name] = "non-openai upstream -> model in use";
    }
  }

  // ~/.dbeaver-ai-complete only. Absent means "send no temperature", which is not the same
  // as sending 0, so undefined has to survive.
  values.DEFAULT_TEMP = H.temperature != null ? parseFloat(H.temperature) : undefined;
  sources.DEFAULT_TEMP = H.temperature != null ? "home" : "default";

  return { values, sources };
}

// One-way fingerprint. Enough to tell "the key changed" from "the key is the same", and not
// enough to be a key. Truncated to 12 hex characters for a log line; the input is a
// high-entropy secret, so this is not a guessable digest.
export function keyFingerprint(key) {
  if (!key) return "none";
  return "sha256:" + crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
}

// Version of the CODE, not the config. A proxy running last week's translation logic with
// this week's settings is stale even though every value matches, so the launcher has to be
// able to see that. Hashing the sources is exact and needs no version bumping by hand —
// which is the point, because a version constant nobody remembers to bump reports stale
// code as current.
let codeVersionMemo = null;
export function codeVersion() {
  if (codeVersionMemo) return codeVersionMemo;
  const h = crypto.createHash("sha256");
  for (const f of ["./proxy.mjs", "./config.mjs"]) {
    try { h.update(fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)))); }
    catch { h.update(f); }   // unreadable source still yields a stable, distinct version
  }
  return (codeVersionMemo = h.digest("hex").slice(0, 12));
}

export function provider(cfg) {
  const C = cfg ?? loadConfig();
  return process.env.PROVIDER || C.mode || "proxy";
}

// A secret-redacted description of what this process will do. Safe to log, to serve from
// /health, and to show in the settings window.
export function snapshot(opts = {}) {
  const { values, sources } = opts.resolved || resolve(opts);
  const out = { provider: provider(), codeVersion: codeVersion(), settings: {} };
  for (const s of SETTINGS) {
    if (s.secret) continue;
    out.settings[s.name] = { value: values[s.name], source: sources[s.name] };
  }
  out.settings.DEFAULT_TEMP = { value: values.DEFAULT_TEMP, source: sources.DEFAULT_TEMP };
  out.apiKeyFingerprint = keyFingerprint(values.OPENAI_API_KEY);
  return out;
}

// Stable hash over everything that changes behaviour. Two proxies with the same hash are
// interchangeable; a different hash means the one on the port is not the one you asked for.
//
// The KEY ITSELF IS NEVER HASHED IN — its fingerprint is. A rotated key must invalidate the
// hash (otherwise the launcher keeps a proxy holding a revoked key), but the hash is printed
// in logs and served over HTTP, so it must not be a function of the secret. A sha256 of the
// key is not reversible; a sha256 of a structure containing the key would still be safe, but
// only by argument, and "safe by argument" is how secrets leak.
export function configHash(opts = {}) {
  const { values } = opts.resolved || resolve(opts);
  const material = { provider: provider(), codeVersion: codeVersion() };
  for (const s of SETTINGS) {
    material[s.name] = s.secret ? keyFingerprint(values[s.name])
      : values[s.name] === Infinity ? "Infinity"          // JSON.stringify would emit null
      : values[s.name];
  }
  material.DEFAULT_TEMP = values.DEFAULT_TEMP ?? null;
  return crypto.createHash("sha256")
    .update(JSON.stringify(material, Object.keys(material).sort()))
    .digest("hex").slice(0, 16);
}

// ---------- validation ----------
//
// Item 7 of the phase. Range and cross-field checks, returned rather than thrown: the proxy
// logs them and keeps going where it safely can, while the settings window refuses the write.
// A config that cannot work should say so at startup, not as a 400 an hour later.
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const APIS = ["chat", "responses"];
const VERBOSITIES = ["", "low", "medium", "high"];

export function validate(opts = {}) {
  const { values } = opts.resolved || resolve(opts);
  const errors = [];
  const warnings = [];
  const v = values;

  if (!Number.isInteger(v.PORT) || v.PORT < 1 || v.PORT > 65535)
    errors.push(`PORT must be 1-65535, got ${v.PORT}`);
  if (!APIS.includes(v.OPENAI_API))
    errors.push(`OPENAI_API must be one of ${APIS.join("|")}, got '${v.OPENAI_API}'`);
  if (!EFFORTS.includes(v.OPENAI_REASONING_EFFORT))
    errors.push(`OPENAI_REASONING_EFFORT must be one of ${EFFORTS.join("|")}, got '${v.OPENAI_REASONING_EFFORT}'`);
  if (!VERBOSITIES.includes(v.OPENAI_VERBOSITY))
    errors.push(`OPENAI_VERBOSITY must be one of ${VERBOSITIES.filter(Boolean).join("|")} or blank, got '${v.OPENAI_VERBOSITY}'`);
  if (!v.OPENAI_MODEL) errors.push("OPENAI_MODEL is empty");
  try { new URL(v.OPENAI_BASE_URL); } catch { errors.push(`OPENAI_BASE_URL is not a URL: '${v.OPENAI_BASE_URL}'`); }

  for (const k of ["OPENAI_MAX_TRANSPORT_RETRIES", "OPENAI_MAX_EMPTY_RETRIES",
                   "OPENAI_MAX_CONTINUATIONS", "OPENAI_CLASSIFIER_MAX_TOOLS"]) {
    if (v[k] < 0) errors.push(`${k} must be >= 0, got ${v[k]}`);
    if (v[k] > 100) warnings.push(`${k}=${v[k]} is unusually high; each unit can cost a full request`);
  }
  for (const k of ["OPENAI_DEFAULT_MAX_TOKENS", "OPENAI_MAX_OUTPUT_TOKENS",
                   "OPENAI_MAX_TURN_OUTPUT_TOKENS", "OPENAI_MAX_TEXT_CHARS"]) {
    if (!(v[k] > 0)) errors.push(`${k} must be > 0, got ${v[k]}`);
  }

  // Cross-field. Each of these is a configuration that parses fine and then misbehaves in a
  // way that is hard to attribute from the symptom.
  if (v.OPENAI_MAX_TURN_OUTPUT_TOKENS < v.OPENAI_MAX_OUTPUT_TOKENS)
    warnings.push(`OPENAI_MAX_TURN_OUTPUT_TOKENS (${v.OPENAI_MAX_TURN_OUTPUT_TOKENS}) is below the ` +
      `single-call cap OPENAI_MAX_OUTPUT_TOKENS (${v.OPENAI_MAX_OUTPUT_TOKENS}), so one call can exceed the turn budget`);
  if (v.OPENAI_DEFAULT_MAX_TOKENS > v.OPENAI_MAX_OUTPUT_TOKENS)
    warnings.push(`OPENAI_DEFAULT_MAX_TOKENS (${v.OPENAI_DEFAULT_MAX_TOKENS}) exceeds ` +
      `OPENAI_MAX_OUTPUT_TOKENS (${v.OPENAI_MAX_OUTPUT_TOKENS}) and will be clamped`);
  if (v.OPENAI_THINKING_MIN_BUDGET >= v.OPENAI_MAX_OUTPUT_TOKENS && v.OPENAI_SHOW_THINKING)
    warnings.push(`OPENAI_THINKING_MIN_BUDGET (${v.OPENAI_THINKING_MIN_BUDGET}) is at or above ` +
      `OPENAI_MAX_OUTPUT_TOKENS (${v.OPENAI_MAX_OUTPUT_TOKENS}), so thinking will never be requested`);
  // The measured failure this guards: Chat Completions caps tools at 128 while the app sends
  // 236, so 108 tools vanish and the model narrates work it cannot do.
  if (v.OPENAI_API === "chat" && !/codex/i.test(v.OPENAI_MODEL))
    warnings.push(`OPENAI_API=chat drops tools above ${v.OPENAI_MAX_TOOLS}; this app sends over 200. ` +
      `Set OPENAI_API=responses unless you specifically need Chat Completions`);
  // Blank is legal and documented, and it is also the configuration measured to miss the CLI's
  // deadline. Saying so is the difference between a choice and an accident.
  if (v.OPENAI_CLASSIFIER_SAFETY_MODEL === "" && servesOpenAiDefaults(v.OPENAI_BASE_URL))
    // Re-measured against the real classifier corpus (eval/reports/safety-classifier.md). The old
    // warning blamed LATENCY, from figures taken on gpt-5.3-codex. On today's main model latency is
    // fine — p50 2.4s, p95 6.1s, nothing near the deadline — but 8 of 14 verdicts came back
    // UNPARSEABLE. Blank is not "slower", it is a model that mostly fails to answer the contract, and
    // every failure is a retry-then-deny for the user.
    warnings.push(`OPENAI_CLASSIFIER_SAFETY_MODEL is blank, so auto-mode safety verdicts run on ` +
      `the main model (${v.OPENAI_MODEL}). Measured on the real classifier corpus: 8 of 14 verdicts ` +
      `were UNPARSEABLE (57%), which the CLI treats as no verdict — it retries and then DENIES the ` +
      `action. Latency was not the problem (p50 2.4s). See eval/reports/safety-classifier.md`);
  if (v.OPENAI_CLASSIFIER_SLOW_MS >= 60000)
    warnings.push(`OPENAI_CLASSIFIER_SLOW_MS=${v.OPENAI_CLASSIFIER_SLOW_MS} is at or past the CLI's ` +
      `60s fail-closed classifier deadline, so the warning can never fire before the denial`);
  // A loopback OPENAI_BASE_URL is an on-device server (Ollama etc.) that serves the OpenAI API
  // without a key, so a missing key there is fine — mirrors the proxy's own startup gate.
  if (!v.OPENAI_API_KEY && !isLocalEndpoint(v.OPENAI_BASE_URL)) errors.push(`no OpenAI API key (checked OPENAI_API_KEY, .openai-model, .openai-key)`);

  // Composite members: a member whose provider is unknown, or a remote provider with no key in
  // .openai-key, is skipped at runtime rather than failing the config — warn so it is not a silent drop.
  // A bare id (no "<provider>:") targets the default provider and is always usable; `local:` is keyless.
  if (v.OPENAI_COMPOSITE_MODELS) {
    const active = new Set(activeProviders(opts.keyfile).map((p) => p.id));
    for (const id of v.OPENAI_COMPOSITE_MODELS.split(",").map((s) => s.trim()).filter(Boolean)) {
      const i = id.indexOf(":");
      if (i <= 0) continue;
      const prov = id.slice(0, i);
      if (isNonToolModel(id)) warnings.push(`composite member '${id}' cannot do tool calling — it will be skipped (an agent turn always carries tools)`);
      else if (!PROVIDERS[prov]) warnings.push(`composite member '${id}' names an unknown provider '${prov}' — it will be skipped`);
      else if (PROVIDERS[prov].keyNames.length > 0 && !active.has(prov)) warnings.push(`composite member '${id}' needs a ${prov} key in .openai-key — it will be skipped until one is present`);
    }
  }

  // Compaction chain members: like the composite, plus each must serve /responses (the summariser calls it).
  if (v.OPENAI_COMPACT_MODELS) {
    const active = new Set(activeProviders(opts.keyfile).map((p) => p.id));
    for (const id of v.OPENAI_COMPACT_MODELS.split(",").map((s) => s.trim()).filter(Boolean)) {
      const i = id.indexOf(":");
      if (i <= 0) continue;
      const prov = id.slice(0, i);
      if (isNonToolModel(id)) warnings.push(`compaction member '${id}' cannot do tool calling — it will be skipped`);
      else if (!PROVIDERS[prov]) warnings.push(`compaction member '${id}' names an unknown provider '${prov}' — it will be skipped`);
      else if (PROVIDERS[prov].keyNames.length > 0 && !active.has(prov)) warnings.push(`compaction member '${id}' needs a ${prov} key in .openai-key — it will be skipped until one is present`);
      else if (!RESPONSES_PROVIDER_IDS.has(prov)) warnings.push(`compaction member '${id}' uses '${prov}', which does not serve /responses — the summariser will fail over past it`);
    }
  }

  return { errors, warnings };
}

// ---------- env emitter (for run.sh) ----------
//
// The STATIC config->env mapping that used to be ~400 lines of bash provider branching. run.sh evals
// this, then layers on ONLY the genuinely-dynamic bits it cannot precompute: managed-Ollama discovery
// (which overrides OPENAI_BASE_URL / LLMD_LOCAL_BASE), the live local thinking-model list, and the app
// launch. An env var already set still wins (the resolver honoured it), so `OPENAI_MODEL=x ./run.sh`
// one-launch overrides keep working. Emits shell-safe single-quoted `export` lines.
export function emitEnv({ env = process.env } = {}) {
  const C = loadConfig();
  const { values: v } = resolve({ env });
  let mode = env.PROVIDER || C.mode || "proxy";
  let dp = env.DEFAULT_PROVIDER || C.defaultProvider || "openai";
  // Back-compat: a legacy provider-name mode (e.g. PROVIDER=cohere) selects proxy mode with that upstream.
  // Derived from the registry, so a new provider needs no edit here.
  if (PROVIDERS[mode]) { dp = mode; mode = "proxy"; }
  // On-device engine toggle (mirrors resolve()): the selected managed engine drives the default
  // provider, the classifier's provider, which engine autostarts, and which engine's models the
  // Code-tab dropdown shows. swapEngine() re-points an on-device "<engine>:<model>" at the active one.
  const onDev = C.onDeviceEngine;
  if (!env.DEFAULT_PROVIDER && onDev && C.providers?.[dp]?.managed && C.providers?.[onDev]?.managed) dp = onDev;
  const swapEngine = (val) => {
    const i = String(val || "").indexOf(":"); const prov = i > 0 ? String(val).slice(0, i) : "";
    return (onDev && prov !== onDev && C.providers?.[prov]?.managed && C.providers?.[onDev]?.managed) ? `${onDev}${String(val).slice(i)}` : val;
  };
  // A classifier model may be a fallover CHAIN (a config.jsonc array or a comma-separated string): swap
  // each member's on-device engine independently and rejoin. A single value round-trips unchanged; a
  // blank collapses to "" (so putIf drops it and the blank-safety -> main-model behaviour is kept).
  const swapEngineList = (val) =>
    (Array.isArray(val) ? val : String(val ?? "").split(",")).map((s) => swapEngine(String(s).trim())).filter((s) => s !== "").join(",");
  const out = [];
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const put = (k, val) => out.push(`export ${k}=${q(val)}`);
  const putIf = (k, val) => { if (val !== undefined && val !== null && val !== "") put(k, val); };
  const has = (p) => { const x = getPath(C, p); return x !== undefined && x !== null && x !== ""; };

  // Helper vars run.sh branches on (which provider, which mode, which port).
  put("LLMD_MODE", mode);
  put("LLMD_DEFAULT_PROVIDER", dp);
  put("LLMD_PORT", v.PORT);
  // Which managed on-device engine is active. run.sh gates the on-device Ollama model discovery on this:
  // it auto-populates the Code-tab picker with `local:<model>` entries only in ollama mode, never in
  // freetoken mode (there the picker shows the curated freetoken entry, not the whole Ollama library).
  putIf("LLMD_ON_DEVICE_ENGINE", onDev);

  // Both modes.
  put("CLAUDE_CODE_MAX_OUTPUT_TOKENS", env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || getPath(C, "claudeCode.maxOutputTokens") || 64000);
  put("CLAUDE_CODE_EFFORT_LEVEL", env.CLAUDE_CODE_EFFORT_LEVEL || "max");
  put("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT || "1");
  putIf("DESKTOP_LOG_LEVEL", getPath(C, "diagnostics.logLevel"));
  if (getPath(C, "diagnostics.dumpTools")) put("PROXY_DUMP_TOOLS", "1");
  if (getPath(C, "diagnostics.recordSession")) put("PROXY_RECORD_SESSION", "1");
  if (getPath(C, "diagnostics.logClassifier")) put("PROXY_LOG_CLASSIFIER", "1");
  if (getPath(C, "classifier.askOnBlock")) put("PROXY_ASK_ON_BLOCK", "1");
  if (getPath(C, "diagnostics.ultracode")) put("LLMD_ULTRACODE", "1");
  let dd = getPath(C, "picker.dropdownModels");
  if (Array.isArray(dd) && dd.length) {
    // Hide the DISABLED on-device engine's models — the GPU runs only the one onDeviceEngine selects.
    if (onDev && C.providers?.[onDev]?.managed) {
      const hidden = Object.keys(C.providers).filter((id) => C.providers[id].managed && id !== onDev);
      dd = dd.filter((m) => !hidden.some((h) => String(m).startsWith(h + ":")));
    }
    put("LLMD_DROPDOWN_MODELS", JSON.stringify(dd));
  }
  if (getPath(C, "privacy.disableTelemetry"))
    for (const k of ["DISABLE_TELEMETRY", "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "PRIVACY_DISABLE_TELEMETRY"]) put(k, "1");
  // Session sync gates (run.sh reads these). Always emit 0/1 so run.sh's ${SYNC_*:-…} never falls through
  // to a (now-removed) .sync read.
  put("SYNC_CLAUDE_SESSIONS", getPath(C, "sync.sessions") ? "1" : "0");
  put("SYNC_CLAUDE_GROUPING", getPath(C, "sync.grouping") ? "1" : "0");

  if (mode === "anthropic") return out.join("\n") + "\n";   // proxy-only vars omitted; run.sh unsets any inherited

  // Proxy mode: the active provider's wire config + the Code-tab/CLI wiring.
  put("OPENAI_MODEL", v.OPENAI_MODEL);
  put("OPENAI_API", v.OPENAI_API);
  put("OPENAI_BASE_URL", v.OPENAI_BASE_URL);   // local: run.sh's ensure_ollama overrides with the managed port
  putIf("OPENAI_EXTRA_HEADERS", v.OPENAI_EXTRA_HEADERS);
  putIf("LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL", v.OPENAI_CLAUDE_CODE_MODEL);
  putIf("CLAUDE_CODE_BG_CLASSIFIER_MODEL", swapEngineList(getPath(C, "classifier.background")));
  // Classifier models as env overrides so the proxy routes prefix/safety verdicts to the ACTIVE
  // on-device engine (config.jsonc holds the default engine's ids; the toggle swaps the provider).
  putIf("OPENAI_CLASSIFIER_MODEL", swapEngineList(getPath(C, "classifier.prefix")));
  putIf("OPENAI_CLASSIFIER_SAFETY_MODEL", swapEngineList(getPath(C, "classifier.safety")));
  put("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", getPath(C, "picker.gatewayModelDiscovery") === false ? "0" : "1");
  put("PROXY_ANTHROPIC_BASE_URL", `http://127.0.0.1:${v.PORT}`);
  const comp = getPath(C, "composite");
  if (Array.isArray(comp) && comp.length) put("LLMD_COMPOSITE", JSON.stringify({ members: comp }));

  // Compaction window: an on-device provider derives it per-model (explicit compactWindow, else 3/4 of
  // the model's context); every other provider uses the flat configured value. Keyed off the DEFAULT
  // provider's own config, not the literal "local".
  let acw = v.CLAUDE_CODE_AUTO_COMPACT_WINDOW || undefined;
  {
    const m = v.OPENAI_MODEL;
    const cw = getPath(C, `providers.${dp}.compactWindow.${m}`);
    const ctx = getPath(C, `providers.${dp}.context.${m}`) || getPath(C, `providers.${dp}.managed.contextLength`);
    acw = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || cw || (ctx ? Math.floor(ctx * 3 / 4) : acw);
  }
  putIf("CLAUDE_CODE_AUTO_COMPACT_WINDOW", acw);

  // Managed on-device Ollama: the OLLAMA_* knobs run.sh's ensure_ollama reads. Emitted only when the
  // DEFAULT provider is the ollama-engine managed one (its `managed` block), so a freetoken default
  // does not emit meaningless OLLAMA_* values.
  const dpManaged = getPath(C, `providers.${dp}.managed`) || {};
  if (dpManaged.engine === "ollama") {
    const m = v.OPENAI_MODEL;
    putIf("OLLAMA_CONTEXT_LENGTH", getPath(C, `providers.${dp}.context.${m}`) || dpManaged.contextLength);
    put("OLLAMA_KV_CACHE_TYPE", dpManaged.kvCacheType || "q8_0");
    put("OLLAMA_FLASH_ATTENTION", dpManaged.flashAttention === false ? "0" : "1");
    put("OLLAMA_NUM_PARALLEL", dpManaged.numParallel || 1);
    put("OLLAMA_KEEP_ALIVE", dpManaged.keepAlive || "30m");
    putIf("OLLAMA_MANAGED_PORT", dpManaged.managedPort);
    put("OLLAMA_AUTOSTART", dpManaged.autostart === false ? "0" : "1");
  }

  // Managed FreeToken engine: run.sh brings it up INDEPENDENTLY of the default provider (so a picked
  // freetoken:<model> works even when the default is ollama). Emitted for whichever provider declares a
  // freetoken-engine managed block.
  for (const [id, prov] of Object.entries(C.providers || {})) {
    const mg = prov && prov.managed;
    if (mg && mg.engine === "freetoken") {
      // Autostart only when this is the on-device engine the toggle selected (the GPU runs just one).
      put("FREETOKEN_AUTOSTART", ((!onDev || id === onDev) && mg.autostart !== false) ? "1" : "0");
      put("FREETOKEN_PORT", mg.port || 1919);
      putIf("FREETOKEN_MODEL_PATH", mg.modelPath);
      putIf("FREETOKEN_SERVED_MODEL", mg.servedModelName);
      putIf("FREETOKEN_TOOL_PARSER", mg.toolCallParser);
      putIf("FREETOKEN_REASONING_PARSER", mg.reasoningParser);
      // GPU-fit knobs (a bigger model on the 8GB card needs them): cap concurrency to 1 so prefill
      // activation stays small, capture only the bs=1 CUDA graph, and reserve runtime headroom.
      putIf("FREETOKEN_MAX_RUNNING_REQ", mg.maxRunningRequests);
      putIf("FREETOKEN_CUDA_GRAPH_MAX_BS", mg.cudaGraphMaxBs);
      putIf("FREETOKEN_MEMORY_RATIO", mg.memoryRatio);
      // KV-cache storage dtype (--kv-dtype). fp8_e4m3/fp8_e5m2 halve KV bytes/token (~2x the token
      // budget that fits), letting a long classifier transcript clear the bf16 ceiling. run.sh passes
      // it only when the local build has the flag. fp8 is FULL-attention only for now (the SWA store
      // path is still bf16), so a SWA model like gemma must stay "auto"; a llama classifier can use fp8.
      putIf("FREETOKEN_KV_DTYPE", mg.kvDtype);
      // SWA window-pool sizing so the pool clears the classifier rulebook and prefixes are reused
      // across calls. Preferred: swaFullTokensRatio -> --swa-full-tokens-ratio at LOAD (PR #109; run.sh
      // uses it when the local build supports the flag). Fallback: numPages/numSwaPages -> a post-start
      // /v1/cache/rebuild (works on stock FreeToken; numPages caps the full pool = context).
      putIf("FREETOKEN_SWA_RATIO", mg.swaFullTokensRatio);
      putIf("FREETOKEN_NUM_PAGES", mg.numPages);
      putIf("FREETOKEN_NUM_SWA_PAGES", mg.numSwaPages);
      putIf("FREETOKEN_LAUNCH", mg.launch);
      putIf("FREETOKEN_HEALTH_PATH", mg.healthPath);
      putIf("FREETOKEN_ENDPOINT", prov.endpoint);
      break;   // one managed FreeToken server
    }
  }
  return out.join("\n") + "\n";
}

// ---------- CLI ----------
//
// run.sh is bash and needs the hash to decide whether a running proxy is the one it wants.
// Keeping that in this module rather than reimplementing the precedence in shell is the
// entire reason this file exists.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const arg = process.argv[2] || "--json";
  if (arg === "--hash") process.stdout.write(configHash() + "\n");
  else if (arg === "--code-version") process.stdout.write(codeVersion() + "\n");
  else if (arg === "--provider") process.stdout.write(provider() + "\n");
  else if (arg === "--env") process.stdout.write(emitEnv());
  else if (arg === "--providers") process.stdout.write(Object.keys(PROVIDERS).join(" ") + "\n");
  else if (arg === "--validate") {
    const { errors, warnings } = validate();
    for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
    for (const e of errors) process.stdout.write(`error: ${e}\n`);
    process.exitCode = errors.length ? 1 : 0;
  } else process.stdout.write(JSON.stringify(snapshot(), null, 2) + "\n");
}
