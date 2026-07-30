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
// Output shaping. The app's chat surface is the REMOTE claude.ai web app — there is no
// math or markdown renderer in the local bundle to patch — so the only lever is what
// the model emits. GPT models default to \( \) / \[ \] for math, which that renderer
// shows literally; it wants $ / $$. And .svg FILES render as images (the bundle maps
// IMAGE_EXT_TO_MIME ".svg" -> "image/svg+xml"), while inline <svg> markup in chat text
// does not. Set OPENAI_OUTPUT_FIXUPS=0 to disable both.
const OUTPUT_FIXUPS = (process.env.OPENAI_OUTPUT_FIXUPS || PROJECT.OPENAI_OUTPUT_FIXUPS || "1") !== "0";
const DEFAULT_TEMP = FILE.temperature != null ? parseFloat(FILE.temperature) : undefined;
const PORT = parseInt(process.env.PORT || "8123", 10);

if (!OPENAI_API_KEY) {
  console.error("[proxy] FATAL: no OpenAI API key (set apiKey in ~/.dbeaver-ai-complete or OPENAI_API_KEY)");
  process.exit(1);
}

// ---------- helpers ----------
const rid = (p) => p + crypto.randomBytes(16).toString("hex");
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const log = (...a) => console.log("[proxy]", ...a);
const sanitizeToolName = (n) => String(n || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";

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
// Tell the model the two things it cannot infer about this client's renderer.
const FORMAT_HINT = [
  "",
  "## Output formatting for this client",
  "- Math: use $...$ for inline math and $$...$$ for display math. Do NOT use \\( \\) or \\[ \\] — this client renders those literally.",
  "- SVG and diagrams: write the SVG to a file with a .svg extension and reference that path. This client renders .svg files as images; raw <svg> markup pasted into a reply does not render.",
  "- Prefer calling the tools available to you over describing what you would do.",
].join("\n");

// enable=false for the safety-classifier call: it is a separate LLM with its own
// expected output shape, and appending presentation rules to its prompt is off-task.
const withFormatHint = (sys, enable = true) => (OUTPUT_FIXUPS && enable ? `${sys || ""}\n${FORMAT_HINT}` : sys);

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
    if (sys) messages.push({ role: "system", content: withFormatHint(sys, !isClassifierRequest(body)) });
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
        toolResults.push({ tool_call_id: blk.tool_use_id, content: typeof blk.content === "string" ? blk.content : Array.isArray(blk.content) ? blk.content.map((c) => c.text || "").join("\n") : JSON.stringify(blk.content) });
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
  if (body.tools?.length) {
    const { tools, dropped } = selectTools(body.tools, MAX_TOOLS_CHAT);
    if (dropped.length) log(`chat cap ${body.tools.length}->${tools.length}; dropped ${dropped.length}: ${dropped.slice(0, 12).join(", ")}${dropped.length > 12 ? ", …" : ""}`);
    out.tools = tools.map((t) => {
      const name = sanitizeToolName(t.name);
      if (name !== t.name) nameMap.set(name, t.name);
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
  return { payload: out, nameMap };
}

// ---------- response translation: OpenAI -> Anthropic (non-streaming) ----------
function toAnthropic(oai, reqModel, nameMap) {
  const choice = oai.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: fixMath(msg.content) });
  for (const tc of msg.tool_calls || [])
    content.push({ type: "tool_use", id: tc.id || rid("toolu_"), name: (nameMap && nameMap.get(tc.function?.name)) || tc.function?.name, input: safeParse(tc.function?.arguments || "{}") });
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

async function streamAnthropic(res, upstream, reqModel, nameMap) {
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });

  const mathFix = makeMathFixer(); // rewrites TeX delimiters across chunk boundaries
  let textOpen = false;          // is the text content block (index 0) open?
  const toolBlocks = new Map();  // openai tool index -> {aIndex, started}
  let nextIndex = 1;             // anthropic content-block index counter (0 reserved for text)
  let finish = null, usage = null;

  const ensureText = () => { if (!textOpen) { sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); textOpen = true; } };

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
        if (fixed) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fixed } });
      }
      for (const tc of d.tool_calls || []) {
        let tb = toolBlocks.get(tc.index);
        if (!tb) {
          tb = { aIndex: nextIndex++, started: false };
          toolBlocks.set(tc.index, tb);
        }
        if (!tb.started && (tc.id || tc.function?.name)) {
          sse(res, "content_block_start", { type: "content_block_start", index: tb.aIndex, content_block: { type: "tool_use", id: tc.id || rid("toolu_"), name: (nameMap && nameMap.get(tc.function?.name)) || tc.function?.name || "", input: {} } });
          tb.started = true;
        }
        if (tc.function?.arguments) sse(res, "content_block_delta", { type: "content_block_delta", index: tb.aIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
      }
    }
  }
  if (textOpen) {
    const tail = mathFix.flush(); // emit any held-back partial delimiter
    if (tail) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tail } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  }
  for (const tb of toolBlocks.values()) if (tb.started) sse(res, "content_block_stop", { type: "content_block_stop", index: tb.aIndex });
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
      else if (blk.type === "tool_result") toolResults.push({ type: "function_call_output", call_id: blk.tool_use_id, output: typeof blk.content === "string" ? blk.content : Array.isArray(blk.content) ? blk.content.map((c) => c.text || "").join("\n") : JSON.stringify(blk.content) });
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
  if (body.system) out.instructions = withFormatHint(Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : body.system, !isClassifierRequest(body));
  const nameMap = new Map();
  if (body.tools?.length) {
    // No cap on this surface (verified up to 512), so the agent keeps every tool.
    const { tools, dropped } = selectTools(body.tools, MAX_TOOLS_RESPONSES);
    if (dropped.length) log(`responses cap ${body.tools.length}->${tools.length}; dropped ${dropped.length}`);
    out.tools = tools.map((t) => { // Responses tools are flat: {type,name,description,parameters}
      const name = sanitizeToolName(t.name);
      if (name !== t.name) nameMap.set(name, t.name);
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
  return { payload: out, nameMap };
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

function respStopReason(resp, hasTool) {
  if (hasTool) return "tool_use";
  if (resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
  return "end_turn";
}

// Responses (non-streaming) -> Anthropic message
function fromResponses(resp, reqModel, nameMap) {
  const content = [];
  let hasTool = false;
  for (const item of resp.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) if (c.type === "output_text" && c.text) content.push({ type: "text", text: fixMath(c.text) });
    } else if (item.type === "function_call") {
      hasTool = true;
      content.push({ type: "tool_use", id: item.call_id || item.id, name: (nameMap && nameMap.get(item.name)) || item.name, input: safeParse(item.arguments || "{}") });
    } // reasoning items are dropped
  }
  return {
    id: rid("msg_"), type: "message", role: "assistant", model: reqModel, content,
    stop_reason: respStopReason(resp, hasTool), stop_sequence: null,
    usage: { input_tokens: resp.usage?.input_tokens || 0, output_tokens: resp.usage?.output_tokens || 0 },
  };
}

// Responses SSE -> Anthropic SSE
async function streamResponses(res, upstream, reqModel, nameMap) {
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });
  const items = new Map(); // Responses item_id -> {aIndex, opened, closed}
  let nextIndex = 0, hasTool = false, usage = null, incomplete = false;
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
      let j; try { j = JSON.parse(t.slice(5).trim()); } catch { continue; }
      switch (j.type) {
        case "response.output_item.added":
          if (j.item?.type === "function_call") { hasTool = true; open(j.item.id, { type: "tool_use", id: j.item.call_id || j.item.id, name: (nameMap && nameMap.get(j.item.name)) || j.item.name || "", input: {} }); }
          break;
        case "response.output_text.delta":
          {
            const it = open(j.item_id, { type: "text", text: "" });
            if (!it.mathFix) it.mathFix = makeMathFixer();
            const fixed = it.mathFix.push(j.delta);
            if (fixed) sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: fixed } });
          }
          break;
        case "response.function_call_arguments.delta":
          { const it = items.get(j.item_id); if (it) sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "input_json_delta", partial_json: j.delta } }); }
          break;
        case "response.output_item.done":
          if (j.item?.id) close(j.item.id);
          break;
        case "response.completed": usage = j.response?.usage; break;
        case "response.incomplete": usage = j.response?.usage; incomplete = true; break;
      }
    }
  }
  for (const id of items.keys()) close(id);
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: hasTool ? "tool_use" : (incomplete ? "max_tokens" : "end_turn"), stop_sequence: null }, usage: { output_tokens: usage?.output_tokens || 0 } });
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

    if (useResp) {
      const { payload, nameMap } = toResponses(body, model);
      log(`/v1/messages [responses] model=${reqModel}->${model} input=${payload.input.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""}`);
      let upstream;
      try { upstream = await callResponses(payload); }
      catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI(responses) fetch failed: ${e.message}`); }
      if (!upstream.ok) {
        const errTxt = await upstream.text();
        log(`OpenAI(responses) ${upstream.status}: ${errTxt.slice(0, 300)}`);
        return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
      }
      if (payload.stream) { try { await streamResponses(res, upstream, reqModel, nameMap); } catch (e) { log("stream error:", e.message); try { res.end(); } catch {} } return; }
      return sendJSON(res, 200, fromResponses(await upstream.json(), reqModel, nameMap));
    }

    const { payload, nameMap } = toOpenAI(body, model);
    log(`/v1/messages [chat] model=${reqModel}->${model} msgs=${payload.messages.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""}`);
    let upstream;
    try { upstream = await callOpenAI(payload); }
    catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI fetch failed: ${e.message}`); }
    if (!upstream.ok) {
      const errTxt = await upstream.text();
      log(`OpenAI ${upstream.status}: ${errTxt.slice(0, 300)}`);
      return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
    }
    if (payload.stream) { try { await streamAnthropic(res, upstream, reqModel, nameMap); } catch (e) { log("stream error:", e.message); try { res.end(); } catch {} } return; }
    const oai = await upstream.json();
    return sendJSON(res, 200, toAnthropic(oai, reqModel, nameMap));
  }

  anthropicError(res, 404, "not_found_error", `no route for ${req.method} ${url}`);
});

// Exported for the unit tests in proxy.test.mjs; set PROXY_NO_LISTEN=1 to import
// this module without binding the port.
export { makeMathFixer, fixMath, selectTools, isEssentialTool, withFormatHint, FORMAT_HINT };

if (!process.env.PROXY_NO_LISTEN) server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}  ->  ${OPENAI_BASE} (model ${OPENAI_MODEL}, api ${OPENAI_API}${OPENAI_CLASSIFIER_MODEL ? `, classifier ${OPENAI_CLASSIFIER_MODEL}` : ""})`);
});
