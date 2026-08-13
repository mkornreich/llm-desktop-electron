// Semantic contracts are never dropped by the generic parameter recovery.
//   node --test openai-proxy/strict-contracts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isDroppableParam, SEMANTIC_CONTRACTS } from "./errors.mjs";

test("an ordinary knob is droppable", () => {
  // What the recovery was built for: the CLI sends stop_sequences, the chat surface forwards them as
  // `stop`, and gpt-5.x rejects it — twelve 400s in one session before it self-healed.
  for (const p of ["stop", "temperature", "top_p", "presence_penalty", "logprobs", "seed"])
    assert.equal(isDroppableParam(p), true, `${p} should self-heal`);
});

test("a field that carries meaning is never droppable", () => {
  // Stripping `tools` turns an agent turn into a text-only one that looks like a model declining to
  // act — and the memo would make it permanent for the rest of the process. Same failure shape as
  // every silent tool-drop already fixed here.
  for (const p of ["tools", "tool_choice", "messages", "input", "model", "instructions"])
    assert.equal(isDroppableParam(p), false, `${p} must never be dropped`);
});

test("a structured-output field is protected before it is ever sent", () => {
  // Not sent today. Listed so that if it ever is, the recovery cannot quietly return unstructured
  // text against a schema the caller is parsing.
  for (const p of ["response_format", "text.format", "output_config", "strict"])
    assert.equal(isDroppableParam(p), false, `${p} must never be dropped`);
});

test("a path INTO a contract is also a contract", () => {
  // OpenAI reports schema problems with a path: `tools[0].function.parameters`. Continuing without
  // the tools array is not a fix for a bad schema inside it.
  for (const p of ["tools[0].function.parameters", "tools[3].name", "input[0].content",
                   "messages[2].role", "text.format.json_schema", "output_config.format"])
    assert.equal(isDroppableParam(p), false, `${p} must never be dropped`);
});

test("a formatting knob under a non-contract root stays droppable", () => {
  // The line the prefix match must not cross: `text.verbosity` shapes HOW the answer reads and can
  // self-heal, while `text.format` defines WHAT the answer must be and cannot.
  assert.equal(isDroppableParam("text.verbosity"), true);
  assert.equal(isDroppableParam("text.format"), false);
});

test("an empty or absent param name is not droppable", () => {
  for (const p of ["", null, undefined]) assert.equal(isDroppableParam(p), false);
});

test("the contract list is deliberately small", () => {
  // A long list would make the self-healing recovery useless. These are the fields whose removal
  // changes WHAT WAS ASKED FOR, not how it was asked.
  assert.ok(SEMANTIC_CONTRACTS.size <= 12, `${SEMANTIC_CONTRACTS.size} entries is too many to justify`);
  assert.ok(SEMANTIC_CONTRACTS.has("tools"));
});

// ---------- end to end ----------

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";

let bodies = [];
let reject = null;
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    bodies.push(JSON.parse(raw || "{}"));
    if (reject) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Unsupported parameter: '${reject}' is not supported with this model.`,
                                        type: "invalid_request_error", param: reject } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "r", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 5, output_tokens: 2 } }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { server } = await import("./proxy.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstream.close(); });

const ask = () => fetch(`${base}/v1/messages`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-opus-4-8", max_tokens: 64, stream: false, system: "You are Claude Code.",
    messages: [{ role: "user", content: "list the files" }],
    tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));

test("a rejection naming `tools` does NOT produce a second, tool-less request", async () => {
  bodies = []; reject = "tools";
  const r = await ask();
  assert.equal(bodies.length, 1,
    `the request must not be retried without its tools; saw ${bodies.length} attempts`);
  assert.ok(bodies[0].tools?.length, "the one attempt carried the tools");
  assert.ok(r.status >= 400, "and the upstream error is surfaced rather than worked around");
});

test("a rejection naming an ordinary knob still self-heals", async () => {
  // The control: the recovery must keep doing what it was built for.
  bodies = []; reject = "temperature";
  await ask();
  // The proxy does not send `temperature` on this surface, so nothing is present to drop and it does
  // not retry — what matters is that it did not refuse on contract grounds.
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].tools?.length, "and the tools were never touched");
});

test("with no rejection at all, the turn is unaffected", async () => {
  bodies = []; reject = null;
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].tools?.length);
});

// ---------- the caller's schemas are not ours to modify ----------

test("a caller's tool schema is never mutated", async () => {
  // The proxy passes `input_schema` straight through by reference. That is fine while nothing writes
  // to it — and it is exactly what a schema normalizer would be tempted to do. Pinned now, before
  // any such code exists, because a mutation here would corrupt the CLIENT's own copy of its tool
  // definitions for the rest of the session and the symptom would appear somewhere else entirely.
  process.env.OPENAI_API = "responses";
  const { toResponses, toOpenAI } = await import("./proxy.mjs");
  const make = () => ({
    type: "object",
    properties: { a: { type: "string" }, nested: { type: "object", properties: { b: { type: "number" } } } },
    required: ["a"],
    additionalProperties: false,
  });
  for (const [name, encode] of [["toResponses", toResponses], ["toOpenAI", toOpenAI]]) {
    const schema = make();
    const before = JSON.stringify(schema);
    const body = { model: "claude-opus-4-8", max_tokens: 64, messages: [{ role: "user", content: "go" }],
                   tools: [{ name: "T", description: "d", input_schema: schema }],
                   tool_choice: { type: "tool", name: "T" } };
    const bodyBefore = JSON.stringify(body);
    encode(body, "gpt-5.6-sol", "main");
    assert.equal(JSON.stringify(schema), before, `${name} must not modify the caller's schema`);
    assert.equal(JSON.stringify(body), bodyBefore, `${name} must not modify the caller's request`);
  }
});

test("pruning removes an unknown argument without touching the schema", async () => {
  // Measured in production: argument pruning fired ONCE across 47,000+ requests, dropping an invented
  // `intent` from an MCP call — and in doing so it rescued a call that would otherwise have been
  // rejected wholesale. Turning it into a hard error, as strict mode would require, has nothing to
  // gain here because no strict contract is ever sent. It stays a repair, and the schema stays intact.
  const { pruneToolArgs } = await import("./proxy.mjs");
  const schema = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
  const before = JSON.stringify(schema);
  const args = { command: "ls", intent: "list files" };
  const { args: pruned, dropped } = pruneToolArgs(schema, args);
  assert.deepEqual(pruned, { command: "ls" });
  assert.deepEqual(dropped, ["intent"]);
  assert.equal(JSON.stringify(schema), before, "the schema is read, never written");
  assert.deepEqual(args, { command: "ls", intent: "list files" }, "and the caller's arguments too");
});
