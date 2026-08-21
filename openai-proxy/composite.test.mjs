// End-to-end tests for the composite (fallback) model.
//   node --test openai-proxy/composite.test.mjs
//
// The fallthrough loop lives in obtainUpstream inside the request handler, so it can't be reached by a
// pure function. This boots the real proxy against a fake OpenAI whose response is chosen per requested
// model, and drives it with a real request whose model is the reserved "composite" id. The composite
// members are BARE ids, so they resolve to the default provider (this fake upstream) — which lets the
// test decide each member's fate (429 / 5xx / socket death / 200) by the model field it receives.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";
process.env.OPENAI_MODEL = "solo-default";             // deterministic single default (independent of .openai-model)
process.env.OPENAI_COMPOSITE_MODELS = "m-a,m-b,m-c";   // bare -> default provider (the fake upstream below)
process.env.OPENAI_COMPACT_MODELS = "m-a,m-b,m-c";     // same members: client-side COMPACTION routes through this chain

let handler = () => {};
const calls = [];                                       // models the upstream was asked for, in order
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { let m = ""; try { m = JSON.parse(raw).model; } catch {} calls.push(m); handler(m, req, res); });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

const { server } = await import("./proxy.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); upstream.close(); });

function sseOk(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
  send("response.created", { type: "response.created", response: { id: "resp_1" } });
  send("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "i1", type: "message" } });
  send("response.output_text.delta", { type: "response.output_text.delta", item_id: "i1", delta: text });
  send("response.output_item.done", { type: "response.output_item.done", item: { id: "i1", type: "message" } });
  send("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 11, output_tokens: 7 } } });
  res.end();
}
const err = (res, code, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify({ error: { message: `synthetic ${code}` } })); };

async function askComposite(model = "composite") {
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
  return { status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.text() };
}

test("falls through 429 and 5xx to the first member that answers, in order", async () => {
  calls.length = 0;
  handler = (m, req, res) => {
    if (m === "m-a") return err(res, 429, { "retry-after": "1" });
    if (m === "m-b") return err(res, 503);
    return sseOk(res, "answered by m-c");
  };
  const { status, body } = await askComposite();
  assert.equal(status, 200);
  assert.deepEqual(calls, ["m-a", "m-b", "m-c"], "each member tried once, strictly in order, until one answered");
  assert.match(body, /answered by m-c/, "the surviving member's text reaches the client");
  assert.match(body, /"stop_reason":"end_turn"/);
});

test("falls through a dead socket (transport error) to the next member", async () => {
  calls.length = 0;
  handler = (m, req, res) => {
    if (m === "m-a") { res.socket.destroy(); return; }     // transport failure before any response
    return sseOk(res, "answered by m-b after a dropped socket");
  };
  const { status, body } = await askComposite();
  assert.equal(status, 200);
  assert.deepEqual(calls.slice(0, 2), ["m-a", "m-b"]);
  assert.match(body, /answered by m-b/);
});

test("when every member is rate-limited beyond the cap, surfaces 429 with Retry-After", async () => {
  calls.length = 0;
  handler = (m, req, res) => err(res, 429, { "retry-after": "120" });   // 120s > default 30s cap
  const { status, retryAfter, body } = await askComposite();
  assert.equal(status, 429);
  assert.equal(retryAfter, "120", "the final 429 echoes the upstream Retry-After so the agent backs off");
  assert.deepEqual(calls, ["m-a", "m-b", "m-c"], "no bounded wait when the wait exceeds the cap");
  assert.match(body, /all members failed/);
});

test("waits a within-cap Retry-After then retries the recovered member", async () => {
  calls.length = 0;
  let aSeen = 0;
  handler = (m, req, res) => {
    if (m === "m-a") return (++aSeen === 1) ? err(res, 429, { "retry-after": "1" }) : sseOk(res, "m-a recovered after waiting");
    return err(res, 503);                                 // m-b, m-c never a 429, so only m-a is held
  };
  const { status, body } = await askComposite();
  assert.equal(status, 200);
  assert.equal(aSeen, 2, "m-a is retried once after its Retry-After elapses");
  assert.match(body, /m-a recovered after waiting/);
});

test("a non-composite model keeps single-shot behaviour (429 surfaced verbatim, no fallthrough)", async () => {
  calls.length = 0;
  handler = (m, req, res) => err(res, 429, { "retry-after": "1" });
  const { status, body } = await askComposite("claude-opus-4-8");   // not the composite id
  assert.equal(status, 429);
  assert.deepEqual(calls, ["solo-default"], "one call to the single default model — no chain, no member ids");
  assert.match(body, /OpenAI 429/, "today's verbatim OpenAI-status error string");
});

test("a client-side COMPACTION turn routes through the compaction chain with fallover", async () => {
  // The "full" compaction phrase makes routeForRequest classify this as COMPACTION; with OPENAI_COMPACT_MODELS
  // set it runs the chain (not the default upstream), falling over m-a -> m-b.
  calls.length = 0;
  handler = (m, req, res) => (m === "m-a" ? err(res, 500) : sseOk(res, "compacted by " + m));
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "composite", max_tokens: 200, stream: true,
      messages: [{ role: "user", content: "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests." }] }),
  });
  const body = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(calls.slice(0, 2), ["m-a", "m-b"], "compaction tried the chain in order, falling over m-a -> m-b");
  assert.match(body, /compacted by m-b/);
});

test("a composite member that streams NO answer falls over mid-stream to the next same-surface member", async () => {
  // m-a streams reasoning then drops with no terminal event (no response.completed) — the exact failure the
  // user hit on ollama:gpt-oss:120b. With no tools the empty-retry is skipped, so it goes straight to the
  // mid-stream fallover, which switches to m-b (same responses surface) and appends its answer.
  calls.length = 0;
  handler = (m, req, res) => {
    if (m === "m-a") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}\n\n`);
      res.write(`event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "thinking hard…" })}\n\n`);
      res.end();   // dropped: NO response.completed terminal event
      return;
    }
    return sseOk(res, "answered by m-b after fallover");
  };
  const { status, body } = await askComposite("composite");   // stream:true, no tools -> straight to fallover
  assert.equal(status, 200);
  assert.deepEqual(calls.slice(0, 2), ["m-a", "m-b"], "m-a streamed no answer -> fell over to m-b");
  assert.match(body, /answered by m-b after fallover/, "the fallover member's answer reaches the client");
});
