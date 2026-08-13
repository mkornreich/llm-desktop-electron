// Run the corpus through the real proxy and write down what it did.
//
// NETWORK-FREE BY DEFAULT, and that is not a limitation — it is what makes this a baseline. What
// these cases measure is what the PROXY decides: which tools it exposes, which model it routes to,
// whether it injects hints, whether reasoning is requested, which pricing tier a request lands in,
// what compaction keeps. Every one of those is settled before a token is generated, so a real model
// would add cost and variance without adding information.
//
// The model's own quality is a different question, it needs paired live runs, and it belongs to the
// phase that changes defaults. `--live` exists as an explicit opt-in and refuses to run by accident.
//
// WHAT IS OBSERVED. A fake upstream records the exact payload the proxy sent and returns a fixed
// reply. The payload is the observation: it is the complete statement of what the proxy decided to
// do, and it is deterministic, so a later phase's change shows up as a diff rather than as an
// impression.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CASES } from "./corpus.mjs";
import { isLongContext, LONG_CONTEXT_THRESHOLD } from "../openai-proxy/model-registry.mjs";

// A reply that satisfies both surfaces, so one fake serves the whole corpus.
const REPLY_RESPONSES = {
  id: "resp_eval", status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
  usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 900 },
           output_tokens_details: { reasoning_tokens: 4 } },
};
const REPLY_CHAT = {
  id: "chat_eval", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } },
};

function sseFor(payload) {
  const send = (t, o) => `event: ${t}\ndata: ${JSON.stringify(o)}\n\n`;
  return send("response.created", { type: "response.created", response: { id: "resp_eval" } })
    + send("response.output_item.added", { type: "response.output_item.added", output_index: 0,
           item: { id: "i1", type: "message" } })
    + send("response.output_text.delta", { type: "response.output_text.delta", item_id: "i1", delta: "ok" })
    + send("response.output_item.done", { type: "response.output_item.done", item: { id: "i1", type: "message" } })
    + send("response.completed", { type: "response.completed", response: REPLY_RESPONSES });
}

// Normalise a payload into the handful of facts worth pinning. Deliberately NOT the whole payload:
// a baseline that records every byte fails on cosmetic edits and stops being read.
function observe(surface, payload) {
  const p = payload || {};
  const instructions = surface === "responses"
    ? String(p.instructions || "")
    : String((p.messages || []).find((m) => m.role === "system")?.content || "");
  const toolNames = (p.tools || []).map((t) => (surface === "responses" ? t.name : t.function?.name));
  const grossInput = REPLY_RESPONSES.usage.input_tokens;   // from the fake, so the tier check is exercised
  return {
    surface,
    model: p.model ?? null,
    stream: !!p.stream,
    // Tool exposure, which is the single most consequential thing a route decides.
    toolCount: toolNames.length,
    firstTools: toolNames.slice(0, 3),
    lastTools: toolNames.slice(-2),
    // Was a tool late in the catalogue kept? The historical failure is a silent drop.
    hasRendererTool: toolNames.includes("mcp__visualize__show_widget"),
    toolChoice: p.tool_choice === undefined ? null
      : typeof p.tool_choice === "string" ? p.tool_choice
      : (p.tool_choice.name || p.tool_choice.function?.name || p.tool_choice.type || "set"),
    // Prompt shaping. `hints` is what a classifier must never receive.
    hints: /render|widget|persistence|finish the request|\$\$/i.test(instructions),
    instructionsChars: instructions.length,
    reasoning: p.reasoning ? (p.reasoning.effort || true) : null,
    reasoningSummary: p.reasoning?.summary ?? null,
    verbosity: p.text?.verbosity ?? null,
    maxOutputTokens: p.max_output_tokens ?? p.max_tokens ?? null,
    promptCacheKeyPresent: !!p.prompt_cache_key,
    messageCount: (p.input || p.messages || []).length,
    // Pricing tier, so a change that grows requests past 272K shows up as a cost change rather than
    // as a surprise on the bill.
    longContextTier: isLongContext(grossInput, p.model),
  };
}

export async function run({ cases = CASES, live = false } = {}) {
  if (live) throw new Error("live runs are not implemented in this phase; see report.mjs --live");

  process.env.PROXY_NO_LISTEN = "1";
  process.env.OPENAI_API_KEY = "eval-not-a-real-key";
  process.env.OPENAI_API = process.env.OPENAI_API || "responses";
  // Isolated side-effect stores: an evaluation must not write into the real ledger, provenance or
  // ownership records, and must not read them either — a baseline that depends on local state is
  // not a baseline.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-"));
  process.env.PROXY_USAGE_FILE = `${scratch}/usage.json`;
  process.env.PROXY_PROVENANCE_DIR = `${scratch}/provenance`;
  process.env.PROXY_MANIFEST_FILE = `${scratch}/manifest.json`;

  let seen = null;
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      try { seen = JSON.parse(raw || "{}"); } catch { seen = { unparseable: true }; }
      const isResponses = req.url.includes("/responses");
      if (seen?.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sseFor(seen));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(isResponses ? REPLY_RESPONSES : REPLY_CHAT));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

  const { server } = await import("../openai-proxy/proxy.mjs");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const results = [];
  for (const c of cases) {
    seen = null;
    const body = c.body();
    let status = 0, err = null;
    const startedAt = Date.now();
    try {
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json",
                   "x-claude-code-session-id": "eeeeeeee-0000-0000-0000-000000000000" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      status = r.status;
      await r.text();
    } catch (e) { err = e.message; }
    const surface = seen?.input ? "responses" : "chat";
    results.push({
      id: c.id, slice: c.slice, status, error: err,
      // Latency is recorded but NOT compared: it is a property of the machine, not of the code, and
      // a baseline that fails on a busy laptop teaches people to ignore it.
      ms: Date.now() - startedAt,
      observed: seen ? observe(surface, seen) : null,
    });
  }

  server.close();
  upstream.close();
  return results;
}

// The comparison. A baseline is only useful if a difference is reported as a difference, with the
// field named — "something changed" is not actionable.
export function diff(baseline, current) {
  const byId = new Map(baseline.map((r) => [r.id, r]));
  const changes = [];
  for (const cur of current) {
    const base = byId.get(cur.id);
    if (!base) { changes.push({ id: cur.id, kind: "new case" }); continue; }
    byId.delete(cur.id);
    if (base.status !== cur.status)
      changes.push({ id: cur.id, field: "status", from: base.status, to: cur.status });
    const a = base.observed || {}, b = cur.observed || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = JSON.stringify(a[k]), bv = JSON.stringify(b[k]);
      if (av !== bv) changes.push({ id: cur.id, field: k, from: a[k], to: b[k] });
    }
  }
  for (const [id] of byId) changes.push({ id, kind: "case removed from the corpus" });
  return changes;
}
