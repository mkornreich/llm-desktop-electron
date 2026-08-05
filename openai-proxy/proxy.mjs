#!/usr/bin/env node
// Anthropic <-> OpenAI translation proxy.
//
// Speaks the Anthropic Messages API on the front (so an Anthropic SDK client can
// point ANTHROPIC_BASE_URL at it), and calls OpenAI's Chat Completions API on the
// back. Handles non-streaming and SSE streaming, plus best-effort tool-calls.
//
// Config is read at runtime from ~/.dbeaver-ai-complete (KEY=VALUE):
//   apiKey=sk-...        (OpenAI key; never logged)
//   model=gpt-4.1        (target OpenAI model)
//   maxTokens, temperature  (fallback defaults)
// Env overrides: OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, PORT.
//
// Usage:  node proxy.mjs        (listens on http://127.0.0.1:8123)

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------- config ----------
function loadKV(path) {
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
const FILE = loadKV(os.homedir() + "/.dbeaver-ai-complete");
// Per-project override — a dot file at the repo root storing THIS project's model
// choice (the API key stays in ~/.dbeaver-ai-complete; only the model lives here).
const PROJECT = loadKV(fileURLToPath(new URL("../.openai-model", import.meta.url)));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || PROJECT.apiKey || FILE.apiKey || "";
// Precedence: env var > project dot file > global dbeaver file > default.
const OPENAI_MODEL =
  process.env.OPENAI_MODEL || PROJECT.OPENAI_MODEL || PROJECT.model || FILE.model || "gpt-4.1";
// API surface: OpenAI's codex models are served only via the Responses API;
// everything else uses Chat Completions. Override with OPENAI_API=responses|chat.
const OPENAI_API = (process.env.OPENAI_API || PROJECT.OPENAI_API ||
  (/codex/i.test(OPENAI_MODEL) ? "responses" : "chat")).toLowerCase();
const USE_RESPONSES = OPENAI_API === "responses";
// A faster/cheaper model for the auto-mode safety classifier (a separate LLM call
// Claude Code makes before each risky action). The main coding model can be slow
// for these latency-sensitive checks, so route them to a small fast model here.
const OPENAI_CLASSIFIER_MODEL = process.env.OPENAI_CLASSIFIER_MODEL || PROJECT.OPENAI_CLASSIFIER_MODEL || "";
// The auto-mode SAFETY verdict is a security decision, so by default it keeps the main
// model — see pickModel for the measurement that settled this. Set a model name here only if
// you accept a weaker verdict in exchange for latency.
const OPENAI_CLASSIFIER_SAFETY_MODEL = process.env.OPENAI_CLASSIFIER_SAFETY_MODEL ||
  PROJECT.OPENAI_CLASSIFIER_SAFETY_MODEL || "";
// A classifier call is a verdict, so it carries no tools. This is the ceiling above which a
// prompt that LOOKS like a classifier is treated as a normal agent turn instead — see
// isClassifierRequest. 0 would be defensible; a few allows for a call that passes one or two.
const CLASSIFIER_MAX_TOOLS = parseInt(process.env.OPENAI_CLASSIFIER_MAX_TOOLS ||
  PROJECT.OPENAI_CLASSIFIER_MAX_TOOLS || "4", 10) || 0;
// Models advertised on GET /v1/models — what the app's gateway model-discovery
// (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) lists in the picker. Selecting one
// makes the agent request that id, which the proxy passes straight through.
// Comma-separated "id:Display Name" pairs; override via OPENAI_PICKER_MODELS.
const PICKER_MODELS = (process.env.OPENAI_PICKER_MODELS || PROJECT.OPENAI_PICKER_MODELS ||
  "gpt-5.3-codex:GPT-5.3 Codex,gpt-5.4:GPT-5.4,gpt-4.1:GPT-4.1,gpt-4.1-mini:GPT-4.1 mini,gpt-4o:GPT-4o")
  .split(",").map((s) => { const [id, ...n] = s.split(":"); return { id: (id || "").trim(), name: (n.join(":").trim() || (id || "").trim()) }; })
  .filter((m) => m.id);
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
// Budget used only when the client omits max_tokens. It deliberately does NOT read
// FILE.maxTokens any more: ~/.dbeaver-ai-complete is a DBeaver config and carries
// maxTokens=512, which is fine for a SQL assistant and far too small for an agent — a request
// that omitted max_tokens got 512 tokens, and with reasoning attached could return nothing at
// all. Override with OPENAI_DEFAULT_MAX_TOKENS.
const DEFAULT_MAX_TOKENS = parseInt(process.env.OPENAI_DEFAULT_MAX_TOKENS || PROJECT.OPENAI_DEFAULT_MAX_TOKENS || "8192", 10) || 8192;
// OpenAI models cap completion tokens (e.g. gpt-4.1 = 32768) far below Claude's
// 64k; clamp so agents that request Claude-sized budgets don't 400.
const MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "32768", 10) || 32768;
// Tool-array caps are PER API SURFACE, not global — probed directly against the API:
//   Chat Completions: hard cap 128 (129 -> 400 "array too long").
//   Responses:        no cap observed (128/129/214/256/512 all accepted).
// The desktop agent sends ~214 tools, so on the Responses path we now send ALL of
// them and the model never loses a tool it needs. Only the chat path must clamp.
// Names must still match ^[a-zA-Z0-9_-]{1,64}$, so they are always sanitized.
const MAX_TOOLS_CHAT = parseInt(process.env.OPENAI_MAX_TOOLS || "128", 10) || 128;
const MAX_TOOLS_RESPONSES = parseInt(process.env.OPENAI_MAX_TOOLS_RESPONSES || "0", 10) || Infinity;
// When the chat path MUST drop tools, drop the least essential ones rather than
// whichever happened to be last in the array. These are the tools an agent needs to
// actually finish work (read/write/run/search/plan) plus the ones that make output
// render (artifacts/widgets/diagrams) — losing those is what makes a model narrate a
// task instead of doing it, or dump raw markup instead of a rendered artifact.
const ESSENTIAL_TOOL_RE = new RegExp(
  "^(read|write|edit|multiedit|notebookedit|create_file|str_replace|" +
  "bash|bashoutput|killbash|killshell|run_command|shell|" +
  "glob|grep|ls|list_dir|search|find|" +
  "task|todowrite|exitplanmode|enterplanmode|plan|" +
  "webfetch|websearch|fetch|" +
  "skill|toolsearch|senduserfile|sendmessage|" +
  "artifact|.*widget.*|.*visuali[sz]e.*|.*diagram.*|.*mermaid.*|.*chart.*|canvas)",
  "i");
const isEssentialTool = (n) => ESSENTIAL_TOOL_RE.test(String(n || ""));
// PROXY_DUMP_TOOLS=1 writes the exact tool list a request carried to tools-dump.txt.
// The agent's real tool set is otherwise invisible from outside the app.
const DUMP_TOOLS = process.env.PROXY_DUMP_TOOLS === "1";
function dumpTools(tools) {
  if (!DUMP_TOOLS || !Array.isArray(tools)) return;
  try {
    fs.writeFileSync(fileURLToPath(new URL("./tools-dump.txt", import.meta.url)),
      `${tools.length} tools\n` + tools.map((t) => t.name).join("\n") + "\n");
  } catch { /* diagnostic only */ }
}
// Output shaping. The app's chat surface is the REMOTE claude.ai web app — there is no
// math or markdown renderer in the local bundle to patch — so the only lever is what
// the model emits. GPT models default to \( \) / \[ \] for math, which that renderer
// shows literally; it wants $ / $$. And .svg FILES render as images (the bundle maps
// IMAGE_EXT_TO_MIME ".svg" -> "image/svg+xml"), while inline <svg> markup in chat text
// does not. Set OPENAI_OUTPUT_FIXUPS=0 to disable both.
const OUTPUT_FIXUPS = (process.env.OPENAI_OUTPUT_FIXUPS || PROJECT.OPENAI_OUTPUT_FIXUPS || "1") !== "0";
// Agentic persistence. Claude Code's auto mode grants PERMISSION to run tools; it cannot
// make a model decide to keep going. Claude is trained to run a task to completion, while
// GPT models routinely end the turn to check in ("If you want, I'll run that now") — which
// in an agent loop reads as the task stalling and forces the user to say "yes, continue"
// every step. This adds an explicit persistence directive. Set OPENAI_PERSISTENCE=0 to
// disable it independently of the output fixups.
const PERSISTENCE = (process.env.OPENAI_PERSISTENCE || PROJECT.OPENAI_PERSISTENCE || "1") !== "0";
// Auto-continue. Prompting alone does NOT fix the stall: measured over 4 trials per arm on
// the prompt that stalled, the model called a tool 3/4 times with the persistence
// directive and 3/4 without — a ~25% stall rate either way, unmoved by wording. When a
// turn ends with text that merely ANNOUNCES or OFFERS an action and no tool call, the
// agent loop hands control back and the user has to say "yes, go on". So the proxy
// continues that turn itself: it feeds the model its own announcement plus a nudge and
// splices the result into the SAME assistant message, so the client sees one turn that
// actually contains the tool call. Bounded, logged, and skipped for the classifier.
// Show the model's thinking. The Responses API emits reasoning SUMMARIES (section
// headers and short rationales, not raw chain-of-thought) — but only when `summary` AND an
// explicit `effort` are both set. Probed: {summary:"detailed"} alone yields nothing, while
// effort low/medium/high with summary:"detailed" all produce
// response.reasoning_summary_text.delta events. These are mapped to Anthropic `thinking`
// content blocks, which the client renders as thinking. Responses path only — Chat
// Completions has no reasoning parameter.
const SHOW_THINKING = (process.env.OPENAI_SHOW_THINKING || PROJECT.OPENAI_SHOW_THINKING || "1") !== "0";
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || PROJECT.OPENAI_REASONING_EFFORT || "medium";
// The reasoning-effort enum is API-wide but each model supports a SUBSET, and the API only
// tells you by rejecting the request: gpt-5.3-codex and gpt-5.4 both answer
//   "Unsupported value: 'max' is not supported with the '<model>' model.
//    Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."
// even though the enum itself is none|minimal|low|medium|high|xhigh|max. So asking for the
// true maximum and stepping down on rejection gets the highest each model actually allows,
// and keeps working when a model that does support 'max' is selected. The resolved value is
// cached per model so this costs at most one extra round-trip per model per proxy start.
const EFFORT_LADDER = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];
const effortByModel = new Map();
const effortFor = (model) => effortByModel.get(model) || REASONING_EFFORT;
function lowerEffort(model, rejected) {
  const i = EFFORT_LADDER.indexOf(rejected);
  const next = i === -1 ? "high" : EFFORT_LADDER[i + 1];
  if (!next) return null;
  effortByModel.set(model, next);
  log(`  ! reasoning effort '${rejected}' unsupported by ${model} — falling back to '${next}'`);
  return next;
}
// Reasoning tokens are drawn from the SAME max_output_tokens budget as the answer, so
// asking for thinking on a small-budget call can consume the whole allowance and return
// nothing. Observed in the app: background title calls (max_tokens=64, no tools) came back
// status=incomplete/max_output_tokens with 0 characters of text, four times in a row. The
// same call needs ~10 output tokens with no reasoning and ~26-64 with it. Utility calls
// gain nothing from thinking, so only request it when there is room to spare. The threshold
// is 4000 rather than 2000 because effort is now `max`: on one measured prompt the hidden
// reasoning went 98 tokens at medium -> 476 at xhigh, so the room needed grew with it.
const THINKING_MIN_BUDGET = parseInt(process.env.OPENAI_THINKING_MIN_BUDGET || PROJECT.OPENAI_THINKING_MIN_BUDGET || "4000", 10) || 2000;
// github issue #1 — "sometimes I see output with no text". Two causes, two fixes.
// (a) gpt-5.3-codex is terse to the point of silence: every tool-calling turn in the proxy
//     log came back text=0ch, so the UI showed a tool chip and no prose. OpenAI has a native
//     knob for this — text.verbosity, values low|medium|high (probed; 'ultra' 400s with the
//     list). It measurably changes output: "4" at low vs "2 + 2 = **4**." at high.
// (b) a turn can come back genuinely empty — no text AND no tool call — which must never be
//     forwarded as a blank turn. See emptyTurnNotice().
const VERBOSITY = process.env.OPENAI_VERBOSITY || PROJECT.OPENAI_VERBOSITY || "high";
// Compaction can either discard old tool output or SUMMARISE it. Summarising costs one extra
// model call but keeps the substance, which is what Claude Code's native compaction does.
// Falls back to plain truncation whenever the summary call fails, so it can only add value.
// github issue #8. When a turn is cut off by the output cap, continue it automatically instead
// of handing back a truncated answer.
// The CLI gives its auto-mode safety classifier a wall-clock budget (60s for the fast stage,
// 120s for the thinking stage) and fails CLOSED when it expires — the user sees "<model> is
// temporarily unavailable, so auto mode cannot determine the safety of X" and the action is
// denied. A classifier verdict is ~11 output tokens, so anything near that budget means the
// proxy is the problem. Warn well before the cliff.
const CLASSIFIER_SLOW_MS = parseInt(process.env.OPENAI_CLASSIFIER_SLOW_MS ||
  PROJECT.OPENAI_CLASSIFIER_SLOW_MS || "20000", 10) || 20000;

// An empty turn stalls the session: the user waits ~40s and gets a diagnostic instead of work.
// Retry instead. Bounded, and skipped for refusals, truncation and hard upstream errors — see
// the loop in streamResponses for why each of those must not be retried.
const EMPTY_RETRY = (process.env.OPENAI_EMPTY_RETRY || PROJECT.OPENAI_EMPTY_RETRY || "1") !== "0";
const MAX_EMPTY_RETRIES = parseInt(process.env.OPENAI_MAX_EMPTY_RETRIES ||
  PROJECT.OPENAI_MAX_EMPTY_RETRIES || "2", 10) || 0;
const CONTINUE_ON_TRUNCATION = (process.env.OPENAI_CONTINUE_ON_TRUNCATION || PROJECT.OPENAI_CONTINUE_ON_TRUNCATION || "1") !== "0";
// Ceiling on the TOTAL output tokens spliced into one assistant message. This matters because
// every continuation appends to the same message, and the client enforces its own per-response
// maximum — "Claude's response exceeded the 64000 output token maximum". Splicing without a
// budget is a plausible way to produce exactly that error, so continuations stop below it.
const MAX_TURN_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_TURN_OUTPUT_TOKENS || PROJECT.OPENAI_MAX_TURN_OUTPUT_TOKENS || "56000", 10) || 56000;
const COMPACT_SUMMARY = (process.env.OPENAI_COMPACT_SUMMARY || PROJECT.OPENAI_COMPACT_SUMMARY || "1") !== "0";
const COMPACT_MODEL = process.env.OPENAI_COMPACT_MODEL || PROJECT.OPENAI_COMPACT_MODEL ||
  OPENAI_CLASSIFIER_MODEL || "gpt-4.1-mini";
const AUTO_CONTINUE = (process.env.OPENAI_AUTO_CONTINUE || PROJECT.OPENAI_AUTO_CONTINUE || "1") !== "0";
const MAX_CONTINUATIONS = parseInt(process.env.OPENAI_MAX_CONTINUATIONS || PROJECT.OPENAI_MAX_CONTINUATIONS || "2", 10) || 2;
// Text that promises or proposes an action rather than reporting one. Deliberately narrow:
// a genuine question the user alone can answer ("which of these three do you want?") should
// still end the turn, so this matches announcements, offers, and "I need X to proceed".
// Three distinct shapes, because they need opposite treatment.
// 1. INTENT — the model says it is about to act, and then doesn't. Always continue.
const INTENT_RE = new RegExp([
  "\\b(i['’]?ll|i will|let me|i['’]?m going to|i am going to|going to)\\b[^.!?]{0,80}\\b(run|query|check|look|search|fetch|pull|list|inspect|read|grep|find|start|do|gather|collect)\\b",
  "\\b(starting|i['’]?ve started|kicking off)\\b[^.!?]{0,60}\\b(now|in the background)\\b",
].join("|"), "i");
// 2. OFFER — "if you want, I can …". Ambiguous alone: it means "shall I do what you asked?"
//    BEFORE the work, and "shall I do something extra?" AFTER it. Only the first continues.
const OFFER_RE = new RegExp([
  "\\b(if you want|shall i|would you like me|let me know|want me to|say the word|i can (also|additionally))\\b",
  "\\bi can (run|query|check|pull|list|do) that\\b",
].join("|"), "i");
// 3. MISSING DETAIL — asking for a value it could have discovered itself.
const MISSING_RE = new RegExp([
  "\\b(i need|need one|need a|need the)\\b[^.!?]{0,60}\\b(detail|value|host|url|path|name|account|project|credential|info|information)\\b",
  "\\bwhich\\b[^.!?]{0,40}\\b(host|project|repo|repository|account|branch|url)\\b[^.!?]{0,40}\\?",
].join("|"), "i");
// Completion signals. When the model reports finished work, a trailing offer is a suggested
// follow-up the user never asked for — continuing it would invent new work.
const DONE_RE = new RegExp([
  "\\b(done|all set|finished|complete[d]?)\\b",
  "\\bi['’]?ve\\b|\\bi have (fixed|added|created|updated|committed|removed|written|run)\\b",
  "\\b(fixed|added|created|updated|committed|removed|wrote|ran|verified|renamed|deleted|rendered|saved)\\b",
  "\\b(here['’]?s|here is|here are|results?:)\\b",
  "\\b(tests? pass|passing|no changes needed|nothing to do|already (correct|done))\\b",
].join("|"), "i");
// Claims that background work is ALREADY underway. github issue #5: the agent answered
// "Got it — I started a deep Slack analysis workflow ... It's running now in the background,
// and I'll report back ... as soon as it finishes" having called no tool at all, so nothing
// was running and no report was ever coming. This is the inverse of INTENT_RE: not a promise
// to act, but a false statement that action has been taken — which is worse, because the user
// waits. Only meaningful when no background-capable tool actually ran this turn.
const FALSE_BACKGROUND_RE = new RegExp([
  "\\b(i|i['’]ve|i have)\\s+(just\\s+)?(started|kicked[- ]off|launched|spawned|queued|triggered|dispatched|set (it |them )?(off|running))\\b",
  "\\b(it|that|these|those|they|the (workflow|audit|job|analysis|run|task|tasks|agents?|scan|sweep))\\b[^.!?]{0,30}\\b(is|are|'s|’s)?\\s*(now\\s+)?running\\b",
  "\\brunning\\b[^.!?]{0,20}\\bin the background\\b",
  "\\bin the background\\b[^.!?]{0,40}\\b(now|already|as we speak)\\b",
  "\\bi'?’?ll report back\\b[^.!?]{0,50}\\b(finishes|completes|done|results?)\\b",
].join("|"), "i");
// Tools that can genuinely leave something running after the turn ends. If one of these was
// called this turn, "it's running in the background" may well be true — leave it alone.
const BG_CAPABLE_RE = /^(workflow|agent|task|taskcreate|bash|bashoutput|croncreate|schedulewakeup|remotetrigger|mcp__ccd_session__spawn_task)$/i;
function backgroundToolUsedThisTurn(input) {
  if (!Array.isArray(input)) return false;
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it?.type === "function_call" && BG_CAPABLE_RE.test(String(it.name || ""))) return true;
    if (it?.role === "user" && Array.isArray(it.content) && it.content.some((c) => c?.type === "input_text")) return false;
  }
  return false;
}

// Overrides everything: a turn that ends asking to confirm something destructive MUST stay
// ended. Continuing it would answer the user's question for them and then act.
//
// The permission-seeking half matches the CONSTRUCTION, not the bare verb. It used to match a
// bare `confirm` or `destructive` anywhere in the text, which quietly disabled the whole
// auto-continue rescue as soon as the model narrated its work — "I'll run the suite to confirm
// nothing regressed" and "nothing destructive here, moving on" both returned null. That got
// far more likely once the narration directive asked for exactly this kind of sentence.
// The genuinely dangerous markers stay bare: they are almost never incidental.
const NEEDS_USER_RE = new RegExp([
  "please confirm",
  "confirm (?:and|before|first|whether|that you)",
  "(?:if|once|when|unless) you confirm",
  "you to confirm",
  "your confirmation",
  "awaiting (?:your )?confirmation",
  "confirm (?:this|these|that|the) (?:action|change|deletion|command|step|operation)",
  "are you sure",
  "\\bbefore i (?:proceed|continue)\\b",
  "your (?:approval|permission)",
  "need your ok",
  "\\bpermanently\\b",
  "irreversibl",
  "cannot be undone",
  "can['’]?t be undone",
  "(?:is|are|would be) destructive",
  "destructive (?:action|operation|command|change|step)",
  "force[- ]?push",
  "rm -rf",
  "drop (?:table|database)",
].join("|"), "i");

// Why this turn should continue, or null to leave it ended. Returning the reason (rather
// than a boolean) lets the caller pick a matching nudge and log something meaningful.
//   workDone = any tool ran this turn; bgUsed = a background-capable tool ran this turn.
function continueReason(text, workDone = false, bgUsed = false) {
  const t = String(text || "");
  if (!t.trim()) return null;
  if (NEEDS_USER_RE.test(t)) return null;                     // destructive confirmation
  // Checked BEFORE the done/workDone stop, because a false "I started it" reads as completed
  // work and would otherwise be treated as a finished turn.
  if (!bgUsed && FALSE_BACKGROUND_RE.test(t)) return "false-background";
  if (INTENT_RE.test(t)) return "intent";                     // promised to act, then didn't
  // Reported finished work, or already used tools this turn, and promised nothing further:
  // anything it offers now is optional follow-up the user did not ask for. Stop here.
  if (DONE_RE.test(t) || workDone) return null;
  if (OFFER_RE.test(t)) return "offer";
  if (MISSING_RE.test(t)) return "missing-detail";
  return null;
}
const shouldAutoContinue = (text, workDone = false, bgUsed = false) =>
  continueReason(text, workDone, bgUsed) !== null;

// Did this turn already run tools? Walk back to the last real user message (an input_text
// item, not a tool result) and look for function calls after it.
function workDoneThisTurn(input) {
  if (!Array.isArray(input)) return false;
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it?.type === "function_call" || it?.type === "function_call_output") return true;
    if (it?.role === "user" && Array.isArray(it.content) && it.content.some((c) => c?.type === "input_text")) return false;
  }
  return false;
}

const NUDGE_FALSE_BACKGROUND =
  "Your reply states that work is running in the background, but you called no tool this turn, " +
  "so nothing was started and no result will ever arrive. Do one of two things now: actually " +
  "start the work with the appropriate tool (and if it is asynchronous, say which tool you " +
  "used), or correct the statement and tell the user plainly that you have not started it yet. " +
  "Never describe background work as underway unless a tool call actually started it.";

const NUDGE = "You ended your turn without calling any tool, but the user's request is not finished — " +
  "the text above only says what you intend to do. Do it now with the tools you have. If you were " +
  "missing a detail, discover it yourself first (git remotes and config, dotfiles, the environment, " +
  "CLAUDE.md and memory files, earlier sessions) and proceed. Do not reply with text alone again unless " +
  "the task is genuinely complete or you are blocked on something only the user can provide.";
const DEFAULT_TEMP = FILE.temperature != null ? parseFloat(FILE.temperature) : undefined;
const PORT = parseInt(process.env.PORT || "8123", 10);

if (!OPENAI_API_KEY) {
  console.error("[proxy] FATAL: no OpenAI API key (set apiKey in ~/.dbeaver-ai-complete or OPENAI_API_KEY)");
  process.exit(1);
}

// ---------- usage accounting ----------
// OpenAI has no token quota to report and this project key cannot read the org usage API
// (403, missing scope api.usage.read), so the only way to answer "how many tokens have I
// used" for this app is to count them here. Persisted, because the proxy restarts on every
// app launch. GET /usage returns the totals.
const USAGE_FILE = fileURLToPath(new URL("./usage.json", import.meta.url));
let usageState = { since: null, byModel: {} };
try { usageState = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { /* first run */ }
if (!usageState.byModel) usageState = { since: null, byModel: {} };
let usageDirty = false, usageTimer = null;
function recordUsage(model, inTok, outTok, reasoningTok = 0) {
  if (!model) return;
  if (!usageState.since) usageState.since = new Date().toISOString();
  const m = (usageState.byModel[model] ||= { requests: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
  m.requests += 1;
  m.input_tokens += inTok || 0;
  m.output_tokens += outTok || 0;
  m.reasoning_tokens += reasoningTok || 0;
  usageDirty = true;
  // Debounced: a busy agent turn would otherwise rewrite this file dozens of times.
  if (!usageTimer) usageTimer = setTimeout(() => {
    usageTimer = null;
    if (!usageDirty) return;
    usageDirty = false;
    try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usageState, null, 2)); } catch { /* non-fatal */ }
  }, 3000);
}
function usageSummary() {
  const totals = { requests: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  for (const m of Object.values(usageState.byModel)) for (const k of Object.keys(totals)) totals[k] += m[k] || 0;
  return { since: usageState.since, total: { ...totals, tokens: totals.input_tokens + totals.output_tokens },
           by_model: usageState.byModel,
           note: "Counted by this proxy only. OpenAI has no token allowance to report; the account limit is per-minute (see x-ratelimit-* headers) plus dollar billing. This key cannot read the org usage API." };
}

// ---------- helpers ----------
const rid = (p) => p + crypto.randomBytes(16).toString("hex");
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
// Date included on purpose. With time-of-day alone, any measurement across the log's day
// boundary silently wraps — which produced two wrong latency figures while diagnosing the
// classifier aborts (a "median 34s" and then a "median 483s", both artefacts) before the
// ambiguity was noticed. UTC, matching the ISO timestamps the rest of the pipeline uses.
const log = (...a) => console.log(`[proxy ${new Date().toISOString().slice(5, 19).replace("T", " ")}]`, ...a);
const sanitizeToolName = (n) => String(n || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
// Flatten an Anthropic tool_result's content to text. Neither OpenAI surface has an
// error flag on tool output, so is_error is marked inline — without it a failed command
// is indistinguishable from a successful one and the model reports success.
function toolResultText(blk) {
  const c = blk.content;
  const body = typeof c === "string" ? c
    : Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text : p?.text ?? `[${p?.type || "content"} omitted by proxy]`)).join("\n")
    : c == null ? "" : JSON.stringify(c);
  return blk.is_error ? `[tool error] ${body}` : body;
}

// A turn with no text and no tool call is useless to the user and indistinguishable from a
// hang. Rather than forward the blank, say what actually happened — the real status and the
// likely cause. This reports a failure; it never invents an answer.
// Should an empty turn be retried? Split out so the carve-outs are testable, because each one
// is a case where retrying is actively wrong:
//   refusal - the refusal IS the answer; asking again just refuses again
//   error   - a hard upstream failure; the message is the useful output
//   incomplete for any reason OTHER than the output cap (content_filter, …) - not a retry's job
//
// An `incomplete` turn caused by the output cap that produced NOTHING is deliberately still
// retried: that is reasoning starvation, and the retry drops reasoning, which is the cure.
// Classifying the 21 empty turns in the log showed why this distinction matters — 10 of them
// were exactly that case, and vetoing on `incomplete` wholesale would have left the largest
// group unfixed. Truncation of a turn that DID produce content is different, and belongs to the
// continue-on-truncation loop, which resumes instead of restarting.
function shouldRetryEmpty(s) {
  if (!s.enabled || !s.allowContinue) return false;
  if (s.hasTool || s.textLen > 0) return false;
  if (s.refusalText || s.streamError) return false;
  if (s.incomplete && s.incompleteReason !== "max_output_tokens") return false;
  return s.retries < s.maxRetries;
}

// Responses events that are normal bookkeeping and safely ignored. Naming them keeps the
// empty-turn notice's `unhandled_events` field meaningful: without this it reported
// `response.created` on every failure, which tells nobody anything.
const BENIGN_EVENTS = new Set([
  "response.created", "response.in_progress", "response.queued",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.done", "response.function_call_arguments.done",
  "response.reasoning_summary_text.done", "response.reasoning_text.delta",
  "response.reasoning_text.done", "rate_limits.updated",
]);

const nowMs = () => Date.now();

function emptyTurnNotice(resp) {
  const status = resp?.status || "completed";
  const reason = resp?.incomplete_details?.reason;
  const out = resp?.usage?.output_tokens;
  const reasoning = resp?.usage?.output_tokens_details?.reasoning_tokens;
  const bits = [`status=${status}`];
  if (reason) bits.push(`reason=${reason}`);
  if (out != null) bits.push(`output_tokens=${out}`);
  if (reasoning) bits.push(`reasoning_tokens=${reasoning}`);
  if (resp?.retries) bits.push(`retries=${resp.retries}`);
  if (resp?.unhandled?.length) bits.push(`unhandled_events=${resp.unhandled.join(",")}`);
  let hint = "";
  if (resp?.error) {
    hint = ` The upstream reported: ${resp.error}.`;
  } else if (reason === "max_output_tokens") {
    hint = reasoning
      ? " The token budget was consumed by reasoning before any answer was produced — raise max_tokens, or lower OPENAI_REASONING_EFFORT / raise OPENAI_THINKING_MIN_BUDGET."
      : " The output token budget was exhausted — raise max_tokens.";
  } else if (status === "no terminal event") {
    // The fingerprint of every empty turn in the log: no content, no usage, and neither
    // response.completed nor response.incomplete ever arrived. Say that, rather than claiming
    // the model completed normally and simply chose to say nothing.
    hint = " The upstream stream ended without reporting a result, so this is a transport" +
           " failure rather than the model declining to answer. Sending the message again" +
           " usually works.";
  }
  return `[proxy] The model returned no content for this turn (${bits.join(", ")}). ` +
         `No tool was called, so nothing ran.${hint}`;
}

// ---- automatic compaction (github issue #4) ----
// The app showed "Your context window is full ... Prompt is too long". Claude Code has its
// own auto-compaction, but it sizes the window from the model it THINKS it is talking to
// (claude-opus-4-8) while the proxy actually calls gpt-5.3-codex, so its threshold never
// trips and OpenAI rejects the request outright with:
//   400 "Your input exceeds the context window of this model. Please adjust your input and
//        try again."
// The models endpoint reports no context_window, so the limit cannot be read ahead of time —
// compaction is therefore reactive: catch that error, shrink the conversation, retry.
const CONTEXT_ERROR_RE = /exceeds the context window|context[_ ]length[_ ]exceeded|maximum context length|too many tokens|reduce the length/i;

// What gets shrunk, and why only this. Tool OUTPUT is where an agent conversation's tokens
// actually live — file contents and command output, measured at ~110k input tokens per
// request. Their *content* is truncated rather than the items removed, because a
// function_call and its function_call_output are separate top-level items joined by call_id:
// dropping one side breaks the pairing and OpenAI rejects the request. Truncating content
// keeps the structure exactly intact.
const TRIMMED = "[earlier tool output trimmed by the proxy to fit the model's context window]";

function compactResponsesInput(input, keepRecent) {
  if (!Array.isArray(input)) return { input, trimmed: 0, reclaimed: 0 };
  const cutoff = Math.max(0, input.length - keepRecent);
  let trimmed = 0, reclaimed = 0;
  const out = input.map((item, i) => {
    if (i >= cutoff) return item;                                  // recent turns stay whole
    if (item?.type === "function_call_output" && typeof item.output === "string"
        && item.output.length > TRIMMED.length && item.output !== TRIMMED) {
      reclaimed += item.output.length - TRIMMED.length;
      trimmed++;
      return { ...item, output: TRIMMED };
    }
    return item;
  });
  return { input: out, trimmed, reclaimed };
}

// Same idea on the chat surface, where tool results are role:"tool" messages.
function compactChatMessages(messages, keepRecent) {
  if (!Array.isArray(messages)) return { messages, trimmed: 0, reclaimed: 0 };
  const cutoff = Math.max(0, messages.length - keepRecent);
  let trimmed = 0, reclaimed = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m?.role === "tool" && typeof m.content === "string"
        && m.content.length > TRIMMED.length && m.content !== TRIMMED) {
      reclaimed += m.content.length - TRIMMED.length;
      trimmed++;
      return { ...m, content: TRIMMED };
    }
    return m;
  });
  return { messages: out, trimmed, reclaimed };
}

// Escalation ladder: keep 12 recent items, then 6, then 2. Each pass reclaims more.
const COMPACT_STEPS = [12, 6, 2];

// Caps on what the summariser itself is fed, so the compaction call cannot blow its own
// context: at most this much of each result, and this much in total.
const SUMMARY_PER_ITEM = 4000;
const SUMMARY_TOTAL = 120000;
const SUMMARY_MAX_TOKENS = 1500;

// Ask a cheap model to condense the region being dropped. Returns null on any failure, which
// makes the caller fall back to plain truncation — summarising must never be able to break a
// request that truncation alone would have fixed.
async function summariseDropped(pieces) {
  if (!pieces.length) return null;
  // Split the budget EVENLY rather than first-come-first-served. With a greedy budget, 36
  // results at 4000 chars each blew the 120k total and the last items were fed nothing —
  // observed live: a marker planted in result 31 of 36 was absent from the digest while ones
  // in results 7 and 19 survived. An even share means every dropped result is represented.
  const perItem = Math.max(400, Math.min(SUMMARY_PER_ITEM, Math.floor(SUMMARY_TOTAL / pieces.length)));
  const parts = pieces.map(({ label, text }) => `### ${label}\n${text.slice(0, perItem)}`);
  const prompt =
    "You are compacting an AI coding agent's conversation to fit a context window. Below are " +
    "tool results that are about to be dropped. Write a dense factual digest that preserves " +
    "what a coding agent would still need: file paths, symbol and function names, key values, " +
    "errors, counts, and conclusions reached. Omit boilerplate and repetition. Use terse " +
    "bullets. Do not invent anything not present below.\n\n" + parts.join("\n\n");
  try {
    const r = await fetch(`${OPENAI_BASE}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: COMPACT_MODEL, max_output_tokens: SUMMARY_MAX_TOKENS,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) { log(`  ! compaction summary failed (${r.status}); falling back to truncation`); return null; }
    const j = await r.json();
    let text = "";
    for (const it of j.output || [])
      if (it.type === "message") for (const c of it.content || []) if (c.type === "output_text") text += c.text || "";
    text = text.trim();
    if (!text) { log("  ! compaction summary came back empty; falling back to truncation"); return null; }
    return text;
  } catch (e) {
    log(`  ! compaction summary error (${e.message}); falling back to truncation`);
    return null;
  }
}

// Compact, and if summarisation is enabled put a digest of what was dropped into the OLDEST
// trimmed slot. No items are added or removed, so call_id pairing is untouched — the digest
// simply occupies the place the information used to be.
async function compactResponsesInputSummarised(input, keepRecent, summarise = summariseDropped) {
  const plain = compactResponsesInput(input, keepRecent);
  if (!COMPACT_SUMMARY || !plain.trimmed) return plain;

  // Collect what this pass is discarding, oldest first, with a label the digest can reference.
  const pieces = [];
  let firstTrimmedIdx = -1;
  const cutoff = Math.max(0, input.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    const before = input[i], after = plain.input[i];
    if (before?.type === "function_call_output" && after?.output === TRIMMED && before.output !== TRIMMED) {
      if (firstTrimmedIdx === -1) firstTrimmedIdx = i;
      // find the matching call so the digest can name the tool and its arguments
      const call = input.find((x) => x?.type === "function_call" && x.call_id === before.call_id);
      const label = call ? `${call.name || "tool"} ${String(call.arguments || "").slice(0, 120)}` : `result ${before.call_id}`;
      pieces.push({ label, text: String(before.output || "") });
    }
  }
  const digest = await summarise(pieces);
  if (!digest || firstTrimmedIdx === -1) return plain;

  const out = plain.input.slice();
  out[firstTrimmedIdx] = {
    ...out[firstTrimmedIdx],
    output: `[proxy] ${pieces.length} earlier tool result(s) were compacted to fit the context ` +
            `window. Digest of what they contained:\n\n${digest}`,
  };
  log(`  ! summarised ${pieces.length} dropped tool result(s) into a ${digest.length}-char digest (model ${COMPACT_MODEL})`);
  return { input: out, trimmed: plain.trimmed, reclaimed: plain.reclaimed - digest.length, summarised: true };
}

// ---- tool-argument pruning ----
// The model sometimes invents a parameter that belongs to a DIFFERENT tool: it called
// Workflow with run_in_background (which Agent and Bash have, Workflow does not) and the
// harness rejected the whole call with InputValidationError. The proxy declared each
// tool's schema, so it can drop arguments that schema does not allow instead of letting a
// good call fail. Anything dropped would have been rejected downstream anyway.
function pruneToolArgs(schema, args) {
  if (!schema || typeof args !== "object" || args === null || Array.isArray(args)) return { args, dropped: [] };
  const props = schema.properties;
  // Only prune when the schema actually enumerates its properties and does not opt into
  // extras. A schema with additionalProperties:true accepts anything by design.
  if (!props || typeof props !== "object" || schema.additionalProperties === true) return { args, dropped: [] };
  const allowed = new Set(Object.keys(props));
  const out = {}, dropped = [];
  for (const k of Object.keys(args)) (allowed.has(k) ? (out[k] = args[k]) : dropped.push(k));
  // Never strip a required key even if the schema is malformed — surface it and let the
  // harness complain, rather than silently sending an incomplete call.
  for (const r of schema.required || []) if (r in args && !(r in out)) { out[r] = args[r]; }
  return { args: out, dropped };
}
// Prune by tool name, logging what was removed so it is never silent.
function pruneByName(schemas, name, args) {
  const { args: pruned, dropped } = pruneToolArgs(schemas?.get?.(name), args);
  if (dropped.length) log(`  ! ${name}: dropped ${dropped.length} argument(s) not in its schema: ${dropped.join(", ")}`);
  return pruned;
}

// ---- tool selection ----
// Keep essential tools first, then fill the remaining slots in the agent's original
// order. Returns what was dropped so it can be logged: a silently truncated tool list
// looks exactly like a model that "chose" not to use a tool.
function selectTools(tools, limit) {
  if (!Array.isArray(tools)) return { tools: [], dropped: [] };
  if (tools.length <= limit) return { tools, dropped: [] };
  const keep = [], rest = [];
  for (const t of tools) (isEssentialTool(t.name) ? keep : rest).push(t);
  const out = keep.slice(0, limit);
  for (const t of rest) { if (out.length >= limit) break; out.push(t); }
  const kept = new Set(out);
  return { tools: out, dropped: tools.filter((t) => !kept.has(t)).map((t) => t.name) };
}

// ---- output shaping ----
// Names a request's file-writing tool, so the hint can order the model to CALL it by
// name. A generic "write it to a .svg file" reads as advice, and the model answers with
// raw markup plus "save this as pelican.svg" — narrating the action instead of doing it.
const WRITE_TOOL_RE = /^(write|write_file|create_file|fs_write|edit_file|str_replace(_based)?_editor)$/i;
const findWriteTool = (tools) =>
  (Array.isArray(tools) ? tools.find((t) => WRITE_TOOL_RE.test(String(t?.name || ""))) : null)?.name || null;
// Writing a .svg to disk does NOT display it — that only yields a path the user has to
// open. The harness surfaces a file inline when it is SENT with display:"render", so the
// hint has to name that tool too or the model stops at "here is the file".
const SEND_FILE_TOOL_RE = /^(senduserfile|send_user_file|send_file)$/i;
const findSendFileTool = (tools) =>
  (Array.isArray(tools) ? tools.find((t) => SEND_FILE_TOOL_RE.test(String(t?.name || ""))) : null)?.name || null;

// The tool that actually paints something into the transcript. In this app that is
// mcp__visualize__show_widget ("Show visual content — SVG graphics, diagrams, charts …
// renders inline alongside your text response") — and it is the LAST of the 214 tools,
// so the old blind slice(0,128) dropped it outright.
const RENDER_TOOL_RE = /(show_widget|visuali[sz]e|artifact|canvas|render_(svg|chart|diagram))/i;
const findRenderTool = (tools) =>
  (Array.isArray(tools) ? tools.find((t) => RENDER_TOOL_RE.test(String(t?.name || ""))) : null)?.name || null;

// Tools for inspecting work that runs asynchronously. Without knowing these exist, the
// model answers "I can't show output from a background task" — which is wrong, it just
// has to go and fetch it.
const BG_TOOL_RE = /^(taskoutput|tasklist|taskget|bashoutput)$/i;
const findBgTools = (tools) =>
  (Array.isArray(tools) ? tools : []).map((t) => String(t?.name || "")).filter((n) => BG_TOOL_RE.test(n));

// Tell the model the things it cannot infer about this client's renderer.
function buildFormatHint(tools) {
  const w = findWriteTool(tools);
  const s = findSendFileTool(tools);
  const r = findRenderTool(tools);
  const bg = findBgTools(tools);
  let picture;
  if (r && w) {
    // Both, always: the render tool draws in the transcript but is a transient, size-capped
    // surface, so the file is the durable artifact. Neither substitutes for the other.
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or chart, ALWAYS do both in the same turn: (1) call \`${r}\` with the SVG/markup so it renders inline in your reply, and (2) call \`${w}\` to save the same SVG to a path ending in .svg so it persists as a file. Then state the saved path in one short line. Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to open, save or download anything — displaying and saving it are your job, not theirs.`;
  } else if (r) {
    // Draws in the transcript. A written file is only a path, so rendering comes first.
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or chart, call \`${r}\` with the SVG/markup so it renders inline in your reply. Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to open, save or download anything — displaying it is your job, not theirs.`;
  } else if (w && s) {
    // The full path to something the user actually SEES: create the file, then display it.
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or SVG, do BOTH of these in the same turn: (1) call \`${w}\` to save it to a path ending in .svg, then (2) call \`${s}\` with that path and display:"render" so it is displayed inline. Step 2 is what the user actually sees — a written file alone only gives them a path to open, which does not satisfy "render". Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to open, save or download the file — displaying it is your job, not theirs.`;
  } else if (s) {
    picture = `- Pictures, diagrams and SVG: produce the .svg file and then call \`${s}\` with display:"render" so it is displayed inline. Do NOT tell the user to open or download it.`;
  } else if (w) {
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or SVG, you MUST call the \`${w}\` tool to save it to a path ending in .svg, and then reference that path. Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to save, copy, or open it themselves — creating the file is your job, not theirs.`;
  } else {
    picture = "- Pictures, diagrams and SVG: you have no file tool in this turn, so return the SVG inside a ```svg fenced code block. Do NOT instruct the user to save, copy, or open a file.";
  }
  // Async tools hand back a run summary, not each internal step's stdout. That is a real
  // constraint, but "I can't show you the output" is the wrong conclusion: the output is
  // retrievable, and an unannounced background task looks like a hang.
  const background = bg.length
    ? `- Long-running and background work: state clearly when you start something in the background and what it is doing, so the session never looks stalled. Asynchronous tools (Agent/Workflow/background shell) return a run summary rather than each step's raw output — when the user wants the actual output, fetch it with ${bg.map((n) => `\`${n}\``).join(" / ")} and paste the relevant part into your reply, or run the steps directly in the foreground instead. Never tell the user that output is unavailable or that you cannot show it: retrieve it, or say plainly which foreground command you will run to produce it.`
    : "- Long-running work: state clearly when you start something that will take a while, and report progress as you go, so the session never looks stalled. If output for a step is not available to you, say which command you will run in the foreground to produce it rather than saying it cannot be shown.";
  return [
    "",
    "## Output formatting for this client",
    "- Math: use $...$ for inline math and $$...$$ for display math. Do NOT use \\( \\) or \\[ \\] — this client renders those literally.",
    picture,
    background,
    "- Carry out requests with the tools available to you instead of describing what the user should do.",
    "- Always say something in words. Every turn must contain text, including turns whose main content is a tool call: write one short line naming what you are about to do and why before calling it. A turn that is only a tool call shows the user a bare chip with no explanation.",
    "- Be verbose in your final answer: state what you did, what you found, the evidence for it, and anything you could not verify. Prefer a complete explanation over a terse one.",
  ].join("\n");
}

// Run the task to completion instead of stopping to ask whether to continue. The carve-out
// matters as much as the directive: this must not talk the model out of pausing for things
// that genuinely need a human — destructive or outward-facing actions, real ambiguity.
function buildPersistenceHint() {
  return [
    "",
    "## Working autonomously",
    "- Keep working until the user's request is fully resolved, and only then end your turn. Do not end a turn to ask whether you may take a step you are already able to take.",
    "- Once the request IS fully answered, stop. You may briefly suggest an optional next step, but do not carry it out unless the user asks — finishing is also part of doing the job well.",
    "- Never reply with an offer to act — \"If you want, I can…\", \"Shall I…\", \"Let me know and I'll…\" — when you have the tools to do it. Do it now, then report what you found. Investigation and read-only steps never need permission.",
    "- When the work has several steps, carry out all of them in order, reporting as you go. Do not stop after the first step to ask for confirmation to continue.",
    "- If something fails, try the alternatives available to you before handing the problem back to the user.",
    "- Never say that work is running, started, queued or happening in the background unless a tool call in this turn actually started it. If you have not started it, say so plainly or start it now — a user told that something is running will wait for a result that never comes.",
    // The observed stall: asked for the most recently abandoned Gerrit CLs, the model
    // replied "which Gerrit host/project should I query?" and ended the turn. That detail
    // was discoverable from git remotes, dotfiles and the project's own memory files.
    "- Missing details are something to go and find, not a reason to stop. Before asking the user for a value you could discover yourself — a host, URL, path, account, project or branch name — look for it with the tools you have: git remotes and config, dotfiles and config files in the repo, the environment, CLAUDE.md and memory files, and earlier sessions. Only ask if that search actually fails, and then say what you already tried.",
    "- Do stop and ask when the next action is destructive, irreversible, or sends something outward; when you need a credential or a decision only the user can make; or when the request is genuinely ambiguous in a way that changes what you would build. In those cases state exactly what you need and why.",
    "",
    // Issue #7. Working autonomously for many turns is opaque: the session shows tool cards
    // and, for a task change, only a collapsed label. Narration is the only thing that makes
    // a long unattended run followable. The last bullet is the guard — "be verbose" invites
    // padding, which is what issue #1 complained about.
    "## Narrating your work",
    "- Say what you are doing as you go. Before starting a new step, write one short line naming what you are about to do and why. One line per step, not per tool call.",
    "- When a step finishes, say what actually came back — the number, the filename, the error, the verdict. Do not just move on to the next tool call in silence.",
    "- When you add, start or finish a task, restate the list in your text: what you just finished, what you are starting, and what is left. The task tools do not show this to the user, so if you do not write it down nobody sees it.",
    "- Narration is information, never padding. No restating the request back, no announcing what you are about to summarise, no \"great question\", no filler adjectives. If a line would not tell the user something new, leave it out.",
  ].join("\n");
}

// enable=false for the safety-classifier call: it is a separate LLM with its own
// expected output shape, and appending these rules to its prompt is off-task.
const withFormatHint = (sys, enable = true, tools = null) => {
  if (!enable) return sys;
  const parts = [];
  if (OUTPUT_FIXUPS) parts.push(buildFormatHint(tools));
  if (PERSISTENCE) parts.push(buildPersistenceHint());
  return parts.length ? `${sys || ""}\n${parts.join("\n")}` : sys;
};

// Rewrite TeX delimiters the renderer doesn't understand into the ones it does.
// Stateful and streaming-safe: text arrives in arbitrary chunks, so a delimiter or a
// ``` fence can straddle a chunk boundary. Never rewrites inside a fenced code block,
// which would corrupt code samples (and LaTeX shown *as* code).
function makeMathFixer() {
  let carry = "";        // trailing bytes that might start a fence/delimiter
  let inFence = false;
  // Replacer FUNCTIONS, not strings: "$$" in a replacement string means a literal
  // single "$", which would silently turn display math into inline math.
  const rewrite = (s) => s
    .replace(/\\[[\]]/g, () => "$$")
    .replace(/\\[()]/g, () => "$");
  function process(text, final) {
    let s = carry + text;
    carry = "";
    let out = "";
    for (;;) {
      const i = s.indexOf("```");
      if (i !== -1) {
        // Consume complete fences FIRST. Holding a tail back before this would split a
        // chunk that ends in exactly ``` (keeping 2 backticks, emitting 1), so the fence
        // would never be recognised and the in/out-of-code state would invert.
        const seg = s.slice(0, i);
        out += (inFence ? seg : rewrite(seg)) + "```";
        inFence = !inFence;
        s = s.slice(i + 3);
        continue;
      }
      // No complete fence remains. Hold back a tail that could still grow into one, or
      // into a \x delimiter, so it is never rewritten or emitted half-formed.
      if (!final) {
        const m = s.match(/(`{1,2}|\\)$/);
        if (m) { carry = m[0]; s = s.slice(0, -m[0].length); }
      }
      out += inFence ? s : rewrite(s);
      break;
    }
    return out;
  }
  return {
    push: (text) => (OUTPUT_FIXUPS ? process(String(text ?? ""), false) : String(text ?? "")),
    flush: () => (OUTPUT_FIXUPS && carry ? process("", true) : ""),
  };
}
// One-shot form for non-streaming responses.
function fixMath(text) {
  if (!OUTPUT_FIXUPS || !text) return text;
  const f = makeMathFixer();
  return f.push(text) + f.flush();
}

// ---- task echo (issue #7) ----
//
// When the agent changes its task list the session shows only a collapsed label. That is not
// something this build can restyle: the chat UI is the remote claude.ai app. What the tools
// hand back carries no list either — verified in CLI 2.1.217:
//   TaskUpdate -> "Updated task #3 status"
//   TodoWrite  -> "Todos have been modified successfully. Ensure that you continue to use…"
//   TodoWrite's renderToolUseMessage() returns null
// The full list appears in exactly one place, a NUDGE that only fires when the task tools have
// been idle ("Here are the existing tasks:\n\n#1. [completed] …"), and it is marked isMeta.
//
// So the proxy renders the list itself, as a text block next to the tool call. It is a
// rendering of what the model actually did — read from its own tool-call arguments and from
// the transcript — never invented.
const TASK_ECHO = (process.env.OPENAI_TASK_ECHO || PROJECT.OPENAI_TASK_ECHO || "1") !== "0";
const taskToolKind = (name) => (
  name === "TaskCreate" ? "create" :
  name === "TaskUpdate" ? "update" :
  name === "TodoWrite" ? "todos" : null);

const STATUS_MARK = { completed: "x", in_progress: "~", pending: " " };
const newTaskState = () => ({ byId: new Map(), todos: null, created: [], changed: [] });

// "#1. [completed] Assemble runnable app tree" — the exact shape the CLI's task_reminder
// builds (`#${o.id}. [${o.status}] ${o.subject}`), which is the only authoritative list the
// proxy ever sees.
const REMINDER_LINE_RE = /^#(\S+)\.\s*\[([a-z_]+)\]\s*(.+)$/gm;
function parseTaskReminder(text) {
  const out = [];
  if (!text || !text.includes("Here are the existing tasks")) return out;
  const after = text.slice(text.indexOf("Here are the existing tasks"));
  for (const m of after.matchAll(REMINDER_LINE_RE)) out.push({ id: m[1], status: m[2], subject: m[3].trim() });
  return out;
}

function applyTaskCall(state, name, input) {
  const kind = taskToolKind(name);
  if (!kind || !input || typeof input !== "object") return false;
  if (kind === "todos") {
    // TodoWrite always carries the WHOLE list, so this echo is exact and complete.
    if (Array.isArray(input.todos)) { state.todos = input.todos; return true; }
    return false;
  }
  if (kind === "create") {
    // Ids are assigned server-side, so a create has no id to show yet — say so rather than
    // inventing one.
    const list = Array.isArray(input.tasks) ? input.tasks : [input];
    let any = false;
    for (const t of list) {
      const subject = t?.subject || t?.content || t?.description;
      if (subject) { state.created.push({ subject: String(subject), status: t?.status || "pending" }); any = true; }
    }
    return any;
  }
  const id = input.taskId ?? input.id;
  if (id == null) return false;
  const key = String(id);
  const prev = state.byId.get(key) || { status: "pending", subject: "" };
  const next = { status: input.status || prev.status, subject: input.subject || prev.subject };
  state.byId.set(key, next);
  const fields = ["status", "subject", "description", "owner", "activeForm"].filter((f) => input[f] !== undefined);
  state.changed.push({ id: key, from: prev.status, to: next.status, fields });
  return true;
}

// Rebuild what the list looked like BEFORE this turn, from the transcript alone: the reminder
// blocks give ids/subjects/statuses, and replaying earlier task tool calls carries forward
// changes made after the last reminder.
function collectPriorTasks(body) {
  const state = newTaskState();
  for (const m of body?.messages || []) {
    const content = m?.content;
    if (typeof content === "string") {
      if (m.role === "user") for (const t of parseTaskReminder(content)) state.byId.set(t.id, { status: t.status, subject: t.subject });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (m.role === "user" && blk?.type === "text") {
        for (const t of parseTaskReminder(blk.text)) state.byId.set(t.id, { status: t.status, subject: t.subject });
      } else if (m.role === "assistant" && blk?.type === "tool_use") {
        applyTaskCall(state, blk.name, blk.input);
      }
    }
  }
  state.created = [];   // only THIS turn's creations are news
  state.changed = [];
  return state;
}

// Renders the list as a markdown checklist. Returns null when there is nothing worth showing,
// so a no-op task call never adds noise.
function renderTaskEcho(state) {
  const line = (mark, label, text) => `- [${mark}] ${label}${text}`;
  const rows = [];
  if (state.todos) {
    for (const t of state.todos) rows.push(line(STATUS_MARK[t?.status] ?? " ", "", String(t?.content ?? t?.subject ?? "").trim()));
  } else {
    for (const [id, t] of state.byId) rows.push(line(STATUS_MARK[t.status] ?? " ", `#${id} `, t.subject || "(no subject)"));
    for (const c of state.created) rows.push(line(STATUS_MARK[c.status] ?? " ", "", `${c.subject}  _(new)_`));
  }
  if (!rows.length) return null;
  const all = state.todos
    ? state.todos.map((t) => t?.status)
    : [...state.byId.values()].map((t) => t.status).concat(state.created.map((c) => c.status));
  const n = (s) => all.filter((x) => x === s).length;
  const counts = [n("completed") && `${n("completed")} done`, n("in_progress") && `${n("in_progress")} in progress`,
                  n("pending") && `${n("pending")} to do`].filter(Boolean).join(", ");
  return `**Tasks**${counts ? ` — ${counts}` : ""}\n${rows.join("\n")}`;
}

// Non-streaming form of the same echo: replay this message's task calls onto the prior state
// and append one text block. Mutates `msg` in place and returns whether it added anything.
function appendTaskEcho(msg, body, isCls) {
  if (!TASK_ECHO || isCls || !Array.isArray(msg?.content)) return false;
  const calls = msg.content.filter((c) => c.type === "tool_use" && taskToolKind(c.name));
  if (!calls.length) return false;
  const state = collectPriorTasks(body);
  let changed = false;
  for (const c of calls) if (applyTaskCall(state, c.name, c.input)) changed = true;
  if (!changed) return false;
  const echo = renderTaskEcho(state);
  if (!echo) return false;
  msg.content.push({ type: "text", text: `\n\n${echo}\n` });
  log(`  -> task echo: ${echo.split("\n").length - 1} item(s)`);
  return true;
}

// ---- per-request model routing ----
const OPENAI_MODEL_RE = /^(gpt-|o[1-9]|chatgpt|ft:)/i;

// Claude Code makes several LLM calls that are NOT agent turns: classifiers with a rigid
// output contract. Treating one like an agent turn breaks it, so they are detected here and
// then given the fast model, no injected hints, and no out-of-band reasoning.
//
// There are two families, and only the first used to be recognised:
//
//   1. Bash command-prefix detection: "<policy_spec># Claude Code Code Bash command prefix
//      detection". Answers with a command prefix, or `command_injection_detected`.
//
//   2. The AUTO-MODE SAFETY CLASSIFIER — the call behind "auto mode cannot determine the
//      safety of Bash". Two stages: stage 1 answers "<severity>N</severity> ONLY", stage 2
//      answers "<block>yes</block><category>…</category><reason>…</reason>" or
//      "<block>no</block>", under the instruction "Your ENTIRE response MUST begin with
//      <block>. Do NOT output any analysis, reasoning, or commentary before <block>."
//
// Missing family 2 is what caused issue #6. Its calls went to the slow main model with the
// agent format/persistence hints appended to a prompt that forbids preamble, and with
// hidden reasoning eating the output budget. The CLI retries a few times, then fails
// CLOSED: it denies the action and prints "<model> is temporarily unavailable".
// Needles per family, verified against all 14 real classifier prompts recovered from the
// CLI's own error dumps in /private/tmp/claude-501/auto-mode-classifier-errors.
const PREFIX_RE = new RegExp([
  "risk levels for actions that the Claude Code agent",
  "broader safety framework",
  "command_injection_detected",
].join("|"), "i");
const SAFETY_RE = new RegExp([
  "security monitor for autonomous AI coding agents",    // the real stage-2 opener
  "ENTIRE response MUST begin with <block>",
  "<block>(?:yes|no)</block>",
  "Err on the side of blocking",
  "<severity>N</severity>",
  "Review the classification process",
].join("|"), "i");
const CLASSIFIER_RE = new RegExp(`${PREFIX_RE.source}|${SAFETY_RE.source}`, "i");

// The contract lines sit at the END of a long prompt and a real transcript runs to
// megabytes, so sniff the head AND the tail instead of scanning everything.
const SNIFF = 4000;
const ends = (s) => (s.length <= SNIFF * 2 ? s : `${s.slice(0, SNIFF)}\n${s.slice(-SNIFF)}`);
function classifierPrompt(body) {
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : (body.system || "");
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1];
  let tail = "";
  if (last && last.role === "user") {
    const c = last.content;
    tail = typeof c === "string" ? c
      : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text || "").join("\n") : "";
  }
  return `${ends(String(sys))}\n${ends(tail)}`;
}
let vetoLogged = false;
// Returns "prefix" | "safety" | null. The distinction matters for MODEL choice: see pickModel.
function classifierFamily(body) {
  const text = classifierPrompt(body);
  const family = SAFETY_RE.test(text) ? "safety" : PREFIX_RE.test(text) ? "prefix" : null;
  if (!family) return null;
  // Corroboration, because the needles are just text. A verdict-only call carries no tool
  // list; an agent turn carries the whole toolbox (213 of them here). Without this check a
  // session that merely QUOTES the contract — debugging this very issue, say — would have
  // its own turns misrouted and its hints stripped.
  const n = body.tools?.length ?? 0;
  if (n > CLASSIFIER_MAX_TOOLS) {
    if (!vetoLogged) {
      vetoLogged = true;
      log(`  ! a prompt matched the ${family} classifier contract but carries ${n} tools — treating it as a normal agent turn (logged once)`);
    }
    return null;
  }
  return family;
}
const isClassifierRequest = (body) => classifierFamily(body) !== null;

function pickModel(body, family = classifierFamily(body)) {
  const req = String(body.model || "");
  if (OPENAI_MODEL_RE.test(req)) return req;   // agent already asked for an OpenAI model (e.g. via CLAUDE_CODE_BG_CLASSIFIER_MODEL)
  // Only PREFIX detection goes to the small model. The auto-mode SAFETY verdict keeps the
  // main model, measured by replaying six real classifier requests recovered from the CLI's
  // own error dumps through both models:
  //   - 3 of the 5 <block>-stage requests disagreed, and every disagreement went one way:
  //     gpt-5.3-codex blocked (Production Reads / Production Deploy), gpt-4.1-mini allowed.
  //   - on a 6th, gpt-4.1-mini emitted no verdict at all — it echoed the action back as
  //     {"tool":"Bash","input":"git -C …"} — which is unparseable, so the CLI would retry and
  //     could end up reporting the model unavailable. The small model can CAUSE issue #6.
  //   - gpt-5.3-codex answered every request in the expected shape, including the stage-1
  //     <severity>N</severity> form, in ~2s. Latency was never the problem, so there is
  //     nothing to buy by trading judgment away.
  // The classifier's own prompt says to err on the side of blocking, so a more permissive
  // model is the wrong direction. OPENAI_CLASSIFIER_SAFETY_MODEL overrides this deliberately.
  if (family === "prefix" && OPENAI_CLASSIFIER_MODEL) return OPENAI_CLASSIFIER_MODEL;
  if (family === "safety" && OPENAI_CLASSIFIER_SAFETY_MODEL) return OPENAI_CLASSIFIER_SAFETY_MODEL;
  return OPENAI_MODEL;
}
const apiForModel = (model) => (/codex/i.test(model) ? "responses" : "chat");

function mapFinish(reason, hasTools) {
  if (hasTools) return "tool_use";
  switch (reason) {
    case "length": return "max_tokens";
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "content_filter": return "end_turn";
    default: return "end_turn";
  }
}

// ---------- request translation: Anthropic -> OpenAI ----------
function toOpenAI(body, model, isCls = isClassifierRequest(body)) {
  const messages = [];
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((b) => b.text || "").join("\n")
      : body.system;
    if (sys) messages.push({ role: "system", content: withFormatHint(sys, !isCls, body.tools) });
  }
  for (const m of body.messages || []) {
    const content = m.content;
    if (typeof content === "string") { messages.push({ role: m.role, content }); continue; }
    if (!Array.isArray(content)) continue;
    const text = [], toolCalls = [], toolResults = [];
    for (const blk of content) {
      if (blk.type === "text") text.push(blk.text);
      else if (blk.type === "tool_use")
        toolCalls.push({ id: blk.id, type: "function", function: { name: sanitizeToolName(blk.name), arguments: JSON.stringify(blk.input || {}) } });
      else if (blk.type === "tool_result")
        toolResults.push({ tool_call_id: blk.tool_use_id, content: toolResultText(blk) });
      else if (blk.type === "image") text.push("[image omitted by proxy]");
    }
    if (m.role === "assistant") {
      const msg = { role: "assistant", content: text.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      for (const tr of toolResults) messages.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
      if (text.length) messages.push({ role: "user", content: text.join("\n") });
    }
  }
  const outTokens = Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS);
  // gpt-5.x and o-series require `max_completion_tokens` instead of `max_tokens`;
  // send the right one up front so every call doesn't 400-then-retry.
  const usesCompletionTokens = /^(gpt-5|o[1-9])/.test(model);
  const out = {
    model, messages, stream: !!body.stream,
    ...(usesCompletionTokens ? { max_completion_tokens: outTokens } : { max_tokens: outTokens }),
  };
  const temp = body.temperature ?? DEFAULT_TEMP;
  if (temp != null) out.temperature = temp;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  const nameMap = new Map(); // sanitized -> original, to translate tool_calls back
  const schemas = new Map(); // original tool name -> input_schema, for argument pruning
  if (body.tools?.length) {
    const { tools, dropped } = selectTools(body.tools, MAX_TOOLS_CHAT);
    if (dropped.length) log(`chat cap ${body.tools.length}->${tools.length}; dropped ${dropped.length}: ${dropped.slice(0, 12).join(", ")}${dropped.length > 12 ? ", …" : ""}`);
    out.tools = tools.map((t) => {
      const name = sanitizeToolName(t.name);
      if (name !== t.name) nameMap.set(name, t.name);
      schemas.set(t.name, t.input_schema);
      return { type: "function", function: { name, description: t.description, parameters: t.input_schema } };
    });
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: sanitizeToolName(tc.name) } };
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return { payload: out, nameMap, schemas };
}

// ---------- response translation: OpenAI -> Anthropic (non-streaming) ----------
function toAnthropic(oai, reqModel, nameMap, schemas) {
  const choice = oai.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: fixMath(msg.content) });
  for (const tc of msg.tool_calls || [])
  {
    const nm = (nameMap && nameMap.get(tc.function?.name)) || tc.function?.name;
    content.push({ type: "tool_use", id: tc.id || rid("toolu_"), name: nm, input: pruneByName(schemas, nm, safeParse(tc.function?.arguments || "{}")) });
  }
  return {
    id: rid("msg_"), type: "message", role: "assistant", model: reqModel,
    content,
    stop_reason: mapFinish(choice.finish_reason, (msg.tool_calls || []).length > 0),
    stop_sequence: null,
    usage: { input_tokens: oai.usage?.prompt_tokens || 0, output_tokens: oai.usage?.completion_tokens || 0 },
  };
}

// ---------- OpenAI call with a max_tokens/param fallback ----------
async function callOpenAI(payload) {
  const doFetch = (body) => fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  let res = await doFetch(payload);
  if (res.status === 400) {
    const txt = await res.clone().text();
    let retry = null;
    const cap = txt.match(/at most (\d+)/); // "supports at most N completion tokens"
    if (cap) {
      retry = { ...payload };
      const lim = parseInt(cap[1], 10);
      if (retry.max_tokens != null) retry.max_tokens = Math.min(retry.max_tokens, lim);
      if (retry.max_completion_tokens != null) retry.max_completion_tokens = Math.min(retry.max_completion_tokens, lim);
    }
    if (/max_completion_tokens|max_tokens.*not supported|unsupported.*max_tokens/i.test(txt)) {
      const base = retry || payload;
      retry = { ...base, max_completion_tokens: base.max_tokens ?? base.max_completion_tokens };
      delete retry.max_tokens;
    }
    if (/temperature/i.test(txt)) { // some models allow only the default temperature
      retry = { ...(retry || payload) };
      delete retry.temperature;
    }
    if (retry) res = await doFetch(retry);
    // Context window exceeded -> compact and retry (issue #4).
    if (res.status === 400) {
      const t1 = await res.clone().text();
      if (CONTEXT_ERROR_RE.test(t1)) {
        let body = retry || payload;
        for (const keep of COMPACT_STEPS) {
          const { messages, trimmed, reclaimed } = compactChatMessages(body.messages, keep);
          if (!trimmed) { log(`  ! context exceeded and nothing left to compact (keep=${keep})`); break; }
          log(`  ! context exceeded — compacted ${trimmed} tool result(s), reclaimed ~${Math.round(reclaimed / 4000)}k tokens (keeping last ${keep} messages); retrying`);
          body = { ...body, messages };
          res = await doFetch(body);
          if (res.status !== 400) break;
          const t2 = await res.clone().text();
          if (!CONTEXT_ERROR_RE.test(t2)) break;
        }
      }
    }
  }
  return res;
}

// ---------- SSE streaming: OpenAI -> Anthropic ----------
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

async function streamAnthropic(res, upstream, reqModel, nameMap, schemas = null) {
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });

  const mathFix = makeMathFixer(); // rewrites TeX delimiters across chunk boundaries
  let textIndex = null;          // anthropic index of the text block, once opened
  const toolBlocks = new Map();  // openai tool index -> {aIndex, started}
  let nextIndex = 0;             // content-block index counter; text is NOT pre-reserved,
                                 // otherwise a tool-only turn leaves a hole at index 0
  let finish = null, usage = null;

  const ensureText = () => {
    if (textIndex === null) {
      textIndex = nextIndex++;
      sse(res, "content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
    }
    return textIndex;
  };

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk; try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const ch = chunk.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) {
        ensureText();
        const fixed = mathFix.push(d.content);
        if (fixed) sse(res, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: fixed } });
      }
      for (const tc of d.tool_calls || []) {
        let tb = toolBlocks.get(tc.index);
        if (!tb) {
          tb = { aIndex: nextIndex++, started: false };
          toolBlocks.set(tc.index, tb);
        }
        if (!tb.started && (tc.id || tc.function?.name)) {
          tb.toolName = (nameMap && nameMap.get(tc.function?.name)) || tc.function?.name || "";
          sse(res, "content_block_start", { type: "content_block_start", index: tb.aIndex, content_block: { type: "tool_use", id: tc.id || rid("toolu_"), name: tb.toolName, input: {} } });
          tb.started = true;
        }
        // Buffer, then prune once complete (see pruneToolArgs).
        if (tc.function?.arguments) tb.argBuf = (tb.argBuf || "") + tc.function.arguments;
      }
    }
  }
  if (textIndex !== null) {
    const tail = mathFix.flush(); // emit any held-back partial delimiter
    if (tail) sse(res, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: tail } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
  }
  for (const tb of toolBlocks.values()) {
    if (!tb.started) continue;
    const pruned = pruneByName(schemas, tb.toolName, safeParse(tb.argBuf || "{}"));
    sse(res, "content_block_delta", { type: "content_block_delta", index: tb.aIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(pruned) } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: tb.aIndex });
  }
  recordUsage(reqModel, usage?.prompt_tokens, usage?.completion_tokens, usage?.completion_tokens_details?.reasoning_tokens);
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: mapFinish(finish, toolBlocks.size > 0), stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens || 0 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ================= OpenAI Responses API path (for codex / responses-only models) =================
// Anthropic Messages -> Responses request
function toResponses(body, model, isCls = isClassifierRequest(body)) {
  const input = [];
  for (const m of body.messages || []) {
    const content = m.content;
    if (typeof content === "string") {
      input.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const text = [], toolCalls = [], toolResults = [];
    for (const blk of content) {
      if (blk.type === "text") text.push(blk.text);
      else if (blk.type === "tool_use") toolCalls.push({ type: "function_call", call_id: blk.id, name: sanitizeToolName(blk.name), arguments: JSON.stringify(blk.input || {}) });
      else if (blk.type === "tool_result") toolResults.push({ type: "function_call_output", call_id: blk.tool_use_id, output: toolResultText(blk) });
      else if (blk.type === "image") text.push("[image omitted by proxy]");
    }
    if (m.role === "assistant") {
      if (text.length) input.push({ role: "assistant", content: [{ type: "output_text", text: text.join("\n") }] });
      for (const tc of toolCalls) input.push(tc);
    } else {
      for (const tr of toolResults) input.push(tr); // tool results are top-level items, not user content
      if (text.length) input.push({ role: "user", content: [{ type: "input_text", text: text.join("\n") }] });
    }
  }
  const out = { model, input, stream: !!body.stream, max_output_tokens: Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS) };
  // Both fields are required for summaries to appear; effort alone or summary alone gives none.
  //
  // Never for a classifier call. Two independent reasons: its prompt asks for reasoning IN
  // BAND, inside <thinking> tags that the CLI parses itself, so out-of-band reasoning is not
  // just useless but a contract violation — the answer must START with the verdict tag. And
  // hidden reasoning is charged to the same output budget, which is how a verdict comes back
  // empty and the CLI concludes the model is unavailable.
  if (!isCls && SHOW_THINKING && out.max_output_tokens >= THINKING_MIN_BUDGET) {
    out.reasoning = { effort: effortFor(model), summary: "detailed" };
  }
  // Verbosity shapes agent prose; a verdict has a fixed shape and does not want padding.
  if (VERBOSITY && !isCls) out.text = { ...(out.text || {}), verbosity: VERBOSITY };
  if (body.system) out.instructions = withFormatHint(Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : body.system, !isCls, body.tools);
  const nameMap = new Map();
  const schemas = new Map(); // original tool name -> input_schema, for argument pruning
  if (body.tools?.length) {
    // No cap on this surface (verified up to 512), so the agent keeps every tool.
    const { tools, dropped } = selectTools(body.tools, MAX_TOOLS_RESPONSES);
    if (dropped.length) log(`responses cap ${body.tools.length}->${tools.length}; dropped ${dropped.length}`);
    out.tools = tools.map((t) => { // Responses tools are flat: {type,name,description,parameters}
      const name = sanitizeToolName(t.name);
      if (name !== t.name) nameMap.set(name, t.name);
      schemas.set(t.name, t.input_schema);
      return { type: "function", name, description: t.description, parameters: t.input_schema };
    });
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool") out.tool_choice = { type: "function", name: sanitizeToolName(tc.name) };
  }
  // temperature intentionally omitted — codex/reasoning models only accept the default.
  return { payload: out, nameMap, schemas };
}

async function callResponses(payload) {
  const doFetch = (b) => fetch(`${OPENAI_BASE}/responses`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(b) });
  let res = await doFetch(payload);
  if (res.status === 400) {
    const txt = await res.clone().text();
    const cap = txt.match(/at most (\d+)/);
    if (cap && payload.max_output_tokens != null) res = await doFetch({ ...payload, max_output_tokens: Math.min(payload.max_output_tokens, parseInt(cap[1], 10)) });
    // Context window exceeded -> compact the conversation and retry (issue #4).
    else if (CONTEXT_ERROR_RE.test(txt)) {
      let body = payload;
      for (const keep of COMPACT_STEPS) {
        const { input, trimmed, reclaimed, summarised } = await compactResponsesInputSummarised(body.input, keep);
        if (!trimmed) { log(`  ! context exceeded and nothing left to compact (keep=${keep})`); break; }
        log(`  ! context exceeded — compacted ${trimmed} tool result(s)${summarised ? " (summarised)" : ""}, reclaimed ~${Math.round(reclaimed / 4000)}k tokens (keeping last ${keep} items); retrying`);
        body = { ...body, input };
        res = await doFetch(body);
        if (res.status !== 400) break;
        const t2 = await res.clone().text();
        if (!CONTEXT_ERROR_RE.test(t2)) break;
      }
    }
    // Walk the effort ladder down until the model accepts one.
    else if (payload.reasoning?.effort && /not supported with the .* model/i.test(txt)) {
      let effort = payload.reasoning.effort, next, body = payload;
      while ((next = lowerEffort(payload.model, effort))) {
        body = { ...body, reasoning: { ...body.reasoning, effort: next } };
        res = await doFetch(body);
        if (res.status !== 400) break;
        const t2 = await res.clone().text();
        if (!/not supported with the .* model/i.test(t2)) break;
        effort = next;
      }
    }
  }
  return res;
}

function logTurnEnd(surface, resp, toolCount, textLen) {
  const status = resp?.status || "completed";
  const reason = resp?.incomplete_details?.reason;
  const out = resp?.usage?.output_tokens ?? "?";
  const verdict = toolCount ? `${toolCount} tool call(s)` : (textLen ? "text only — TURN ENDS, agent waits for user" : "EMPTY");
  log(`  <- ${surface} status=${status}${reason ? "/" + reason : ""} out_tokens=${out} text=${textLen}ch -> ${verdict}`);
}

function respStopReason(resp, hasTool) {
  if (hasTool) return "tool_use";
  if (resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
  return "end_turn";
}

// Responses (non-streaming) -> Anthropic message
function fromResponses(resp, reqModel, nameMap, schemas) {
  const content = [];
  let hasTool = false;
  // filled in below if nothing else is
  for (const item of resp.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) if (c.type === "output_text" && c.text) content.push({ type: "text", text: fixMath(c.text) });
    } else if (item.type === "function_call") {
      hasTool = true;
      {
        const nm = (nameMap && nameMap.get(item.name)) || item.name;
        content.push({ type: "tool_use", id: item.call_id || item.id, name: nm, input: pruneByName(schemas, nm, safeParse(item.arguments || "{}")) });
      }
    } // reasoning items are dropped
  }
  if (!content.length) {
    content.push({ type: "text", text: emptyTurnNotice(resp) });
    log("  ! empty turn — substituted a diagnostic notice instead of blank output");
  }
  return {
    id: rid("msg_"), type: "message", role: "assistant", model: reqModel, content,
    stop_reason: respStopReason(resp, hasTool), stop_sequence: null,
    usage: { input_tokens: resp.usage?.input_tokens || 0, output_tokens: resp.usage?.output_tokens || 0 },
  };
}

// Responses SSE -> Anthropic SSE
async function streamResponses(res, upstream, reqModel, nameMap, payload = null, allowContinue = false, schemas = null, taskState = null) {
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });
  const items = new Map(); // Responses item_id -> {aIndex, opened, closed}
  let nextIndex = 0, hasTool = false, usage = null, incomplete = false;
  let toolCount = 0, textLen = 0, thinkLen = 0;   // for the turn-end diagnostic
  let taskChanged = false;                       // a task tool ran this turn (issue #7)
  let sawTerminal = null;                        // "completed"|"incomplete"|"failed"|"error", or null if the stream just stopped
  let streamError = null;                        // message from an error / response.failed event
  let refusalText = "";                          // a refusal is content, and must not be retried
  const unknownEvents = new Set();               // SSE event types this proxy does not handle
  let incompleteReason = null;                   // as reported by the API, never assumed
  let totalOutTokens = 0;                        // cumulative across continuations
  const open = (itemId, cb) => {
    let it = items.get(itemId);
    if (!it) { it = { aIndex: nextIndex++, opened: false, closed: false }; items.set(itemId, it); }
    if (!it.opened) { sse(res, "content_block_start", { type: "content_block_start", index: it.aIndex, content_block: cb }); it.opened = true; }
    return it;
  };
  const close = (itemId) => {
    const it = items.get(itemId);
    if (it && it.opened && !it.closed) {
      if (it.mathFix) { const tail = it.mathFix.flush(); if (tail) sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: tail } }); }
      sse(res, "content_block_stop", { type: "content_block_stop", index: it.aIndex });
      it.closed = true;
    }
  };

  let turnText = "";        // this upstream's plain text, for the unfulfilled-intent check
  let streamBytes = 0, streamMs = 0;   // to characterise a stream that ends with no terminal event
  // Consume ONE upstream response, emitting into the message already in progress.
  async function consume(up) {
    turnText = "";
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    const startedAt = nowMs();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      streamBytes += value?.length || 0;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      let j; try { j = JSON.parse(t.slice(5).trim()); } catch { continue; }
      switch (j.type) {
        case "response.output_item.added":
          if (j.item?.type === "function_call") {
            hasTool = true; toolCount++;
            const nm = (nameMap && nameMap.get(j.item.name)) || j.item.name || "";
            const it = open(j.item.id, { type: "tool_use", id: j.item.call_id || j.item.id, name: nm, input: {} });
            it.toolName = nm; it.argBuf = "";   // buffered so the args can be pruned before the client sees them
          }
          break;
        // Reasoning summary -> Anthropic thinking block. Deliberately NOT added to
        // turnText: thinking is not a tool call and must not affect the auto-continue
        // decision, which looks only at the model's spoken text.
        case "response.reasoning_summary_part.added":
          if (SHOW_THINKING && j.item_id) open(j.item_id, { type: "thinking", thinking: "" });
          break;
        case "response.reasoning_summary_text.delta":
          if (SHOW_THINKING && j.delta) {
            const it = open(j.item_id, { type: "thinking", thinking: "" });
            thinkLen += String(j.delta).length;
            sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "thinking_delta", thinking: j.delta } });
          }
          break;
        case "response.reasoning_summary_part.done":
          if (j.item_id) close(j.item_id);
          break;
        case "response.output_text.delta":
          {
            const it = open(j.item_id, { type: "text", text: "" });
            if (!it.mathFix) it.mathFix = makeMathFixer();
            textLen += String(j.delta ?? "").length;
            turnText += String(j.delta ?? "");
            const fixed = it.mathFix.push(j.delta);
            if (fixed) sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: fixed } });
          }
          break;
        case "response.function_call_arguments.delta":
          // Accumulate rather than forward: pruning needs the whole JSON object. Tool
          // arguments are small, and the client assembles them before executing anyway.
          { const it = items.get(j.item_id); if (it) it.argBuf = (it.argBuf || "") + (j.delta || ""); }
          break;
        case "response.output_item.done":
          if (j.item?.id) {
            const it = items.get(j.item.id);
            if (it && it.argBuf !== undefined) {
              // A truncated turn can cut a tool call's arguments in half. Say so — an empty
              // or partial argument object otherwise looks like the model's own choice.
              if (it.argBuf && !it.argBuf.trim().endsWith("}")) {
                log(`  ! ${it.toolName}: arguments look truncated (${it.argBuf.length} chars, no closing brace) — the turn probably hit max_output_tokens`);
              }
              const pruned = pruneByName(schemas, it.toolName, safeParse(it.argBuf || "{}"));
              sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(pruned) } });
              // Record the task change while the arguments are in hand (issue #7).
              if (taskState && applyTaskCall(taskState, it.toolName, pruned)) taskChanged = true;
              it.argBuf = undefined;
            }
            close(j.item.id);
          }
          break;
        case "response.completed": usage = j.response?.usage; sawTerminal = "completed"; break;
        case "response.incomplete":
          usage = j.response?.usage;
          incomplete = true;
          sawTerminal = "incomplete";
          // Take the reason the API actually gave. This used to be hardcoded to
          // max_output_tokens, which made the empty-turn notice assert a cause it had not
          // verified and hand out budget advice that might not apply.
          incompleteReason = j.response?.incomplete_details?.reason || incompleteReason || "unknown";
          break;
        // A refusal produces no output_text at all, so without this the turn looked empty and
        // the reason was invisible. Surface it as text: the user is entitled to see it, and a
        // refusal must NOT be retried — the model will refuse again.
        case "response.refusal.delta":
          if (j.delta) {
            const it = open(j.item_id || "__refusal__", { type: "text", text: "" });
            refusalText += String(j.delta);
            textLen += String(j.delta).length;
            sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: String(j.delta) } });
          }
          break;
        // Terminal failures. Neither of these was handled, so an upstream error mid-stream
        // produced a silent empty turn that the notice then blamed on "status=completed".
        case "response.failed":
          sawTerminal = "failed";
          streamError = j.response?.error?.message || j.response?.error?.code || "response.failed with no detail";
          break;
        case "error":
          sawTerminal = sawTerminal || "error";
          streamError = j.message || j.error?.message || j.code || "error event with no detail";
          break;
        default:
          // Unknown events are usually harmless bookkeeping, but a silently-dropped one is
          // exactly how the empty turn hid. Record the names once so the next occurrence is
          // explainable instead of mysterious.
          if (typeof j.type === "string" && !BENIGN_EVENTS.has(j.type)) unknownEvents.add(j.type);
          break;
      }
      }
    }
    streamMs = nowMs() - startedAt;
    if (!sawTerminal) {
      // The fingerprint of the failure in issue-report terms: the upstream hung up without
      // saying completed or incomplete. Recording bytes and duration makes it measurable
      // instead of anecdotal.
      log(`  ! upstream stream ended with NO terminal event after ${streamMs}ms and ${streamBytes} byte(s)`);
    }
    for (const id of items.keys()) close(id);
  }

  await consume(upstream);
  totalOutTokens += usage?.output_tokens || 0;

  // Continue the turn in place when it was cut off by the output cap (issue #8). The client
  // otherwise surfaces a truncated answer, or errors outright, and the user has to ask again.
  // Each pass appends to the SAME assistant message, so the cumulative budget below is what
  // keeps the spliced result under the client's own per-response maximum.
  let truncContinued = 0;
  // (textLen || hasTool): there must be something to continue FROM. A turn whose whole budget
  // went to reasoning has nothing, and asking it to "continue" just burns two more starved
  // calls — which is what the log shows happening before this guard existed.
  while (CONTINUE_ON_TRUNCATION && allowContinue && payload && incomplete &&
         incompleteReason === "max_output_tokens" && (textLen > 0 || hasTool) &&
         truncContinued < MAX_CONTINUATIONS && totalOutTokens < MAX_TURN_OUTPUT_TOKENS) {
    truncContinued++;
    const remaining = MAX_TURN_OUTPUT_TOKENS - totalOutTokens;
    log(`  -> continue-on-truncation ${truncContinued}/${MAX_CONTINUATIONS}: cut off at the output cap after ${totalOutTokens} token(s); resuming with ${remaining} left`);
    const carry = turnText.slice(-2000);   // enough context to resume mid-sentence
    const next = {
      ...payload,
      max_output_tokens: Math.max(256, Math.min(payload.max_output_tokens || remaining, remaining)),
      input: [...payload.input,
              { role: "assistant", content: [{ type: "output_text", text: turnText }] },
              { role: "user", content: [{ type: "input_text", text:
                "Your previous message was cut off by the output token limit. Continue it from " +
                "exactly where it stopped. Do not repeat anything already written, do not " +
                "restate the question, and do not open with a preamble — resume mid-sentence if " +
                "that is where it ended. The text ended with: " + JSON.stringify(carry) }] }],
    };
    // Reset the per-pass flags so the next consume() reports its own outcome.
    incomplete = false; incompleteReason = null;
    let up;
    try { up = await callResponses(next); } catch (e) { log(`  -> continue-on-truncation fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> continue-on-truncation got ${up.status}; keeping the truncated turn`); break; }
    payload = next;
    await consume(up);
    totalOutTokens += usage?.output_tokens || 0;
  }
  if (incomplete && incompleteReason === "max_output_tokens" && totalOutTokens >= MAX_TURN_OUTPUT_TOKENS) {
    log(`  ! stopped continuing at ${totalOutTokens} output tokens (ceiling ${MAX_TURN_OUTPUT_TOKENS}) to stay under the client's per-response maximum`);
  }

  // Continue the turn in place when the model only SAID it would act.
  let continued = 0;
  let reason;
  while (AUTO_CONTINUE && allowContinue && payload && !hasTool && !incomplete &&
         continued < MAX_CONTINUATIONS &&
         (reason = continueReason(turnText, workDoneThisTurn(payload.input),
                                  backgroundToolUsedThisTurn(payload.input)))) {
    continued++;
    const why = reason === "false-background"
      ? "claimed background work was running but called no tool — nothing was started"
      : "announced an action but called no tool";
    log(`  -> auto-continue ${continued}/${MAX_CONTINUATIONS} (${reason}): ${why}; re-prompting`);
    const nudge = reason === "false-background" ? NUDGE_FALSE_BACKGROUND : NUDGE;
    const next = {
      ...payload,
      input: [...payload.input,
              { role: "assistant", content: [{ type: "output_text", text: turnText }] },
              { role: "user", content: [{ type: "input_text", text: nudge }] }],
    };
    let up;
    try { up = await callResponses(next); } catch (e) { log(`  -> auto-continue fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> auto-continue got ${up.status}; keeping the original turn`); break; }
    payload = next;
    await consume(up);
    // This was missing: an auto-continued pass produced tokens that were never added to the
    // turn total, so out_tokens under-reported every time this loop fired.
    totalOutTokens += usage?.output_tokens || 0;
  }

  // Show the list the agent just changed, since nothing downstream will (issue #7). Emitted
  // as its own text block AFTER the tool calls, so no existing block's indices move.
  if (TASK_ECHO && taskChanged && taskState) {
    const echo = renderTaskEcho(taskState);
    if (echo) {
      const it = open("__tasks__", { type: "text", text: "" });
      sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: `\n\n${echo}\n` } });
      close("__tasks__");
      textLen += echo.length;
      log(`  -> task echo: ${echo.split("\n").length - 1} item(s)`);
    }
  }

  // A context-window overflow can arrive as a mid-stream `error` event on a 200 response, not
  // only as an HTTP 400. The compaction path in callResponses only ever saw the 400 form, so
  // this shape surfaced as an empty turn with no recovery at all — which is what left the
  // "predict cash flow" session unable to answer anything:
  //   error=Your input exceeds the context window of this model. Please adjust your input...
  // Claude Code's own auto-compaction cannot help here: it sizes the window from the model it
  // thinks it is talking to (a 1M-context Claude), not the model actually being called.
  //
  // Gated on allowContinue, so a classifier turn that overflows fails closed rather than being
  // judged on a silently shortened transcript (issue #6).
  let ctxCompacted = 0;
  while (payload && allowContinue && streamError && CONTEXT_ERROR_RE.test(streamError) &&
         !hasTool && textLen === 0 && ctxCompacted < COMPACT_STEPS.length) {
    const keep = COMPACT_STEPS[ctxCompacted++];
    const { input, trimmed, reclaimed, summarised } =
      await compactResponsesInputSummarised(payload.input, keep);
    if (!trimmed) { log(`  ! context exceeded mid-stream and nothing left to compact (keep=${keep})`); break; }
    log(`  -> context exceeded mid-stream — compacted ${trimmed} tool result(s)` +
        `${summarised ? " (summarised)" : ""}, reclaimed ~${Math.round(reclaimed / 4000)}k tokens` +
        ` (keeping last ${keep}); retrying`);
    payload = { ...payload, input };
    let up;
    try { up = await callResponses(payload); }
    catch (e) { log(`  -> compaction retry fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> compaction retry got ${up.status}; giving up`); break; }
    streamError = null; sawTerminal = null; incomplete = false; incompleteReason = null;
    await consume(up);
    totalOutTokens += usage?.output_tokens || 0;
  }

  // An empty turn used to be reported and then abandoned, which stalls the session: the user
  // sends a message, waits ~40s, and gets a diagnostic instead of work. Ask again instead.
  //
  // Retried only when retrying can plausibly help. NOT for a refusal (the model will refuse
  // again, and the refusal is the answer), NOT for a truncated turn (the truncation loop above
  // owns that), and NOT for a hard upstream failure reported by error/response.failed.
  let emptyRetries = 0;
  while (payload && shouldRetryEmpty({ enabled: EMPTY_RETRY, allowContinue, hasTool, textLen,
                                       refusalText, streamError, incomplete, incompleteReason,
                                       retries: emptyRetries, maxRetries: MAX_EMPTY_RETRIES })) {
    emptyRetries++;
    log(`  -> empty turn, retry ${emptyRetries}/${MAX_EMPTY_RETRIES}` +
        ` (terminal=${sawTerminal || "none"}${unknownEvents.size ? `, unhandled=[${[...unknownEvents].join(",")}]` : ""})`);
    // Drop reasoning on the retry. A turn that burned ~40s and returned nothing was almost
    // certainly spent reasoning, and asking for the same hidden reasoning again reproduces it.
    const { reasoning, ...retry } = payload;
    let up;
    try { up = await callResponses(retry); } catch (e) { log(`  -> empty-turn retry fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> empty-turn retry got ${up.status}; giving up on the retry`); break; }
    sawTerminal = null; streamError = null; incomplete = false; incompleteReason = null;
    await consume(up);
    totalOutTokens += usage?.output_tokens || 0;
  }

  // Never hand back a blank turn (issue #1).
  if (!hasTool && textLen === 0) {
    // Report what the API actually said. `status` used to be inferred as
    // `incomplete ? "incomplete" : "completed"`, so a stream that ended with NO terminal event
    // at all — which is what every empty turn in the log looked like, all with no usage —
    // was reported as "completed" on no evidence whatsoever.
    const notice = emptyTurnNotice({
      status: streamError ? "failed" : (sawTerminal || "no terminal event"),
      incomplete_details: incompleteReason ? { reason: incompleteReason } : undefined,
      usage, error: streamError, retries: emptyRetries,
      unhandled: unknownEvents.size ? [...unknownEvents] : null,
    });
    const it = open("__empty__", { type: "text", text: "" });
    sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: notice } });
    close("__empty__");
    textLen = notice.length;
    log(`  ! empty turn after ${emptyRetries} retr${emptyRetries === 1 ? "y" : "ies"}` +
        ` — terminal=${sawTerminal || "none"}${streamError ? `, error=${streamError}` : ""}` +
        `${unknownEvents.size ? `, unhandled=[${[...unknownEvents].join(",")}]` : ""}`);
  } else if (emptyRetries) {
    log(`  -> recovered after ${emptyRetries} empty-turn retr${emptyRetries === 1 ? "y" : "ies"}`);
  }
  recordUsage(payload?.model, usage?.input_tokens, usage?.output_tokens, usage?.output_tokens_details?.reasoning_tokens);
  const stop = hasTool ? "tool_use" : (incomplete ? "max_tokens" : "end_turn");
  log(`  <- responses stream stop_reason=${stop} out_tokens=${totalOutTokens || (usage?.output_tokens ?? "?")} text=${textLen}ch` +
      (thinkLen ? ` thinking=${thinkLen}ch` : "") + ` -> ` +
      (toolCount ? `${toolCount} tool call(s)` :
       stop === "max_tokens" ? "hit the output cap mid-turn — agent stops" :
       textLen ? "TEXT ONLY, no tool call — turn ends here and the agent waits for the user" : "EMPTY response"));
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage?.output_tokens || 0 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ---------- server ----------
function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
}
function sendJSON(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json" }); res.end(s); }
function anthropicError(res, code, type, message) { sendJSON(res, code, { type: "error", error: { type, message } }); }

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "GET" && (url === "/" || url === "/health"))
    return sendJSON(res, 200, { ok: true, proxy: "anthropic->openai", model: OPENAI_MODEL, api: OPENAI_API, classifier_model: OPENAI_CLASSIFIER_MODEL || null });

  if (req.method === "GET" && url === "/usage") return sendJSON(res, 200, usageSummary());

  if (req.method === "POST" && url === "/v1/messages/count_tokens") {
    const body = safeParse(await readBody(req));
    const txt = JSON.stringify(body.messages || "") + (body.system ? JSON.stringify(body.system) : "");
    return sendJSON(res, 200, { input_tokens: Math.ceil(txt.length / 4) }); // rough estimate
  }

  if (req.method === "GET" && url === "/v1/models") {
    log(`/v1/models discovery -> ${PICKER_MODELS.map((m) => m.id).join(", ")}`);
    return sendJSON(res, 200, {
      data: PICKER_MODELS.map((m) => ({ type: "model", id: m.id, display_name: m.name, created_at: "2025-01-01T00:00:00Z" })),
      has_more: false, first_id: PICKER_MODELS[0]?.id ?? null, last_id: PICKER_MODELS[PICKER_MODELS.length - 1]?.id ?? null,
    });
  }

  if (req.method === "POST" && url === "/v1/messages") {
    const raw = await readBody(req);
    const body = safeParse(raw);
    const reqModel = body.model || OPENAI_MODEL;
    // Decided once per request: it drives the model choice, hint injection, reasoning and
    // whether the turn may be continued, and it logs when it vetoes a match.
    const family = classifierFamily(body);               // "prefix" | "safety" | null
    const isCls = family !== null;
    const model = pickModel(body, family);               // main model, fast classifier model, or passthrough
    const useResp = apiForModel(model) === "responses";  // codex -> Responses, else Chat Completions
    dumpTools(body.tools);

    if (useResp) {
      const { payload, nameMap, schemas } = toResponses(body, model, isCls);
      const hintOn = !isCls && (OUTPUT_FIXUPS || PERSISTENCE);
      log(`/v1/messages [responses] model=${reqModel}->${model} input=${payload.input.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""} hints=${hintOn ? "on" : "off"}${isCls ? ` classifier=${family} reasoning=off` : ""}`);
      let upstream;
      const startedAt = Date.now();
      try { upstream = await callResponses(payload); }
      catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI(responses) fetch failed: ${e.message}`); }
      if (!upstream.ok) {
        const errTxt = await upstream.text();
        log(`OpenAI(responses) ${upstream.status}: ${errTxt.slice(0, 300)}`);
        return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
      }
      if (payload.stream) {
        const mayContinue = !isCls && !!payload.tools?.length;
        const taskState = TASK_ECHO && !isCls ? collectPriorTasks(body) : null;
        try { await streamResponses(res, upstream, reqModel, nameMap, payload, mayContinue, schemas, taskState); }
        catch (e) { log("stream error:", e.message); try { res.end(); } catch {} }
        return;
      }
      { let rj = await upstream.json();
        // Belt and braces for budgets above the threshold that still get starved.
        const starved = rj?.status === "incomplete" &&
          rj?.incomplete_details?.reason === "max_output_tokens" &&
          !(rj.output || []).some((it) => it.type === "message" && (it.content || []).some((c) => c.text));
        if (starved && payload.reasoning) {
          log("  ! empty answer with status=incomplete/max_output_tokens — retrying without reasoning");
          const { reasoning, ...noThink } = payload;
          try {
            const retry = await callResponses(noThink);
            if (retry.ok) rj = await retry.json();
          } catch (e) { log(`  ! retry failed: ${e.message}`); }
        }
        recordUsage(model, rj?.usage?.input_tokens, rj?.usage?.output_tokens, rj?.usage?.output_tokens_details?.reasoning_tokens);
        const msg = fromResponses(rj, reqModel, nameMap, schemas);
        appendTaskEcho(msg, body, isCls);
        if (isCls) {
          // Measured, not inferred: a classifier verdict that approaches the CLI's budget is
          // what produces "temporarily unavailable" and a denied action.
          const ms = Date.now() - startedAt;
          log(`  <- classifier=${family} verdict in ${ms}ms` +
              (ms >= CLASSIFIER_SLOW_MS
                ? ` — SLOW. The CLI aborts its classifier at 60s and then DENIES the action.`
                : ""));
        }
        logTurnEnd("responses", rj, msg.content.filter((c) => c.type === "tool_use").length,
                   msg.content.filter((c) => c.type === "text").reduce((n, c) => n + c.text.length, 0));
        return sendJSON(res, 200, msg); }
    }

    const { payload, nameMap, schemas } = toOpenAI(body, model, isCls);
    log(`/v1/messages [chat] model=${reqModel}->${model} msgs=${payload.messages.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""}${isCls ? ` classifier=${family}` : ""}`);
    let upstream;
    try { upstream = await callOpenAI(payload); }
    catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI fetch failed: ${e.message}`); }
    if (!upstream.ok) {
      const errTxt = await upstream.text();
      log(`OpenAI ${upstream.status}: ${errTxt.slice(0, 300)}`);
      return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
    }
    if (payload.stream) { try { await streamAnthropic(res, upstream, reqModel, nameMap, schemas); } catch (e) { log("stream error:", e.message); try { res.end(); } catch {} } return; }
    const oai = await upstream.json();
    recordUsage(model, oai?.usage?.prompt_tokens, oai?.usage?.completion_tokens,
                oai?.usage?.completion_tokens_details?.reasoning_tokens);
    { const msg = toAnthropic(oai, reqModel, nameMap, schemas);
      appendTaskEcho(msg, body, isCls);
      return sendJSON(res, 200, msg); }
  }

  anthropicError(res, 404, "not_found_error", `no route for ${req.method} ${url}`);
});

// Exported for the unit tests in proxy.test.mjs; set PROXY_NO_LISTEN=1 to import
// this module without binding the port.
export { makeMathFixer, fixMath, selectTools, isEssentialTool, withFormatHint, buildFormatHint,
         buildPersistenceHint, findWriteTool, findSendFileTool, findRenderTool, findBgTools, toolResultText,
         shouldAutoContinue, continueReason, workDoneThisTurn, backgroundToolUsedThisTurn,
         pruneToolArgs, emptyTurnNotice,
         compactResponsesInput, compactChatMessages, CONTEXT_ERROR_RE, COMPACT_STEPS, TRIMMED,
         compactResponsesInputSummarised, summariseDropped,
         isClassifierRequest, classifierFamily, classifierPrompt, CLASSIFIER_RE, PREFIX_RE, SAFETY_RE,
         toResponses, toOpenAI, pickModel,
         taskToolKind, parseTaskReminder, applyTaskCall, collectPriorTasks, renderTaskEcho,
         newTaskState, appendTaskEcho, shouldRetryEmpty, BENIGN_EVENTS };

if (!process.env.PROXY_NO_LISTEN) server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}  ->  ${OPENAI_BASE} (model ${OPENAI_MODEL}, api ${OPENAI_API}${OPENAI_CLASSIFIER_MODEL ? `, classifier ${OPENAI_CLASSIFIER_MODEL}` : ""})`);
});
