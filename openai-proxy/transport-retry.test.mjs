// End-to-end test for the dropped-socket retry.
//   node --test openai-proxy/transport-retry.test.mjs
//
// The retry lives inside streamResponses' consume loop, so it cannot be reached by calling a
// pure function. This boots the real proxy against a fake OpenAI that destroys the socket, and
// asserts on what the CLIENT receives — which is the thing that actually broke: 97 turns in the
// log ended mid-stream and none was retried.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";

// Each test installs its own upstream behaviour; the port is fixed before the proxy imports.
let handler = () => {};
const upstream = http.createServer((req, res) => handler(req, res));
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
  send("response.output_item.added",
       { type: "response.output_item.added", output_index: 0, item: { id: "i1", type: "message" } });
  send("response.output_text.delta",
       { type: "response.output_text.delta", item_id: "i1", delta: text });
  send("response.output_item.done",
       { type: "response.output_item.done", item: { id: "i1", type: "message" } });
  send("response.completed", { type: "response.completed",
       response: { id: "resp_1", status: "completed",
                   usage: { input_tokens: 11, output_tokens: 7 } } });
  res.end();
}

async function ask() {
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8", max_tokens: 64, stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  return { status: r.status, body: await r.text() };
}

test("recovers a turn when the upstream socket dies before any output", async () => {
  let attempts = 0;
  handler = (req, res) => {
    if (++attempts === 1) {                    // drop it: headers sent, no content yet
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": warming up\n\n");
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    sseOk(res, "recovered after a dropped socket");
  };

  const { status, body } = await ask();
  assert.equal(status, 200);
  assert.ok(attempts >= 2, `upstream should have been called again, saw ${attempts}`);
  assert.match(body, /recovered after a dropped socket/,
    "the retried turn's text must reach the client");
  assert.match(body, /"stop_reason":"end_turn"/,
    "the turn must terminate properly rather than ending mid-stream");
});

test("gives up after the bound and tells the client, rather than ending silently", async () => {
  let attempts = 0;
  handler = (req, res) => {                    // always drop
    attempts++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": warming up\n\n");
    setTimeout(() => res.socket.destroy(), 10);
  };

  const { status, body } = await ask();
  assert.equal(status, 200);                   // headers were already sent; the stream just ends
  // 1 initial attempt + MAX_TRANSPORT_RETRIES. Bounded is the point: an unreachable upstream
  // must not spin.
  assert.ok(attempts <= 4, `expected a small bounded number of attempts, saw ${attempts}`);
  assert.ok(attempts >= 2, `expected at least one retry, saw ${attempts}`);
  // Exhaustion used to throw past message_start into a bare res.end() — a silent EOF the client
  // cannot distinguish from a successful empty turn.
  assert.match(body, /"type":"error"/, "the client must receive an in-band error event");
  assert.match(body, /"stop_reason":"error"/, "and an error stop reason");
  assert.doesNotMatch(body, /"stop_reason":"end_turn"/,
    "a turn that never connected must not claim end_turn");
  assert.match(body, /message_stop/, "the stream must still terminate properly");
});

test("a mid-turn drop surfaces the partial output as an error, not a completion", async () => {
  let attempts = 0;
  handler = (req, res) => {
    attempts++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
    send("response.created", { type: "response.created", response: { id: "resp_1" } });
    send("response.output_item.added",
         { type: "response.output_item.added", output_index: 0, item: { id: "i1", type: "message" } });
    send("response.output_text.delta",
         { type: "response.output_text.delta", item_id: "i1", delta: "partial answer" });
    setTimeout(() => res.socket.destroy(), 20);   // die AFTER content is on the wire
  };

  const { body } = await ask();
  assert.equal(attempts, 1,
    "a turn that already emitted content must not be restarted — that would renumber blocks");
  assert.match(body, /partial answer/, "the partial turn is still surfaced, not discarded");
  // The whole point of the change: keeping the partial text is right, calling it a finished
  // answer is not. This is what let 97 severed turns read as complete.
  assert.match(body, /"stop_reason":"error"/, "a severed turn must stop with an error");
  assert.doesNotMatch(body, /"stop_reason":"end_turn"/,
    "a severed turn must never be presented as a normal completion");
  assert.match(body, /"type":"error"/, "and must carry an explicit error event");
  assert.match(body, /content_block_stop/, "open blocks must still be closed");
});

test("a retry replays the payload the upstream accepted, not the rejected original", async () => {
  // The first call is rejected for an unsupported parameter, so callResponses drops it and
  // retries — that adapted body is what actually worked. Then the socket dies before any output.
  // The transport retry must send the ADAPTED body; replaying the original would re-trigger the
  // same 400 (and, for a compacted context, re-compact work already done).
  const bodies = [];
  let n = 0;
  handler = (req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      n++;
      if (n === 1) {
        // The model caps completion tokens lower than asked. callResponses re-sends with the
        // reduced cap — that adapted body is the one that works.
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "max_output_tokens: this model supports at most 100 completion tokens" } }));
        return;
      }
      if (n === 2) {                                  // accepted, then the socket dies
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": warming up\n\n");
        setTimeout(() => res.socket.destroy(), 20);
        return;
      }
      sseOk(res, "recovered");                        // the retry
    });
  };

  const r = await fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 4096, stream: true,
                           messages: [{ role: "user", content: "hello" }] }),
  });
  const body = await r.text();

  assert.ok(bodies.length >= 3, `expected reject, accept, retry — saw ${bodies.length} calls`);
  assert.equal(bodies[0].max_output_tokens, 4096, "the first call asks for the full budget");
  assert.equal(bodies[1].max_output_tokens, 100, "the accepted call is the capped one");
  assert.equal(bodies[bodies.length - 1].max_output_tokens, 100,
    "the transport retry must reuse the accepted (capped) body, not the rejected original");
  assert.match(body, /recovered/, "and the turn should still succeed");
});

test("a tool call cut off mid-arguments is never handed over as executable", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
    send("response.created", { type: "response.created", response: { id: "resp_1" } });
    // A function call opens and starts streaming arguments, then the socket dies before
    // output_item.done. Previously hasTool was already true, so the turn could finish with
    // stop_reason=tool_use and the agent would execute a half-parsed call.
    send("response.output_item.added", { type: "response.output_item.added", output_index: 0,
         item: { id: "i1", type: "function_call", name: "Bash", call_id: "call_1" } });
    send("response.function_call_arguments.delta",
         { type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"command":"rm -r' });
    setTimeout(() => res.socket.destroy(), 20);
  };

  const { body } = await ask();
  assert.doesNotMatch(body, /"stop_reason":"tool_use"/,
    "an incomplete tool call must not be reported as a usable tool call");
  assert.match(body, /"stop_reason":"error"/, "it must be reported as an error");
  // The truncated arguments must not reach the client as a complete input_json_delta.
  assert.doesNotMatch(body, /input_json_delta/,
    "no argument payload may be emitted for a call whose arguments never finished");
});
