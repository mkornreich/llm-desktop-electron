// One-shot migration: read the 13 legacy KEY=value dotfiles and emit the consolidated config.jsonc.
//
//   node scripts/migrate-config.mjs            # write ../config.jsonc (refuses to overwrite)
//   node scripts/migrate-config.mjs --stdout   # print to stdout, write nothing (inspect first)
//   node scripts/migrate-config.mjs --force     # overwrite an existing config.jsonc
//
// Non-secret only: .openai-key is deliberately NOT read or migrated (keys stay in their own gitignored
// file). This script is idempotent and side-effect-free until it writes; deleting the old dotfiles is a
// separate, human step after the resolver cutover verifies equivalence.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadKV, PROVIDERS } from "../openai-proxy/config.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const F = (name) => loadKV(ROOT + name);

// Sources.
const provider = F("/.provider");
const om = F("/.openai-model");
const diag = F("/.diagnostics");
const priv = F("/.privacy");
const sync = F("/.sync");
// Per-provider model files. openai's "file" is .openai-model itself (its OPENAI_MODEL/API live there).
const PFILE = {
  openai: om, local: F("/.local-model"), gemini: F("/.gemini-model"), cohere: F("/.cohere-model"),
  mistral: F("/.mistral-model"), groq: F("/.groq-model"), ollama: F("/.ollama-model"), openrouter: F("/.openrouter-model"),
};

// Helpers — value coercion mirrors config.mjs's TYPES so the migrated value round-trips identically.
const str = (o, k, d = "") => (o[k] === undefined || o[k] === "" ? d : o[k]);
const num = (o, k, d) => { const n = parseInt(o[k], 10); return Number.isNaN(n) ? d : n; };
const bool = (o, k, d) => (o[k] === undefined || o[k] === "" ? d : o[k] !== "0"); // bool01
const list = (o, k) => str(o, k).split(",").map((s) => s.trim()).filter(Boolean);
const J = (v) => JSON.stringify(v);                         // scalar/string
const arr1 = (a) => (a.length ? "[" + a.map(J).join(", ") + "]" : "[]");

// providers.<id> block. endpoint defaults to the registry baseURL unless the file overrides OPENAI_BASE_URL.
function providerBlock(id, indent = "    ") {
  const f = PFILE[id];
  const endpoint = str(f, "OPENAI_BASE_URL", PROVIDERS[id].baseURL);
  const api = str(f, "OPENAI_API", PROVIDERS[id].api);
  const model = str(f, "OPENAI_MODEL");
  const ccm = str(f, "OPENAI_CLAUDE_CODE_MODEL");
  const lines = [`"endpoint": ${J(endpoint)}`, `"api": ${J(api)}`, `"model": ${J(model)}`];
  if (ccm) lines.push(`"claudeCodeModel": ${J(ccm)}`);
  if (id === "openrouter" && str(f, "OPENAI_EXTRA_HEADERS")) lines.push(`"extraHeaders": ${J(str(f, "OPENAI_EXTRA_HEADERS"))}`);
  if (id === "local") {
    const ol = [
      `"autostart": ${bool(f, "OLLAMA_AUTOSTART", true)}`,
      `"managedPort": ${num(f, "OLLAMA_MANAGED_PORT", 11435)}`,
      `"keepAlive": ${J(str(f, "OLLAMA_KEEP_ALIVE", "30m"))}`,
      `"flashAttention": ${bool(f, "OLLAMA_FLASH_ATTENTION", true)}`,
      `"kvCacheType": ${J(str(f, "OLLAMA_KV_CACHE_TYPE", "q8_0"))}`,
      `"numParallel": ${num(f, "OLLAMA_NUM_PARALLEL", 1)}`,
      `"contextLength": ${num(f, "OLLAMA_CONTEXT_LENGTH", 0)}`,
    ];
    lines.push(`"ollama": { ${ol.join(", ")} }`);
    // Per-model context/compact windows: CONTEXT_<model>= / COMPACT_<model>= lines.
    const ctx = Object.keys(f).filter((k) => k.startsWith("CONTEXT_")).map((k) => `${J(k.slice(8))}: ${num(f, k)}`);
    const cmp = Object.keys(f).filter((k) => k.startsWith("COMPACT_")).map((k) => `${J(k.slice(8))}: ${num(f, k)}`);
    if (ctx.length) lines.push(`"context": { ${ctx.join(", ")} }`);
    if (cmp.length) lines.push(`"compactWindow": { ${cmp.join(", ")} }`);
  }
  return `{\n${indent}  ${lines.join(",\n" + indent + "  ")}\n${indent}}`;
}

const providersText = Object.keys(PFILE)
  .map((id) => `    ${J(id)}: ${providerBlock(id)}`)
  .join(",\n");

// The one setting that is env-only today (never in a file) but must live in the JSON now: keep its default.
const port = num(om, "PORT", 8123);

const jsonc = `{
  // ============================================================================================
  //  llm_desktop — one config file for every mode, provider, endpoint, model, and tuning knob.
  //  JSONC: // and /* */ comments and trailing commas are allowed. Edit by hand or via Settings
  //  (the window preserves these comments). SECRETS ARE NOT HERE: API keys stay in .openai-key
  //  (gitignored). Any matching environment variable still overrides the value below.
  // ============================================================================================

  // Top-level mode. "proxy" translates Anthropic <-> a non-Anthropic backend; "anthropic" is a
  // pass-through to Anthropic's own API (every "providers"/tuning field below is then ignored).
  "mode": ${J(str(provider, "PROVIDER", "proxy"))},

  // Which provider backs un-picked (main) turns, the classifier, and compaction. A Code-tab pick of
  // "<provider>:<model>" still routes that turn elsewhere.
  "defaultProvider": ${J(str(provider, "DEFAULT_PROVIDER", "openai"))},

  // Per-provider endpoint + model. "endpoint" moved here from the hardcoded registry; blank falls back
  // to the built-in default. "local" is the keyless on-device Ollama (its endpoint is rediscovered at
  // launch when Ollama is managed). "ollama" is the remote Ollama Cloud.
  "providers": {
${providersText}
  },

  // Composite (fallback) model: the ordered chain the reserved id "composite" tries until one answers,
  // failing over on transport/HTTP errors and honouring Retry-After on 429s. First in the Code-tab
  // dropdown and the default for new sessions. "maxWaitMs" bounds the wait when EVERY member is 429'd.
  "composite": ${arr1(list(om, "OPENAI_COMPOSITE_MODELS"))},
  "compositeMaxWaitMs": ${num(om, "OPENAI_COMPOSITE_MAX_WAIT_MS", 30000)},

  // Compaction summariser chain (responses-capable members only). Empty -> the single "compaction.model".
  "compact": ${arr1(list(om, "OPENAI_COMPACT_MODELS"))},

  // Classifier models. These run on the DEFAULT provider unless the value is a routable "<provider>:<model>".
  // safety="" means "use the main model" (measured: 57% unparseable verdicts -> avoid). prefix is the
  // low-stakes Bash-prefix detector. background is the CLI's own hint (may not reach the in-app agent).
  "classifier": {
    "prefix": ${J(str(om, "OPENAI_CLASSIFIER_MODEL"))},
    "safety": ${J(str(om, "OPENAI_CLASSIFIER_SAFETY_MODEL", "gpt-5.4-2026-03-05"))},
    "background": ${J(str(om, "CLAUDE_CODE_BG_CLASSIFIER_MODEL", "gpt-4.1-mini"))},
    "maxTools": ${num(om, "OPENAI_CLASSIFIER_MAX_TOOLS", 4)},
    "slowMs": ${num(om, "OPENAI_CLASSIFIER_SLOW_MS", 20000)}
  },

  // Reasoning. effort is the API-wide max the proxy steps DOWN from per model. minBudget: thinking is
  // only requested when max_output_tokens is at least this (QUIRK preserved in the resolver: an explicit
  // 0 resolves to 2000, not the 4000 default). verbosity is OpenAI's text.verbosity (blank = omit).
  "reasoning": {
    "effort": ${J(str(om, "OPENAI_REASONING_EFFORT", "medium"))},
    "showThinking": ${bool(om, "OPENAI_SHOW_THINKING", true)},
    "minBudget": ${num(om, "OPENAI_THINKING_MIN_BUDGET", 4000)},
    "verbosity": ${J(str(om, "OPENAI_VERBOSITY", "high"))}
  },

  // Output-token handling. defaultMaxTokens applies only when the client omits max_tokens.
  // maxTurnOutputTokens caps the total spliced into one message (stay under the client's own 64000
  // ceiling). continueOnTruncation resumes a turn the cap cut off. emptyRetry re-asks a blank turn.
  "output": {
    "defaultMaxTokens": ${num(om, "OPENAI_DEFAULT_MAX_TOKENS", 8192)},
    "maxOutputTokens": ${num(om, "OPENAI_MAX_OUTPUT_TOKENS", 32768)},
    "maxTurnOutputTokens": ${num(om, "OPENAI_MAX_TURN_OUTPUT_TOKENS", 56000)},
    "continueOnTruncation": ${bool(om, "OPENAI_CONTINUE_ON_TRUNCATION", true)},
    "maxTransportRetries": ${num(om, "OPENAI_MAX_TRANSPORT_RETRIES", 2)},
    "emptyRetry": ${bool(om, "OPENAI_EMPTY_RETRY", true)},
    "maxEmptyRetries": ${num(om, "OPENAI_MAX_EMPTY_RETRIES", 2)}
  },

  // Agent behaviour. autoContinue splices a continuation when a turn only ANNOUNCES an action.
  // (QUIRK preserved: maxContinuations=0 resolves to 2, not "disabled" — autoContinue=false is the off switch.)
  "agent": {
    "persistence": ${bool(om, "OPENAI_PERSISTENCE", true)},
    "autoContinue": ${bool(om, "OPENAI_AUTO_CONTINUE", true)},
    "maxContinuations": ${num(om, "OPENAI_MAX_CONTINUATIONS", 2)},
    "outputFixups": ${bool(om, "OPENAI_OUTPUT_FIXUPS", true)},
    "taskEcho": ${bool(om, "OPENAI_TASK_ECHO", true)}
  },

  // Compaction. summary condenses dropped tool output with one extra call (falls back to truncation).
  // model is the single summariser when "compact" is empty (blank -> classifier.prefix -> gpt-4.1-mini).
  // autoCompactWindow is the client's context accounting bound (issues #14/#17).
  "compaction": {
    "summary": ${bool(om, "OPENAI_COMPACT_SUMMARY", true)},
    "model": ${J(str(om, "OPENAI_COMPACT_MODEL"))},
    "maxTextChars": ${num(om, "OPENAI_MAX_TEXT_CHARS", 400000)},
    "autoCompactWindow": ${num(om, "CLAUDE_CODE_AUTO_COMPACT_WINDOW", 0)}
  },

  // Tool exposure to the model.
  "tools": {
    "sendChromeTools": ${bool(om, "PROXY_SEND_CHROME_TOOLS", true)},
    "sendIosTools": ${bool(om, "PROXY_SEND_IOS_TOOLS", true)},
    "webSearch": ${bool(om, "PROXY_WEB_SEARCH", true)},
    "webSearchProxy": ${J(str(om, "PROXY_WEB_SEARCH_PROXY"))}
  },

  // Model picker / Code-tab dropdown. models is the id:Label list served on /v1/models; dropdownModels
  // is the ordered <provider>:<model> id list injected into the dropdown's 1-9 slots.
  "picker": {
    "models": ${J(str(om, "OPENAI_PICKER_MODELS"))},
    "dropdownModels": ${arr1(list(diag, "DROPDOWN_MODELS"))},
    "gatewayModelDiscovery": ${bool(om, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", true)}
  },

  // Wire-level knobs (were environment-only before; consolidated here). Any of these still accept an env override.
  "advanced": {
    "port": ${port},
    "maxTools": ${num(om, "OPENAI_MAX_TOOLS", 128)},
    "maxToolsResponses": ${num(om, "OPENAI_MAX_TOOLS_RESPONSES", 0)}
  },

  "diagnostics": {
    "logLevel": ${J(str(diag, "DESKTOP_LOG_LEVEL", "info"))},
    "dumpTools": ${str(diag, "PROXY_DUMP_TOOLS") === "1"},
    "ultracode": ${bool(diag, "ULTRACODE_DEFAULT", false)}
  },

  "privacy": { "disableTelemetry": ${bool(priv, "DISABLE_TELEMETRY", true)} },

  "sync": {
    "sessions": ${bool(sync, "SYNC_CLAUDE_SESSIONS", false)},
    "grouping": ${bool(sync, "SYNC_CLAUDE_GROUPING", false)}
  },

  // Claude Code CLI knobs. maxOutputTokens is the per-turn output ceiling (hits "response exceeded 64000").
  "claudeCode": { "maxOutputTokens": ${num(om, "CLAUDE_CODE_MAX_OUTPUT_TOKENS", 64000)} }
}
`;

const outFile = ROOT + "config.jsonc";
const args = process.argv.slice(2);
if (args.includes("--stdout")) {
  process.stdout.write(jsonc);
} else if (fs.existsSync(outFile) && !args.includes("--force")) {
  process.stderr.write(`refusing to overwrite ${outFile} (pass --force). Use --stdout to inspect.\n`);
  process.exitCode = 1;
} else {
  fs.writeFileSync(outFile, jsonc);
  process.stdout.write(`wrote ${outFile}\n`);
}
