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
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DEFAULT_MAX_TOKENS = parseInt(FILE.maxTokens || "1024", 10) || 1024;
// OpenAI models cap completion tokens (e.g. gpt-4.1 = 32768) far below Claude's
// 64k; clamp so agents that request Claude-sized budgets don't 400.
const MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "32768", 10) || 32768;
// OpenAI chat/completions caps the tools array at 128 (all models) and requires
// function names to match ^[a-zA-Z0-9_-]{1,64}$. Claude Code + desktop MCP can
// send 200+ tools with names the API rejects, so we cap and sanitize.
const MAX_TOOLS = parseInt(process.env.OPENAI_MAX_TOOLS || "128", 10) || 128;
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
function toOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((b) => b.text || "").join("\n")
      : body.system;
    if (sys) messages.push({ role: "system", content: sys });
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
  const usesCompletionTokens = /^(gpt-5|o[1-9])/.test(OPENAI_MODEL);
  const out = {
    model: OPENAI_MODEL, messages, stream: !!body.stream,
    ...(usesCompletionTokens ? { max_completion_tokens: outTokens } : { max_tokens: outTokens }),
  };
  const temp = body.temperature ?? DEFAULT_TEMP;
  if (temp != null) out.temperature = temp;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  const nameMap = new Map(); // sanitized -> original, to translate tool_calls back
  if (body.tools?.length) {
    let tools = body.tools;
    if (tools.length > MAX_TOOLS) { log(`clamping tools ${tools.length}->${MAX_TOOLS} (OpenAI cap)`); tools = tools.slice(0, MAX_TOOLS); }
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
  if (msg.content) content.push({ type: "text", text: msg.content });
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
      if (d.content) { ensureText(); sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d.content } }); }
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
  if (textOpen) sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  for (const tb of toolBlocks.values()) if (tb.started) sse(res, "content_block_stop", { type: "content_block_stop", index: tb.aIndex });
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: mapFinish(finish, toolBlocks.size > 0), stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens || 0 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ================= OpenAI Responses API path (for codex / responses-only models) =================
// Anthropic Messages -> Responses request
function toResponses(body) {
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
  const out = { model: OPENAI_MODEL, input, stream: !!body.stream, max_output_tokens: Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS) };
  if (body.system) out.instructions = Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : body.system;
  const nameMap = new Map();
  if (body.tools?.length) {
    let tools = body.tools;
    if (tools.length > MAX_TOOLS) { log(`clamping tools ${tools.length}->${MAX_TOOLS} (OpenAI cap)`); tools = tools.slice(0, MAX_TOOLS); }
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
      for (const c of item.content || []) if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
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
  const close = (itemId) => { const it = items.get(itemId); if (it && it.opened && !it.closed) { sse(res, "content_block_stop", { type: "content_block_stop", index: it.aIndex }); it.closed = true; } };

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
          { const it = open(j.item_id, { type: "text", text: "" }); sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: j.delta } }); }
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
    return sendJSON(res, 200, { ok: true, proxy: "anthropic->openai", model: OPENAI_MODEL, api: OPENAI_API });

  if (req.method === "POST" && url === "/v1/messages/count_tokens") {
    const body = safeParse(await readBody(req));
    const txt = JSON.stringify(body.messages || "") + (body.system ? JSON.stringify(body.system) : "");
    return sendJSON(res, 200, { input_tokens: Math.ceil(txt.length / 4) }); // rough estimate
  }

  if (req.method === "GET" && url === "/v1/models")
    return sendJSON(res, 200, { data: [{ type: "model", id: OPENAI_MODEL, display_name: OPENAI_MODEL }] });

  if (req.method === "POST" && url === "/v1/messages") {
    const raw = await readBody(req);
    const body = safeParse(raw);
    const reqModel = body.model || OPENAI_MODEL;

    if (USE_RESPONSES) {
      const { payload, nameMap } = toResponses(body);
      log(`/v1/messages [responses] model=${reqModel}->${OPENAI_MODEL} input=${payload.input.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""}`);
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

    const { payload, nameMap } = toOpenAI(body);
    log(`/v1/messages model=${reqModel}->${OPENAI_MODEL} msgs=${payload.messages.length} stream=${!!payload.stream}${payload.tools ? " tools=" + payload.tools.length : ""}`);
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

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}  ->  ${OPENAI_BASE} (model ${OPENAI_MODEL}, api ${OPENAI_API})`);
});
