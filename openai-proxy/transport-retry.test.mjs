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

test("gives up after the bound and does not retry forever", async () => {
  let attempts = 0;
  handler = (req, res) => {                    // always drop
    attempts++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": warming up\n\n");
    setTimeout(() => res.socket.destroy(), 10);
  };

  const { status } = await ask();
  assert.equal(status, 200);                   // headers were already sent; the stream just ends
  // 1 initial attempt + MAX_TRANSPORT_RETRIES. Bounded is the point: an unreachable upstream
  // must not spin.
  assert.ok(attempts <= 4, `expected a small bounded number of attempts, saw ${attempts}`);
  assert.ok(attempts >= 2, `expected at least one retry, saw ${attempts}`);
});

test("does not restart a turn once content has been emitted", async () => {
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
});
