// End-to-end: what the CLIENT receives when a request or a tool call cannot be trusted.
//   node --test openai-proxy/tool-safety.test.mjs
//
// The unit tests in strict-parsing.test.mjs prove the parsers throw. These prove the proxy acts on
// that — because the bug was never in a parser, it was that a failure had a fallback value and the
// fallback was runnable. `Bash({})` and `Write({})` are complete, executable calls whose arguments
// were lost, and the agent cannot tell them from calls the model meant to make.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";
// Pin compaction + classifier models so a dev config.jsonc that points them at "<provider>:<model>"
// chains/picks (compact -> groq/ollama, classifier -> local:qwen3) can't route a request to a real
// provider — which hangs this suite on retries. Plain names stay on the default provider whose base
// this test overrides to `upstream`.
process.env.OPENAI_COMPACT_MODELS = "gpt-4.1-mini";
process.env.OPENAI_COMPACT_MODEL = "gpt-4.1-mini";
process.env.OPENAI_CLASSIFIER_MODEL = "gpt-4.1-mini";
process.env.OPENAI_CLASSIFIER_SAFETY_MODEL = "";

let handler = () => {};
const upstream = http.createServer((req, res) => handler(req, res));
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

const { server } = await import("./proxy.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstream.close(); });

const post = async (path, body, raw = false) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an SSE stream is not JSON */ }
  return { status: r.status, text, json };
};

const BASH = {
  name: "Bash", description: "run a command",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};
const ask = (extra = {}) => ({
  model: "claude-opus-4-8", max_tokens: 64, stream: true,
  messages: [{ role: "user", content: "go" }], tools: [BASH], ...extra,
});

// An upstream that opens a function call, streams `bytes` of arguments, then ends the item and the
// response as instructed.
function toolStream({ args, finishItem = true, complete = true }) {
  return (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
    send("response.created", { type: "response.created", response: { id: "resp_1" } });
    send("response.output_item.added", { type: "response.output_item.added", output_index: 0,
      item: { id: "i1", type: "function_call", name: "Bash", call_id: "call_1" } });
    if (args !== undefined)
      send("response.function_call_arguments.delta",
        { type: "response.function_call_arguments.delta", item_id: "i1", delta: args });
    if (finishItem)
      send("response.output_item.done", { type: "response.output_item.done",
        item: { id: "i1", type: "function_call", name: "Bash", call_id: "call_1" } });
    if (complete)
      send("response.completed", { type: "response.completed",
        response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } });
    res.end();
  };
}

// ---------- the client's request ----------

test("a malformed request body is answered with a 400, not treated as empty", async () => {
  // It used to parse to `{}` and be answered as though the client had sent no messages — a 200 for
  // a request that could not be read.
  const r = await post("/v1/messages", '{"model":"claude-opus-4-8", "messages":', true);
  assert.equal(r.status, 400);
  assert.equal(r.json.type, "error");
  assert.equal(r.json.error.type, "invalid_request_error");
  assert.match(r.json.error.message, /not valid JSON/);
});

test("valid JSON of the wrong shape is also a 400", async () => {
  for (const [body, re] of [['["a"]', /must be a JSON object/], ["null", /must be a JSON object/],
                            ['{"messages":"hi"}', /messages must be an array/],
                            // a lone system message is hoisted to the system field, leaving an empty
                            // conversation — which is rejected, not forwarded upstream.
                            ['{"messages":[{"role":"system","content":"x"}]}', /messages must not be empty/]]) {
    const r = await post("/v1/messages", body, true);
    assert.equal(r.status, 400, `${body} must be rejected`);
    assert.match(r.json.error.message, re);
  }
});

test("count_tokens refuses a body it cannot read instead of counting it", async () => {
  // A malformed body used to yield a confident input_tokens for a request nobody could parse.
  const bad = await post("/v1/messages/count_tokens", "{ nope", true);
  assert.equal(bad.status, 400);
  const ok = await post("/v1/messages/count_tokens", { messages: [{ role: "user", content: "hello" }] });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.input_tokens > 0);
});

test("two tools that collide on the wire are refused, naming both", async () => {
  // `mcp__…__do.thing` and `mcp__…__do_thing` both become the same OpenAI tool name. The wire would
  // carry two tools with one name, the reverse map would keep whichever was declared last, and the
  // wrong schema would prune the arguments — a call to the wrong tool, blamed on the model.
  const r = await post("/v1/messages", {
    model: "claude-opus-4-8", max_tokens: 64, messages: [{ role: "user", content: "go" }],
    tools: [{ name: "mcp__srv__do.thing", input_schema: {} }, { name: "mcp__srv__do_thing", input_schema: {} }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, "invalid_request_error");
  assert.match(r.json.error.message, /mcp__srv__do\.thing/);
  assert.match(r.json.error.message, /mcp__srv__do_thing/);
  assert.match(r.json.error.message, /refused rather than guessing/);
});

// ---------- what the model sent back ----------

test("a truncated tool call reaches the client as an error, never as a runnable call", async () => {
  // THE CASE THAT MATTERED. `{"command":"rm -r` used to become `Bash({})`.
  handler = toolStream({ args: '{"command":"rm -r' });
  const r = await post("/v1/messages", ask());
  assert.equal(r.status, 200);                       // headers went out before the failure was known
  assert.doesNotMatch(r.text, /"type":"tool_use"/,
    "no tool_use block may be opened for a call whose arguments never parsed");
  assert.doesNotMatch(r.text, /input_json_delta/, "and no argument payload may be emitted");
  assert.doesNotMatch(r.text, /"stop_reason":"tool_use"/);
  assert.doesNotMatch(r.text, /"stop_reason":"end_turn"/);
  assert.match(r.text, /"stop_reason":"error"/);
  assert.match(r.text, /"type":"error"/);
  assert.match(r.text, /message_stop/, "the stream must still terminate properly");
  // The message has to say what happened, since this is all the user sees.
  assert.match(r.text, /Bash/);
  assert.match(r.text, /withheld/);
});

test("arguments cut off before any bytes arrive are withheld when the schema requires them", async () => {
  // No argument bytes at all, for a tool whose schema requires `command`. `{}` here is not "the
  // model passed nothing" — it is "the arguments never arrived".
  handler = toolStream({ args: undefined });
  const r = await post("/v1/messages", ask());
  assert.doesNotMatch(r.text, /"type":"tool_use"/);
  assert.match(r.text, /"stop_reason":"error"/);
  assert.match(r.text, /requires command/);
});

test("a tool taking no arguments still works", async () => {
  // The legitimate empty case must survive: plenty of tools declare no parameters, and `{}` is the
  // correct input for them.
  const NOARGS = { name: "ListAgents", description: "list", input_schema: { type: "object", properties: {} } };
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
    send("response.created", { type: "response.created", response: { id: "r" } });
    send("response.output_item.added", { type: "response.output_item.added", output_index: 0,
      item: { id: "i1", type: "function_call", name: "ListAgents", call_id: "c1" } });
    send("response.output_item.done", { type: "response.output_item.done",
      item: { id: "i1", type: "function_call", name: "ListAgents", call_id: "c1" } });
    send("response.completed", { type: "response.completed",
      response: { id: "r", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } });
    res.end();
  };
  const r = await post("/v1/messages", ask({ tools: [NOARGS] }));
  assert.match(r.text, /"type":"tool_use"/, "a no-argument call is a real call");
  assert.match(r.text, /"stop_reason":"tool_use"/);
  assert.doesNotMatch(r.text, /"stop_reason":"error"/);
});

test("a well-formed tool call is delivered intact, with its original name", async () => {
  const SANE = {
    name: "mcp__srv__do.thing", description: "d",
    input_schema: { type: "object", properties: { x: { type: "number" } } },
  };
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
    send("response.created", { type: "response.created", response: { id: "r" } });
    // The model answers with the SANITIZED name, which must map back to the original.
    send("response.output_item.added", { type: "response.output_item.added", output_index: 0,
      item: { id: "i1", type: "function_call", name: "mcp__srv__do_thing", call_id: "c1" } });
    send("response.function_call_arguments.delta",
      { type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"x":42}' });
    send("response.output_item.done", { type: "response.output_item.done",
      item: { id: "i1", type: "function_call", name: "mcp__srv__do_thing", call_id: "c1" } });
    send("response.completed", { type: "response.completed",
      response: { id: "r", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } });
    res.end();
  };
  const r = await post("/v1/messages", ask({ tools: [SANE] }));
  assert.match(r.text, /mcp__srv__do\.thing/, "the client must receive the name it declared");
  assert.match(r.text, /input_json_delta/);
  assert.match(r.text, /\\"x\\":42/, "and the arguments it sent");
  assert.match(r.text, /"stop_reason":"tool_use"/);
  assert.doesNotMatch(r.text, /"stop_reason":"error"/);
});

test("one bad call among several fails the turn rather than delivering the good ones", async () => {
  // A partial tool_use set is worse than none: the agent would run the calls it got, believe the
  // turn complete, and carry on with half the work silently missing.
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
    send("response.created", { type: "response.created", response: { id: "r" } });
    for (const [id, args] of [["i1", '{"command":"ls"}'], ["i2", '{"command":"rm -r']]) {
      send("response.output_item.added", { type: "response.output_item.added",
        item: { id, type: "function_call", name: "Bash", call_id: `c_${id}` } });
      send("response.function_call_arguments.delta",
        { type: "response.function_call_arguments.delta", item_id: id, delta: args });
      send("response.output_item.done", { type: "response.output_item.done",
        item: { id, type: "function_call", name: "Bash", call_id: `c_${id}` } });
    }
    send("response.completed", { type: "response.completed",
      response: { id: "r", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } });
    res.end();
  };
  const r = await post("/v1/messages", ask());
  assert.match(r.text, /"stop_reason":"error"/, "the turn must fail");
  assert.doesNotMatch(r.text, /"stop_reason":"tool_use"/);
  // The good call may have been emitted before the bad one was known to be bad — that is
  // unavoidable on a stream — but the turn must not be presented as complete.
  assert.match(r.text, /"type":"error"/);
});

test("a non-streaming turn with unparseable arguments is an error response", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_1", status: "completed",
      output: [{ type: "function_call", id: "i1", call_id: "c1", name: "Bash", arguments: '{"command":' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
  };
  const r = await post("/v1/messages", ask({ stream: false }));
  assert.ok(r.status >= 400, `expected an error status, got ${r.status}`);
  assert.equal(r.json.type, "error");
  assert.match(r.json.error.message, /Bash/);
  assert.match(JSON.stringify(r.json), /withheld/);
  assert.ok(!JSON.stringify(r.json).includes("tool_use"),
    "no tool_use block may reach the client");
});

test("a non-streaming turn with good arguments is unaffected", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_1", status: "completed",
      output: [{ type: "function_call", id: "i1", call_id: "c1", name: "Bash", arguments: '{"command":"ls"}' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
  };
  const r = await post("/v1/messages", ask({ stream: false }));
  assert.equal(r.status, 200);
  assert.equal(r.json.content[0].type, "tool_use");
  assert.deepEqual(r.json.content[0].input, { command: "ls" });
  assert.equal(r.json.stop_reason, "tool_use");
});
