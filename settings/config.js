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
    options: ["openai", "anthropic"], default: "openai",
    label: "Model backing the agent",
    help: "anthropic = the agent calls Anthropic directly with Claude (stock behaviour). openai = via the local translation proxy. Only the agent is affected; the chat window is always remote claude.ai." },

  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_MODEL", type: "text",
    default: "gpt-5.3-codex", placeholder: "gpt-5.3-codex",
    suggestions: ["gpt-5.3-codex", "gpt-5.4", "gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
    label: "Model", help: "Any OpenAI model id. Names containing 'codex' are routed to the Responses API automatically." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_API", type: "enum",
    options: ["", "chat", "responses"], default: "",
    label: "API surface", help: "Blank = auto (codex models use Responses, everything else Chat Completions). Responses has no 128-tool cap; Chat Completions does." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_CLASSIFIER_MODEL", type: "text",
    default: "gpt-4.1-mini", suggestions: ["gpt-4.1-mini", "gpt-5.4", "gpt-5.3-codex"],
    label: "Prefix-detection model",
    help: "For the Bash command-prefix detection call only. Latency-sensitive and low-stakes, so a small model is the point. Measured accuracy: gpt-4.1-mini 12/14, gpt-5.4 and gpt-5.3-codex 13/14." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_CLASSIFIER_SAFETY_MODEL", type: "text",
    default: "gpt-5.4", suggestions: ["gpt-5.4", "", "gpt-5.3-codex"],
    placeholder: "(blank = use the main model)",
    label: "Auto-mode safety-verdict model",
    help: "Claude Code aborts its safety classifier at 60s and then DENIES the action. Measured over 27 live verdicts on the main model: median 12.2s, p90 54s, max 287s, 2 past the cliff. Replaying the four largest real prompts, gpt-5.4 answered in 1.4-3.5s vs 25-38s for gpt-5.3-codex, matched its one block and blocked one more that it allowed — faster and no more permissive. gpt-4.1 and gpt-4.1-mini were fast but allowed what codex blocked, so avoid them here. Blank = use the main model and accept the latency." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_CLASSIFIER_MAX_TOOLS", type: "int",
    default: "4",
    label: "Classifier tool-count ceiling",
    help: "A classifier call is a verdict and carries no tools. Above this many tools, a prompt that matches the classifier contract is treated as a normal agent turn instead — which stops a session that merely quotes the contract from having its own turns misrouted. Raise only if a real classifier call starts being missed." },
  { group: "OpenAI model", file: ".openai-model", key: "OPENAI_PICKER_MODELS", type: "text",
    default: "", placeholder: "gpt-5.3-codex:GPT-5.3 Codex,gpt-5.4:GPT-5.4",
    label: "Models offered in the picker", help: "Comma-separated id:Label pairs served from the proxy's /v1/models. Blank uses the built-in list." },

  { group: "Reasoning", file: ".openai-model", key: "OPENAI_REASONING_EFFORT", type: "enum",
    options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], default: "max",
    label: "Reasoning effort",
    help: "API-wide enum; each model supports only a subset and the proxy steps down to the highest it accepts (gpt-5.3-codex and gpt-5.4 cap at xhigh). Effort is billed as output and mostly invisible — one xhigh turn billed 6,791 output tokens for a 1,365-character answer." },
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
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_MAX_EMPTY_RETRIES", type: "int",
    default: "2", label: "Max empty-turn retries",
    help: "How many times to re-ask before giving up and showing the diagnostic. Each retry costs a full request, so keep it small." },
  { group: "Agent behaviour", file: ".openai-model", key: "OPENAI_TASK_ECHO", type: "bool",
    default: "1", label: "Show the task list when it changes",
    help: "When the agent calls TaskCreate, TaskUpdate or TodoWrite, appends the actual list as a markdown checklist. The session otherwise shows only a collapsed label, and neither tool result carries the list — TaskUpdate returns just \"Updated task #3 status\". Rendered from the model's own tool arguments plus the task list the CLI puts in the transcript; never invented." },

  { group: "Claude CLI", file: ".openai-model", key: "CLAUDE_CODE_BG_CLASSIFIER_MODEL", type: "text",
    default: "gpt-4.1-mini", label: "Background classifier model",
    help: "Forwarded to the agent in OpenAI mode only — it holds an OpenAI model id, so Anthropic mode drops it deliberately." },
  { group: "Claude CLI", file: ".openai-model", key: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", type: "bool",
    default: "1", label: "Gateway model discovery",
    help: "Makes the app list the proxy's /v1/models in its picker. OpenAI mode only." },

  { group: "Output limits", file: ".openai-model", key: "OPENAI_CONTINUE_ON_TRUNCATION", type: "bool",
    default: "1", label: "Continue when cut off by the output cap",
    help: "When a turn ends truncated at max_output_tokens, the proxy resumes it and appends to the same message instead of handing back a half-finished answer (issue #8)." },
  { group: "Output limits", file: ".openai-model", key: "OPENAI_MAX_TURN_OUTPUT_TOKENS", type: "int",
    default: "56000", label: "Max total output per turn",
    help: "Ceiling on output tokens spliced into a single assistant message across continuations. Kept under the client's own per-response maximum, which reports 'Claude's response exceeded the 64000 output token maximum'." },
  { group: "Output limits", file: ".openai-model", key: "OPENAI_DEFAULT_MAX_TOKENS", type: "int",
    default: "8192", label: "Default budget when unspecified",
    help: "Used only when the client omits max_tokens. Previously inherited maxTokens=512 from ~/.dbeaver-ai-complete, a DBeaver setting, which starved such requests." },

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

  { group: "Sessions", file: ".sync", key: "SYNC_CLAUDE_SESSIONS", type: "bool",
    default: "1", label: "Share the session store with Claude Desktop",
    help: "Makes user-data/claude-code-sessions a symlink to Claude Desktop's store, so sessions are one set of files and travel both ways instantly (issue #3). This replaced a one-way copy that let the two stores drift apart — 13 sessions existed only in the real install and 64 only here. Two consequences: this build now writes into the real install's data, and deleting a session deletes it for both apps. Unmerged sessions block the link; run scripts/merge-sessions.mjs first." },
  { group: "Sessions", file: ".sync", key: "SYNC_CLAUDE_UI_STATE", type: "bool",
    default: "0", label: "Copy claude.ai UI state on launch",
    help: "Off by default. Copies Claude Desktop's Local Storage (sidebar prefs, grouping definitions, composer drafts) over this build's. It is a whole-directory COPY, not a share, because LevelDB allows one process at a time — both databases hold an exclusive fcntl(F_WRLCK) while their app runs, so a shared directory would stop the second app opening its UI state at all. It also replaces this build's own drafts, and Local Storage holds bootstrap state whose loss previously caused 401s. Skipped while Claude Desktop is running; the previous state is kept at Local Storage.bak." },
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
    const raw = cache[item.file][item.key];
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
    if (!item) continue;                                   // ignore unknown keys
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push([key, String(value)]);
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
