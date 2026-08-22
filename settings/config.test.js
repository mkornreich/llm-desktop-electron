// Tests for the settings-window config layer. The one that matters is comment
// preservation: the dot files are mostly documentation, and a GUI that silently ate it
// would be worse than no GUI.
//   node --test settings/config.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, readValues, writeValues } = require("./config.js");
const jsonc = require("../openai-proxy/jsonc.cjs");

// A scratch config.jsonc so the real one is never touched by a test run.
function withTempConfig(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
  const file = path.join(dir, "config.jsonc");
  fs.writeFileSync(file, body);
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const SAMPLE = `{
  // which provider backs the agent — a long doc line that must survive a write
  "mode": "proxy",
  "defaultProvider": "local",
  "providers": { "local": { "model": "gemma4:latest", "context": { "granite4.1:8b": 65536 } } },
  "reasoning": { "effort": "max", "showThinking": true },
  "privacy": { "disableTelemetry": true }
}
`;

test("writing a value edits config.jsonc in place and preserves every comment", () => {
  withTempConfig(SAMPLE, (file) => {
    writeValues({ PROVIDER: "anthropic" }, file);
    const after = fs.readFileSync(file, "utf8");
    assert.match(after, /"mode": "anthropic"/);
    assert.ok(!/"mode": "proxy"/.test(after), "old value must be gone");
    assert.match(after, /a long doc line that must survive a write/, "the comment survives");
    assert.equal(jsonc.readConfigText(after).defaultProvider, "local", "siblings are untouched");
  });
});

test("types round-trip: bool -> JSON boolean, int -> number, composite -> array", () => {
  withTempConfig(SAMPLE, (file) => {
    // showThinking exists (replaced); minBudget + composite are absent leaves (inserted).
    writeValues({ OPENAI_SHOW_THINKING: "0", OPENAI_THINKING_MIN_BUDGET: "4000", OPENAI_COMPOSITE_MODELS: "a, b ,c" }, file);
    const c = jsonc.readConfig(file);
    assert.equal(c.reasoning.showThinking, false, "bool stored as a real boolean");
    assert.equal(c.reasoning.minBudget, 4000, "int stored as a number");
    assert.deepEqual(c.composite, ["a", "b", "c"], "composite stored as a trimmed array");
  });
});

test("reading maps native JSONC values back to the GUI string form", () => {
  withTempConfig(SAMPLE, (file) => {
    const v = readValues(file);
    assert.equal(v.PROVIDER.value, "proxy");
    assert.equal(v.OPENAI_SHOW_THINKING.value, "1", "true -> '1' for the checkbox");
    assert.equal(v.DISABLE_TELEMETRY.value, "1");
    assert.equal(v.LOCAL_MODEL.value, "gemma4:latest");
  });
});

test("a per-model CONTEXT_<model> with a dotted name is one path segment", () => {
  withTempConfig(SAMPLE, (file) => {
    writeValues({ "CONTEXT_granite4.1:8b": "32768" }, file);
    const c = jsonc.readConfig(file);
    assert.equal(c.providers.local.context["granite4.1:8b"], 32768, "the '.' in the model name is not a path split");
  });
});

test("unknown keys are ignored rather than written", () => {
  withTempConfig(SAMPLE, (file) => {
    const before = fs.readFileSync(file, "utf8");
    assert.deepEqual(writeValues({ NOT_A_REAL_SETTING: "x" }, file), []);
    assert.equal(fs.readFileSync(file, "utf8"), before, "the file is untouched");
  });
});

test("reading falls back to the schema default when a key is absent", () => {
  withTempConfig(`{ "mode": "anthropic" }\n`, (file) => {
    const v = readValues(file);
    assert.equal(v.PROVIDER.value, "anthropic");
    assert.equal(v.PROVIDER.fromFile, true);
    assert.equal(v.DISABLE_TELEMETRY.value, "1", "absent -> schema default");
    assert.equal(v.DISABLE_TELEMETRY.fromFile, false);
  });
});

test("every GUI setting maps to a live path in config.jsonc, and the key knobs are covered", () => {
  // Guards against a GUI setting pointing at a config.jsonc path that does not exist (a dead editor field),
  // and against adding a section without exposing its knobs. Every setting's PARENT object must exist so
  // writeValues can replace or insert the leaf; and the load-bearing knobs must be present in PATHS.
  const { PATHS } = require("./config.js");
  const C = jsonc.readConfig();
  const getPath = (o, d) => d.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  for (const [key, p] of Object.entries(PATHS)) {
    const parent = p.includes(".") ? getPath(C, p.slice(0, p.lastIndexOf("."))) : C;
    assert.ok(parent && typeof parent === "object", `GUI path for ${key} ('${p}') has no parent object in config.jsonc`);
  }
  const exposed = new Set(Object.values(PATHS));
  for (const p of ["mode", "defaultProvider", "providers.local.model", "reasoning.effort",
                   "output.maxTurnOutputTokens", "privacy.disableTelemetry", "sync.sessions",
                   "diagnostics.ultracode", "compaction.autoCompactWindow"])
    assert.ok(exposed.has(p), `${p} must be exposed in the GUI (PATHS)`);
});

test("the provider enum is proxy|anthropic with a default-upstream selector", () => {
  const prov = SCHEMA.find((s) => s.key === "PROVIDER");
  assert.deepEqual(prov.options, ["proxy", "anthropic"], "the five non-anthropic modes merged into proxy");
  const dp = SCHEMA.find((s) => s.key === "DEFAULT_PROVIDER");
  assert.ok(dp, "DEFAULT_PROVIDER must be exposed");
  assert.equal(dp.file, ".provider");
  assert.deepEqual(dp.options, ["openai", "local", "openrouter", "cohere", "gemini", "mistral", "groq", "ollama"]);
});

test("every schema entry is well formed", () => {
  for (const s of SCHEMA) {
    assert.ok(s.file && s.key && s.type && s.label, `incomplete entry: ${s.key}`);
    assert.ok(["bool", "int", "text", "enum", "ollama", "ollama-context", "openrouter", "composite", "modelpicker", "classifiermodel"].includes(s.type), `bad type on ${s.key}`);
    if (s.type === "enum") assert.ok(Array.isArray(s.options) && s.options.length, `enum ${s.key} needs options`);
    assert.ok(s.default !== undefined, `${s.key} needs a default`);
  }
});
