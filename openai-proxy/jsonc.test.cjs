"use strict";
// node --test openai-proxy/jsonc.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const { readConfigText, editText, locate } = require("./jsonc.cjs");

const SAMPLE = `{
  // top comment
  "mode": "proxy",        // trailing comment on a value
  "defaultProvider": "local",
  "providers": {
    "gemini": { "endpoint": "https://g/v1", "api": "chat", "model": "gemini-3-flash-preview" },
    "local": {
      /* block comment */
      "model": "gemma4:latest",
      "context": { "gemma4:latest": 32768 }
    }
  },
  "composite": ["mistral:mistral-large-latest", "cohere:command-a-plus"],
  "reasoning": { "effort": "max", "minBudget": 4000, "showThinking": true },
}`;

test("readConfigText parses comments and a trailing comma", () => {
  const c = readConfigText(SAMPLE);
  assert.equal(c.mode, "proxy");
  assert.equal(c.providers.gemini.model, "gemini-3-flash-preview");
  assert.equal(c.providers.local.context["gemma4:latest"], 32768);
  assert.deepEqual(c.composite, ["mistral:mistral-large-latest", "cohere:command-a-plus"]);
  assert.equal(c.reasoning.minBudget, 4000);
  assert.equal(c.reasoning.showThinking, true);
});

test("editing a scalar preserves every comment and only changes that value", () => {
  const out = editText(SAMPLE, ["mode"], "anthropic");
  assert.equal(readConfigText(out).mode, "anthropic");
  assert.match(out, /\/\/ top comment/);
  assert.match(out, /\/\/ trailing comment on a value/);
  assert.match(out, /\/\* block comment \*\//);
  // nothing else moved
  assert.equal(readConfigText(out).providers.gemini.model, "gemini-3-flash-preview");
  // reverting the single value reproduces the original byte-for-byte (only that span changed)
  assert.equal(out.replace('"anthropic"', '"proxy"'), SAMPLE);
});

test("editing a NESTED value touches only that span", () => {
  const out = editText(SAMPLE, ["providers", "gemini", "model"], "gemini-3.6-flash");
  assert.equal(readConfigText(out).providers.gemini.model, "gemini-3.6-flash");
  assert.equal(readConfigText(out).providers.local.model, "gemma4:latest");
  assert.match(out, /\/\* block comment \*\//);
});

test("editing an array value works", () => {
  const out = editText(SAMPLE, ["composite"], ["groq:openai/gpt-oss-120b", "local:qwen3:8b"]);
  assert.deepEqual(readConfigText(out).composite, ["groq:openai/gpt-oss-120b", "local:qwen3:8b"]);
});

test("editing a number and a boolean", () => {
  let out = editText(SAMPLE, ["reasoning", "minBudget"], 2000);
  assert.equal(readConfigText(out).reasoning.minBudget, 2000);
  out = editText(SAMPLE, ["reasoning", "showThinking"], false);
  assert.equal(readConfigText(out).reasoning.showThinking, false);
});

test("inserting a missing leaf into an existing object (new CONTEXT model)", () => {
  const out = editText(SAMPLE, ["providers", "local", "context", "qwen3:8b"], 40960);
  const c = readConfigText(out);
  assert.equal(c.providers.local.context["qwen3:8b"], 40960);
  assert.equal(c.providers.local.context["gemma4:latest"], 32768, "existing sibling survives");
});

test("locate returns null span for a genuinely missing path", () => {
  assert.equal(locate(SAMPLE, ["nope", "missing"]).span, null);
});

test("a value containing // or /* is not mistaken for a comment", () => {
  const src = `{ "u": "http://x/*y//z", "n": 1 }`;
  assert.equal(readConfigText(src).u, "http://x/*y//z");
  const out = editText(src, ["n"], 2);
  assert.equal(readConfigText(out).u, "http://x/*y//z");
  assert.equal(readConfigText(out).n, 2);
});
