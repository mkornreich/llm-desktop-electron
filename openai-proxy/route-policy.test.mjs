// Route-specific effort and per-surface capability memory.
//   node --test openai-proxy/route-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
const {
  rememberUnsupported, stripUnsupported, effortFor, lowerEffort,
} = await import("./proxy.mjs");
const { ROUTE, effortForRoute, outputCeilingForRoute } = await import("./routes.mjs");

// ---------- the key that was wrong ----------

test("a Chat rejection does not suppress the same field on Responses", () => {
  // THE BUG. The memo was keyed by model alone. gpt-5.6-sol on Chat Completions answers "Function
  // tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions", while the
  // same model on Responses supports reasoning fully — so one Chat rejection taught the process that
  // the model rejects reasoning, and every later Responses call silently went out without it.
  const model = "gpt-5.6-sol-memo-test";
  rememberUnsupported(model, "reasoning", "chat");
  const onChat = stripUnsupported({ model, reasoning: { effort: "max" }, other: 1 }, "chat");
  assert.equal(onChat.reasoning, undefined, "the surface that rejected it must not receive it again");
  const onResponses = stripUnsupported({ model, reasoning: { effort: "max" }, other: 1 }, "responses");
  assert.deepEqual(onResponses.reasoning, { effort: "max" },
    "the surface that supports it must be unaffected");
  assert.equal(onResponses.other, 1);
});

test("an effort step taken on Chat does not lower effort on Responses", () => {
  const model = "gpt-effort-memo-test";
  const before = effortFor(model, "responses", ROUTE.MAIN);
  lowerEffort(model, "max", "chat");
  assert.equal(effortFor(model, "responses", ROUTE.MAIN), before,
    "Responses keeps the target effort after a Chat rejection");
  assert.notEqual(effortFor(model, "chat", ROUTE.MAIN), before,
    "and Chat remembers its own ceiling");
});

test("the memo is per model as well as per surface", () => {
  rememberUnsupported("model-A-memo", "stop", "chat");
  assert.equal(stripUnsupported({ model: "model-A-memo", stop: ["x"] }, "chat").stop, undefined);
  assert.deepEqual(stripUnsupported({ model: "model-B-memo", stop: ["x"] }, "chat").stop, ["x"],
    "one model's rejection says nothing about another's");
});

test("a field path is remembered whole, not by its last segment", () => {
  // A nested rejection drops the WHOLE dotted path (dropPath walks it — needed since groq rejects
  // nested fields like "reasoning.summary") and must NOT touch a top-level field that shares its
  // last segment.
  rememberUnsupported("model-path-memo", "text.verbosity", "responses");
  const out = stripUnsupported({ model: "model-path-memo", text: { verbosity: "high" }, verbosity: "x" },
                               "responses");
  assert.equal(out.verbosity, "x", "the top-level field with the same last segment survives");
  assert.deepEqual(out.text, {}, "the whole dotted path text.verbosity is dropped, not matched by last segment");
});

// ---------- route targets, deliberately unchanged ----------

test("the route effort table reproduces the incumbent behaviour exactly", () => {
  // This phase adds the mechanism and moves no default. A default may only change on paired
  // evaluation showing zero safety or tool regression plus a credible quality or speed result, and
  // none of that evidence exists yet — so a tuned table here would be changing behaviour on taste.
  assert.equal(effortForRoute(ROUTE.MAIN, "max"), "max", "an agent turn keeps the global effort");
  assert.equal(effortForRoute(ROUTE.COMPACTION, "max"), "max", "compaction is unchanged pending measurement");
  for (const r of [ROUTE.PREFIX, ROUTE.SAFETY_SEVERITY, ROUTE.SAFETY_BLOCK])
    assert.equal(effortForRoute(r, "max"), null, `${r} requests no reasoning at all`);
  // An unknown route inherits the global target rather than silently losing reasoning.
  assert.equal(effortForRoute("some-future-route", "high"), "high");
});

test("null effort and an effort of \"none\" are different things", () => {
  // null means do not send the parameter. "none" asks the model for reasoning at its lowest setting
  // and still pays for the field — a classifier wants the former.
  assert.equal(effortForRoute(ROUTE.SAFETY_BLOCK, "max"), null);
  assert.notEqual(effortForRoute(ROUTE.SAFETY_BLOCK, "max"), "none");
  assert.equal(effortFor("any-model", "responses", ROUTE.SAFETY_BLOCK), null,
    "so no reasoning object is built for a verdict");
});

test("the target effort and the model's ceiling stay separate facts", () => {
  const model = "gpt-ceiling-test";
  assert.equal(effortFor(model, "responses", ROUTE.MAIN), "max", "target, with no ceiling learned yet");
  lowerEffort(model, "max", "responses");
  assert.equal(effortFor(model, "responses", ROUTE.MAIN), "xhigh", "ceiling now applies");
  // The route target has not moved; only what this pair accepts has.
  assert.equal(effortForRoute(ROUTE.MAIN, "max"), "max");
});

test("output ceilings: agent turns take min(asked, cap); classifier routes get a thinking-safe floor", () => {
  // Agent/compaction turns send min(client max_tokens, OPENAI_MAX_OUTPUT_TOKENS).
  assert.equal(outputCeilingForRoute(ROUTE.MAIN, 64000, 32768), 32768);
  assert.equal(outputCeilingForRoute(ROUTE.MAIN, 64, 32768), 64);
  // A classifier route is FLOORED: a thinking model (on-device qwen3) spends the client's tiny budget on
  // hidden reasoning and never emits its <block> verdict — an empty, unparseable verdict. The floor gives
  // it room to reason + answer; the model still stops early, so this is a ceiling not a target.
  assert.equal(outputCeilingForRoute(ROUTE.SAFETY_BLOCK, 32, 32768), 1024, "floored up to the classifier minimum");
  assert.equal(outputCeilingForRoute(ROUTE.PREFIX, 64, 32768), 1024);
  assert.equal(outputCeilingForRoute(ROUTE.SAFETY_BLOCK, 32, 512), 512, "but never above the hard cap");
  assert.equal(outputCeilingForRoute(ROUTE.SAFETY_BLOCK, 4096, 32768), 4096, "a larger client ask is kept");
});
