"use strict";
// node --test openai-proxy/jsonc.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const { readConfigText, editText, locate, JsoncSyntaxError } = require("./jsonc.cjs");

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

// ---- strictness: malformed input is a JsoncSyntaxError at line:column, never a best-effort guess ----

test("the stray-quote typo is rejected at its column (it used to parse as a junk key worth 0)", () => {
  const src = `{\n  "classifier": {\n    "prefix": ""openrouter2:z-ai/glm-5.3-flash",\n  }\n}`;
  assert.throws(() => readConfigText(src, "config.jsonc"), (e) =>
    e instanceof JsoncSyntaxError && e.line === 3 && e.column === 17
    && e.message.startsWith(`config.jsonc:3:17: expected ',' or '}' after the value of "prefix", found 'openrouter2'`));
});

test("malformed shapes each fail where they go wrong", () => {
  const at = (src) => { try { readConfigText(src); } catch (e) { return [e.line, e.column, e.reason]; } return null; };
  assert.deepEqual(at(`{"a": foo}`).slice(0, 2), [1, 7]);                       // bare identifier value
  assert.deepEqual(at(`{"a": 1, b: 2}`).slice(0, 2), [1, 10]);                  // unquoted key
  assert.deepEqual(at(`{"a": [1 2]}`).slice(0, 2), [1, 10]);                    // missing comma in an array
  assert.deepEqual(at(`{"a": "x\n}`).slice(0, 2), [1, 7]);                      // unterminated string -> its opening quote
  assert.match(at(`{"a": "\\q"}`)[2], /invalid escape/);
  assert.match(at(`{"a": 01}`)[2], /found '01'/);                               // not JSON number grammar
  assert.match(at(`{"a": 1} {}`)[2], /after the end of the top-level value/);
  assert.match(at(`{"a": [1, 2]`)[2], /unterminated object/);
  assert.match(at(``)[2], /found end of input/);
});

test("the editor refuses to splice into a malformed document", () => {
  const src = `{ "mode": "proxy" "n": 1 }`;
  assert.throws(() => editText(src, ["n"], 2), JsoncSyntaxError);
});

test("legitimate JSONC is unaffected: comments anywhere, trailing commas, a BOM, escapes", () => {
  const src = `﻿/* lead */ { "a": [1, -2.5e1, true, null,], // tail\n "s": "q\\"\\u00e9\\n", }  // end`;
  assert.deepEqual(readConfigText(src), { a: [1, -25, true, null], s: 'q"é\n' });
});
