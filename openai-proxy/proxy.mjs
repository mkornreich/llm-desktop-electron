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
// Models advertised on GET /v1/models — what the app's gateway model-discovery
// (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) lists in the picker. Selecting one
// makes the agent request that id, which the proxy passes straight through.
// Comma-separated "id:Display Name" pairs; override via OPENAI_PICKER_MODELS.
const PICKER_MODELS = (process.env.OPENAI_PICKER_MODELS || PROJECT.OPENAI_PICKER_MODELS ||
  "gpt-5.3-codex:GPT-5.3 Codex,gpt-5.4:GPT-5.4,gpt-4.1:GPT-4.1,gpt-4.1-mini:GPT-4.1 mini,gpt-4o:GPT-4o")
  .split(",").map((s) => { const [id, ...n] = s.split(":"); return { id: (id || "").trim(), name: (n.join(":").trim() || (id || "").trim()) }; })
  .filter((m) => m.id);
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DEFAULT_MAX_TOKENS = parseInt(FILE.maxTokens || "1024", 10) || 1024;
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
// Reasoning tokens are drawn from the SAME max_output_tokens budget as the answer, so
// asking for thinking on a small-budget call can consume the whole allowance and return
// nothing. Observed in the app: background title calls (max_tokens=64, no tools) came back
// status=incomplete/max_output_tokens with 0 characters of text, four times in a row. The
// same call needs ~10 output tokens with no reasoning and ~26-64 with it. Utility calls
// gain nothing from thinking, so only request it when there is room to spare.
const THINKING_MIN_BUDGET = parseInt(process.env.OPENAI_THINKING_MIN_BUDGET || PROJECT.OPENAI_THINKING_MIN_BUDGET || "2000", 10) || 2000;
const AUTO_CONTINUE = (process.env.OPENAI_AUTO_CONTINUE || PROJECT.OPENAI_AUTO_CONTINUE || "1") !== "0";
const MAX_CONTINUATIONS = parseInt(process.env.OPENAI_MAX_CONTINUATIONS || PROJECT.OPENAI_MAX_CONTINUATIONS || "2", 10) || 2;
// Text that promises or proposes an action rather than reporting one. Deliberately narrow:
// a genuine question the user alone can answer ("which of these three do you want?") should
// still end the turn, so this matches announcements, offers, and "I need X to proceed".
const UNFULFILLED_RE = new RegExp([
  "\\b(i['’]?ll|i will|let me|i['’]?m going to|i am going to|going to)\\b[^.!?]{0,80}\\b(run|query|check|look|search|fetch|pull|list|inspect|read|grep|find|start|do|gather|collect)\\b",
  "\\b(if you want|shall i|would you like me|let me know|want me to|say the word|i can (run|query|check|pull|list|do) that)\\b",
  "\\b(i need|need one|need a|need the)\\b[^.!?]{0,60}\\b(detail|value|host|url|path|name|account|project|credential|info|information)\\b",
  "\\bwhich\\b[^.!?]{0,40}\\b(host|project|repo|repository|account|branch|url)\\b[^.!?]{0,40}\\?",
  "\\b(starting|i['’]?ve started|kicking off)\\b[^.!?]{0,60}\\b(now|in the background)\\b",
].join("|"), "i");
// Overrides the match above. A turn that ends by asking for confirmation of something
// destructive, or for a decision only the user can make, MUST stay ended — auto-continuing
// it would answer the question on the user's behalf and then act. Erring toward not
// continuing is safe: the cost is one "go ahead", which is the behaviour we started from.
const NEEDS_USER_RE = /\b(confirm|are you sure|permanently|irreversibl|destructive|cannot be undone|can['’]?t be undone|before i (proceed|continue)|your (approval|permission)|need your ok|force[- ]?push|rm -rf|drop (table|database))\b/i;
// Continue only on an unfulfilled announcement that is not a confirmation request.
const shouldAutoContinue = (text) => {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (NEEDS_USER_RE.test(t)) return false;
  return UNFULFILLED_RE.test(t);
};

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

// ---------- helpers ----------
const rid = (p) => p + crypto.randomBytes(16).toString("hex");
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const log = (...a) => console.log(`[proxy ${new Date().toISOString().slice(11, 19)}]`, ...a);
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
    "- Never reply with an offer to act — \"If you want, I can…\", \"Shall I…\", \"Let me know and I'll…\" — when you have the tools to do it. Do it now, then report what you found. Investigation and read-only steps never need permission.",
    "- When the work has several steps, carry out all of them in order, reporting as you go. Do not stop after the first step to ask for confirmation to continue.",
    "- If something fails, try the alternatives available to you before handing the problem back to the user.",
    // The observed stall: asked for the most recently abandoned Gerrit CLs, the model
    // replied "which Gerrit host/project should I query?" and ended the turn. That detail
    // was discoverable from git remotes, dotfiles and the project's own memory files.
    "- Missing details are something to go and find, not a reason to stop. Before asking the user for a value you could discover yourself — a host, URL, path, account, project or branch name — look for it with the tools you have: git remotes and config, dotfiles and config files in the repo, the environment, CLAUDE.md and memory files, and earlier sessions. Only ask if that search actually fails, and then say what you already tried.",
    "- Do stop and ask when the next action is destructive, irreversible, or sends something outward; when you need a credential or a decision only the user can make; or when the request is genuinely ambiguous in a way that changes what you would build. In those cases state exactly what you need and why.",
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

// ---- per-request model routing ----
const OPENAI_MODEL_RE = /^(gpt-|o[1-9]|chatgpt|ft:)/i;
// The auto-mode safety classifier's request carries this distinctive system prompt.
function isClassifierRequest(body) {
  const s = Array.isArray(body.system) ? body.system.map((b) => b.text || "").join(" ") : (body.system || "");
  return /risk levels for actions that the Claude Code agent|broader safety framework|command_injection_detected/i.test(s);
}
function pickModel(body) {
  const req = String(body.model || "");
  if (OPENAI_MODEL_RE.test(req)) return req;                              // agent already asked for an OpenAI model (e.g. via CLAUDE_CODE_BG_CLASSIFIER_MODEL)
  if (OPENAI_CLASSIFIER_MODEL && isClassifierRequest(body)) return OPENAI_CLASSIFIER_MODEL; // fast model for the safety classifier
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
function toOpenAI(body, model) {
  const messages = [];
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((b) => b.text || "").join("\n")
      : body.system;
    if (sys) messages.push({ role: "system", content: withFormatHint(sys, !isClassifierRequest(body), body.tools) });
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
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: mapFinish(finish, toolBlocks.size > 0), stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens || 0 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ================= OpenAI Responses API path (for codex / responses-only models) =================
// Anthropic Messages -> Responses request
function toResponses(body, model) {
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
  if (SHOW_THINKING && out.max_output_tokens >= THINKING_MIN_BUDGET) {
    out.reasoning = { effort: REASONING_EFFORT, summary: "detailed" };
  }
  if (body.system) out.instructions = withFormatHint(Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : body.system, !isClassifierRequest(body), body.tools);
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
  return {
    id: rid("msg_"), type: "message", role: "assistant", model: reqModel, content,
    stop_reason: respStopReason(resp, hasTool), stop_sequence: null,
    usage: { input_tokens: resp.usage?.input_tokens || 0, output_tokens: resp.usage?.output_tokens || 0 },
  };
}

// Responses SSE -> Anthropic SSE
async function streamResponses(res, upstream, reqModel, nameMap, payload = null, allowContinue = false, schemas = null) {
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });
  const items = new Map(); // Responses item_id -> {aIndex, opened, closed}
  let nextIndex = 0, hasTool = false, usage = null, incomplete = false;
  let toolCount = 0, textLen = 0, thinkLen = 0;   // for the turn-end diagnostic
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
  // Consume ONE upstream response, emitting into the message already in progress.
  async function consume(up) {
    turnText = "";
    const reader = up.body.getReader();
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
              it.argBuf = undefined;
            }
            close(j.item.id);
          }
          break;
        case "response.completed": usage = j.response?.usage; break;
        case "response.incomplete": usage = j.response?.usage; incomplete = true; break;
      }
      }
    }
    for (const id of items.keys()) close(id);
  }

  await consume(upstream);

  // Continue the turn in place when the model only SAID it would act.
  let continued = 0;
  while (AUTO_CONTINUE && allowContinue && payload && !hasTool && !incomplete &&
         continued < MAX_CONTINUATIONS && shouldAutoContinue(turnText)) {
    continued++;
    log(`  -> auto-continue ${continued}/${MAX_CONTINUATIONS}: announced an action but called no tool; re-prompting`);
    const next = {
      ...payload,
      input: [...payload.input,
              { role: "assistant", content: [{ type: "output_text", text: turnText }] },
              { role: "user", content: [{ type: "input_text", text: NUDGE }] }],
    };
    let up;
    try { up = await callResponses(next); } catch (e) { log(`  -> auto-continue fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> auto-continue got ${up.status}; keeping the original turn`); break; }
    payload = next;
    await consume(up);
  }

  const stop = hasTool ? "tool_use" : (incomplete ? "max_tokens" : "end_turn");
  log(`  <- responses stream stop_reason=${stop} out_tokens=${usage?.output_tokens ?? "?"} text=${textLen}ch` +
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
    const model = pickModel(body);                       // main model, fast classifier model, or passthrough
    const useResp = apiForModel(model) === "responses";  // codex -> Responses, else Chat Completions
    dumpTools(body.tools);

    if (useResp) {
      const { payload, nameMap, schemas } = toResponses(body, model);
      const hintOn = !isClassifierRequest(body) && (OUTPUT_FIXUPS || PERSISTENCE);
      log(`/v1/messages [responses] model=${reqModel}->${model} input=${payload.input.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""} hints=${hintOn ? "on" : "off"}`);
      let upstream;
      try { upstream = await callResponses(payload); }
      catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI(responses) fetch failed: ${e.message}`); }
      if (!upstream.ok) {
        const errTxt = await upstream.text();
        log(`OpenAI(responses) ${upstream.status}: ${errTxt.slice(0, 300)}`);
        return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
      }
      if (payload.stream) {
        const mayContinue = !isClassifierRequest(body) && !!payload.tools?.length;
        try { await streamResponses(res, upstream, reqModel, nameMap, payload, mayContinue, schemas); }
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
        const msg = fromResponses(rj, reqModel, nameMap, schemas);
        logTurnEnd("responses", rj, msg.content.filter((c) => c.type === "tool_use").length,
                   msg.content.filter((c) => c.type === "text").reduce((n, c) => n + c.text.length, 0));
        return sendJSON(res, 200, msg); }
    }

    const { payload, nameMap, schemas } = toOpenAI(body, model);
    log(`/v1/messages [chat] model=${reqModel}->${model} msgs=${payload.messages.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""}`);
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
    return sendJSON(res, 200, toAnthropic(oai, reqModel, nameMap, schemas));
  }

  anthropicError(res, 404, "not_found_error", `no route for ${req.method} ${url}`);
});

// Exported for the unit tests in proxy.test.mjs; set PROXY_NO_LISTEN=1 to import
// this module without binding the port.
export { makeMathFixer, fixMath, selectTools, isEssentialTool, withFormatHint, buildFormatHint,
         buildPersistenceHint, findWriteTool, findSendFileTool, findRenderTool, findBgTools, toolResultText,
         shouldAutoContinue, pruneToolArgs };

if (!process.env.PROXY_NO_LISTEN) server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}  ->  ${OPENAI_BASE} (model ${OPENAI_MODEL}, api ${OPENAI_API}${OPENAI_CLASSIFIER_MODEL ? `, classifier ${OPENAI_CLASSIFIER_MODEL}` : ""})`);
});
