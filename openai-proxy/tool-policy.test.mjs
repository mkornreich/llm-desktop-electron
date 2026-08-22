// Model-visible tool exposure, per route.
//   node --test openai-proxy/tool-policy.test.mjs
//
// The line these tests defend: exposure decides what the model is SHOWN. It never decides what may
// execute — that is Claude Code's `allowedTools`, and hiding or showing a tool cannot move it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  exposureFor, resolveToolChoice, exposureFingerprint, partition,
  VISIBILITY, ALWAYS_EAGER, sendsTools, allowsCalls, classifierSendsNoTools,
} from "./tool-policy.mjs";
import { ROUTE } from "./routes.mjs";

// ---------- per-route exposure ----------

test("an agent turn sees every tool and may call one", () => {
  const e = exposureFor(ROUTE.MAIN);
  assert.equal(e.visibility, VISIBILITY.ALL);
  assert.equal(sendsTools(ROUTE.MAIN), true);
  assert.equal(allowsCalls(ROUTE.MAIN), true);
});

test("a classifier is sent no tools at all", () => {
  for (const r of [ROUTE.PREFIX, ROUTE.SAFETY_SEVERITY, ROUTE.SAFETY_BLOCK]) {
    assert.equal(exposureFor(r).visibility, VISIBILITY.NONE, r);
    assert.equal(sendsTools(r), false, r);
    assert.equal(classifierSendsNoTools(r), true, r);
  }
});

test("a compaction request keeps its tools but cannot call one", () => {
  // The measurement that decided this. 224 of 318 real client compaction requests carried tools,
  // ~115k tokens of schemas each — and those requests run at a 95.7% cache hit rate (39.3M of 41.1M
  // input tokens served from cache, 299 of 300 requests above 50%).
  //
  // Removing the tool block would change the prompt prefix and turn ~39M cached tokens into fresh
  // ones: roughly $177 of extra spend to avoid ~$13 of cached schema tokens. So the tools stay and
  // the calls are disabled instead — the same guarantee, without the bill.
  const e = exposureFor(ROUTE.COMPACTION);
  assert.equal(e.visibility, VISIBILITY.NO_CALLS);
  assert.equal(sendsTools(ROUTE.COMPACTION), true, "the prefix must be preserved for the cache");
  assert.equal(allowsCalls(ROUTE.COMPACTION), false, "but a summary request must not call a tool");
  assert.match(e.reason, /caching/);
});

test("an unknown route gets agent exposure, not classifier exposure", () => {
  // Failing the other way would silently strip tools from a new route, and a tool-less agent turn
  // looks exactly like a model that declined to act.
  assert.equal(exposureFor("some-future-route").visibility, VISIBILITY.ALL);
});

// ---------- tool_choice ----------

test("a tool_choice naming a tool that was not sent is cleared, not forwarded", () => {
  // VERIFIED AGAINST THE LIVE ENCODER before this existed: 200 tools in, the Chat cap kept 128, and
  // the payload went out with `tool_choice: {name: "zz_dropped_199"}` — a tool that was not in it.
  // The API rejects that, and the error names the parameter rather than the cap that caused it.
  const exposed = ["Read", "Write", "Bash"];
  const r = resolveToolChoice({ type: "tool", name: "DroppedByTheCap" }, exposed,
                              { visibility: VISIBILITY.ALL });
  assert.equal(r.choice, null, "nothing is sent rather than something invalid");
  assert.equal(r.cleared, true);
  assert.match(r.reason, /DroppedByTheCap/);
  assert.match(r.reason, /not among the 3 tools/);
  assert.match(r.reason, /so the turn can proceed/, "clearing lets the turn work; forwarding fails it");
});

test("a tool_choice naming a tool that WAS sent survives untouched", () => {
  const r = resolveToolChoice({ type: "tool", name: "Bash" }, ["Read", "Bash"],
                              { visibility: VISIBILITY.ALL });
  assert.deepEqual(r.choice, { type: "tool", name: "Bash" });
  assert.equal(r.cleared, false);
});

test("auto, any and none translate and are never invented", () => {
  const V = { visibility: VISIBILITY.ALL };
  assert.equal(resolveToolChoice({ type: "auto" }, ["A"], V).choice, "auto");
  assert.equal(resolveToolChoice({ type: "any" }, ["A"], V).choice, "required");
  assert.equal(resolveToolChoice({ type: "none" }, ["A"], V).choice, "none");
  // No tool_choice in means none out. Inventing "auto" would change the model's behaviour on every
  // request that did not ask for one.
  assert.equal(resolveToolChoice(undefined, ["A"], V).choice, null);
  assert.equal(resolveToolChoice(null, ["A"], V).choice, null);
});

test("a route that sends no tools sends no tool_choice either", () => {
  // `required` with an empty tools array demands a call the model has no way to make.
  const r = resolveToolChoice({ type: "any" }, [], { visibility: VISIBILITY.NONE });
  assert.equal(r.choice, null);
  assert.equal(r.cleared, true);
  assert.match(r.reason, /no tools are sent/);
});

test("a no-calls route forces none, whatever the client asked for", () => {
  for (const req of [undefined, { type: "auto" }, { type: "any" }, { type: "tool", name: "Bash" }]) {
    const r = resolveToolChoice(req, ["Bash"], { visibility: VISIBILITY.NO_CALLS });
    assert.equal(r.choice, "none", `${JSON.stringify(req)} must still resolve to none`);
  }
  // Asking for none when none is already forced is not a "clearing" worth logging.
  assert.equal(resolveToolChoice({ type: "none" }, ["Bash"], { visibility: VISIBILITY.NO_CALLS }).cleared, false);
});

test("an unrecognised tool_choice type is cleared rather than passed through", () => {
  const r = resolveToolChoice({ type: "telepathy" }, ["A"], { visibility: VISIBILITY.ALL });
  assert.equal(r.choice, null);
  assert.match(r.reason, /unrecognised/);
});

// ---------- deferral, defined and off ----------

test("deferral is off by default: every tool is eager", () => {
  // It stays off until the real ToolSearch -> load -> call loop is proven in the app. A deferral that
  // loses a tool presents as a model that "chose" not to use it, which is the worst failure to debug.
  const names = ["Read", "Write", "ToolSearch", "mcp__srv__thing"];
  const p = partition(names);
  assert.deepEqual(p.eager, names);
  assert.deepEqual(p.deferred, []);
  assert.deepEqual(p.allowed, names);
});

test("when deferral is enabled, the search tool itself is never deferred", () => {
  // It is the entry point to every deferred tool. Deferring it makes the rest unreachable.
  const p = partition(["Read", "ToolSearch", "Skill", "mcp__srv__thing"], { deferral: true });
  assert.ok(p.eager.includes("ToolSearch"), "ToolSearch must stay visible");
  assert.ok(p.eager.includes("Skill"));
  assert.ok(p.deferred.includes("Read"));
  assert.ok(p.deferred.includes("mcp__srv__thing"));
  assert.ok(ALWAYS_EAGER.test("ToolSearch"));
});

test("deferral changes visibility, never what may be called", () => {
  const names = ["Read", "Write", "ToolSearch"];
  const off = partition(names);
  const on = partition(names, { deferral: true });
  assert.deepEqual(on.allowed, off.allowed,
    "the allowed set is identical either way — deferral is not a permission mechanism");
});

// ---------- fingerprint ----------

test("the exposure fingerprint is stable, order-sensitive and visibility-sensitive", () => {
  const a = exposureFingerprint({ visibility: "all", names: ["A", "B"] });
  assert.equal(a, exposureFingerprint({ visibility: "all", names: ["A", "B"] }), "stable");
  assert.notEqual(a, exposureFingerprint({ visibility: "all", names: ["B", "A"] }),
    "order matters: a reordered catalogue is a different thing to show a model");
  assert.notEqual(a, exposureFingerprint({ visibility: "no-calls", names: ["A", "B"] }),
    "same tools, different callability, different exposure");
  assert.notEqual(a, exposureFingerprint({ visibility: "all", names: ["A"] }));
  assert.match(a, /^[0-9a-f]{12}$/);
});

// ---------- end to end ----------

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";
// Pin the compaction + classifier models. A dev config.jsonc points these at cross-provider
// "<provider>:<model>" chains/picks (compact -> groq/ollama, classifier -> local:qwen3), which resolve
// to THOSE providers' own bases and route the request away from this test's mock upstream. A plain,
// un-prefixed name stays on the default provider whose base this test overrides to `upstream` (empty
// does not override these — the resolver treats it as unset and the config chain wins).
process.env.OPENAI_COMPACT_MODELS = "gpt-4.1-mini";
process.env.OPENAI_COMPACT_MODEL = "gpt-4.1-mini";
process.env.OPENAI_CLASSIFIER_MODEL = "gpt-4.1-mini";
process.env.OPENAI_CLASSIFIER_SAFETY_MODEL = "";

let seen = null;
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    try { seen = JSON.parse(raw || "{}"); } catch { seen = null; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "r", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 2 } }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { server } = await import("./proxy.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstream.close(); });

const ask = (body) => fetch(`${base}/v1/messages`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 64, stream: false, ...body }),
}).then((r) => r.text());

const TOOLS = [
  { name: "Read", input_schema: { type: "object", properties: {} } },
  { name: "Bash", input_schema: { type: "object", properties: {} } },
];
const COMPACT_INSTRUCTION =
  "Your task is to create a detailed summary of the conversation so far, paying close attention " +
  "to the user's explicit requests and your previous actions.";

test("a real compaction request keeps its tools and is sent tool_choice none", async () => {
  seen = null;
  await ask({ system: "You are Claude Code.", tools: TOOLS,
              messages: [{ role: "user", content: COMPACT_INSTRUCTION }] });
  assert.ok(seen, "the upstream must have been called");
  assert.equal(seen.tools?.length, 2, "the tools stay in the prefix, for the cache");
  assert.equal(seen.tool_choice, "none", "and no call is possible");
});

test("a real agent turn keeps both its tools and its ability to call them", async () => {
  seen = null;
  await ask({ system: "You are Claude Code.", tools: TOOLS,
              messages: [{ role: "user", content: "read the file" }] });
  assert.equal(seen.tools?.length, 2);
  assert.notEqual(seen.tool_choice, "none", "an agent turn must still be able to act");
});

test("a real request naming an absent tool is sent without a tool_choice", async () => {
  seen = null;
  const out = await ask({ system: "You are Claude Code.", tools: TOOLS,
                          messages: [{ role: "user", content: "go" }],
                          tool_choice: { type: "tool", name: "NotDeclaredAnywhere" } });
  assert.equal(seen.tool_choice, undefined,
    "an unavailable tool_choice must be cleared, not forwarded into a 400");
  assert.equal(seen.tools?.length, 2, "and the tools themselves are unaffected");
  assert.ok(!/error/i.test(out.slice(0, 200)), "the turn still succeeds");
});

test("hints never name a tool the model was not shown", async () => {
  // Built from the CLIENT's list before this change, which is fine until a policy hides something —
  // and this phase introduces exactly that. A compaction request is sent tool_choice none, so an
  // instruction telling it to call a renderer would be an instruction it cannot follow.
  seen = null;
  await ask({ system: "You are Claude Code.", tools: [],
              messages: [{ role: "user", content: COMPACT_INSTRUCTION }] });
  const instructions = String(seen.instructions || "");
  assert.ok(!/show_widget|senduserfile/i.test(instructions),
    "with no tools exposed, no hint may name one");
});
