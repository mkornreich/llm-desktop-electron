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
