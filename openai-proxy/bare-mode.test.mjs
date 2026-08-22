// Bare mode (OPENAI_BARE_MODE=1): a MAIN turn is forwarded with ONLY its conversation messages —
// no system prompt, no tools, no tool_choice. Classifier/compaction turns are unaffected.
//   node --test openai-proxy/bare-mode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
process.env.OPENAI_BARE_MODE = "1";                 // pins BARE_MODE on for this module

const { toOpenAI, toResponses } = await import("./proxy.mjs");
const { ROUTE } = await import("./routes.mjs");

const BODY = () => ({
  system: "You are Claude Code.",
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "Bash", input_schema: { type: "object", properties: {} } },
          { name: "Read", input_schema: { type: "object", properties: {} } }],
  tool_choice: { type: "any" },
  max_tokens: 100,
});

test("bare mode strips system + tools + tool_choice from a MAIN chat turn, keeping the messages", () => {
  const { payload } = toOpenAI(BODY(), "gpt-4.1-mini", ROUTE.MAIN);
  assert.ok(!payload.messages.some((m) => m.role === "system"), "no system message is sent");
  assert.equal(payload.tools, undefined, "no tools array");
  assert.equal(payload.tool_choice, undefined, "no tool_choice");
  const user = payload.messages.filter((m) => m.role === "user");
  assert.equal(user.length, 1, "the user message survives");
  assert.match(JSON.stringify(user[0].content), /hello/);
  assert.doesNotMatch(JSON.stringify(payload), /You are Claude Code/, "system text never leaves");
});

test("bare mode strips instructions + tools + tool_choice from a MAIN responses turn", () => {
  const { payload } = toResponses(BODY(), "gpt-4.1-mini", ROUTE.MAIN);
  assert.equal(payload.instructions, undefined, "no instructions");
  assert.equal(payload.tools, undefined, "no tools");
  assert.equal(payload.tool_choice, undefined, "no tool_choice");
  assert.ok((payload.input || []).length >= 1, "the conversation input survives");
});

test("bare mode does NOT touch a classifier turn — it needs its prompt to render a verdict", () => {
  const cls = { system: "You are a safety classifier.", messages: [{ role: "user", content: "x" }], max_tokens: 64 };
  const { payload } = toOpenAI(cls, "gpt-4.1-mini", ROUTE.PREFIX);
  assert.ok(payload.messages.some((m) => m.role === "system"), "the classifier keeps its system prompt");
});
