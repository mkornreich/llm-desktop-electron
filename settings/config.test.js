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

const { SCHEMA } = require("./config.js");

// Work on a scratch copy so the real dot files are never touched by a test run.
function withTempRoot(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  // Re-require config.js with __dirname pointing inside the scratch dir.
  const sub = path.join(dir, "settings");
  fs.mkdirSync(sub);
  fs.copyFileSync(path.join(__dirname, "config.js"), path.join(sub, "config.js"));
  delete require.cache[path.join(sub, "config.js")];
  const mod = require(path.join(sub, "config.js"));
  try { return fn(mod, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const DOCUMENTED = `# Which model provider backs the agent.
#
#   openai     -> route through the proxy
#   anthropic  -> call Anthropic directly
#
# Long explanation that must survive a write.
PROVIDER=openai
`;

test("writing a value preserves every comment and the file shape", () => {
  withTempRoot({ ".provider": DOCUMENTED }, (mod, dir) => {
    mod.writeValues({ PROVIDER: "anthropic" });
    const after = fs.readFileSync(path.join(dir, ".provider"), "utf8");
    assert.match(after, /^PROVIDER=anthropic$/m);
    assert.ok(!/PROVIDER=openai/.test(after), "old value must be gone");
    // every comment line survives, in order
    const before = DOCUMENTED.split("\n").filter((l) => l.startsWith("#"));
    const now = after.split("\n").filter((l) => l.startsWith("#"));
    assert.deepEqual(now, before, "comments must be byte-identical and in order");
    assert.equal(after.split("\n").length, DOCUMENTED.split("\n").length, "no lines added or lost");
  });
});

test("a key absent from the file is appended, not silently dropped", () => {
  withTempRoot({ ".openai-model": "# header\nOPENAI_MODEL=gpt-5.4\n" }, (mod, dir) => {
    mod.writeValues({ OPENAI_THINKING_MIN_BUDGET: "4000" });
    const after = fs.readFileSync(path.join(dir, ".openai-model"), "utf8");
    assert.match(after, /^OPENAI_THINKING_MIN_BUDGET=4000$/m);
    assert.match(after, /# header/);
    assert.match(after, /OPENAI_MODEL=gpt-5\.4/);
    assert.match(after, /Added by the settings window/);
  });
});

test("a commented-out key is not mistaken for the real one", () => {
  // .privacy documents the setting in prose above it — the writer must not edit the comment.
  const body = "# DISABLE_TELEMETRY=1 -> turn OFF all telemetry\n#\nDISABLE_TELEMETRY=1\n";
  withTempRoot({ ".privacy": body }, (mod, dir) => {
    mod.writeValues({ DISABLE_TELEMETRY: "0" });
    const after = fs.readFileSync(path.join(dir, ".privacy"), "utf8");
    assert.match(after, /^# DISABLE_TELEMETRY=1 -> turn OFF all telemetry$/m, "comment untouched");
    assert.match(after, /^DISABLE_TELEMETRY=0$/m, "real line updated");
  });
});

test("writes are grouped per file and only touch the files involved", () => {
  withTempRoot({ ".provider": "PROVIDER=openai\n", ".sync": "SYNC_CLAUDE_SESSIONS=1\n" }, (mod, dir) => {
    const before = fs.readFileSync(path.join(dir, ".sync"), "utf8");
    const written = mod.writeValues({ PROVIDER: "anthropic" });
    assert.deepEqual(written, [".provider"]);
    assert.equal(fs.readFileSync(path.join(dir, ".sync"), "utf8"), before, "untouched file must be byte-identical");
  });
});

test("unknown keys are ignored rather than written", () => {
  withTempRoot({ ".provider": "PROVIDER=openai\n" }, (mod, dir) => {
    const written = mod.writeValues({ NOT_A_REAL_SETTING: "x" });
    assert.deepEqual(written, []);
    assert.equal(fs.readFileSync(path.join(dir, ".provider"), "utf8"), "PROVIDER=openai\n");
  });
});

test("reading falls back to the schema default when a key is absent", () => {
  withTempRoot({ ".provider": "PROVIDER=anthropic\n" }, (mod) => {
    const v = mod.readValues();
    assert.equal(v.PROVIDER.value, "anthropic");
    assert.equal(v.PROVIDER.fromFile, true);
    // absent from the scratch dir entirely
    assert.equal(v.DISABLE_TELEMETRY.value, "1");
    assert.equal(v.DISABLE_TELEMETRY.fromFile, false);
  });
});

test("the schema covers every parameter the proxy and launcher read", () => {
  // Guards against adding a knob to proxy.mjs and forgetting to surface it in the GUI.
  const proxy = fs.readFileSync(path.join(__dirname, "..", "openai-proxy", "proxy.mjs"), "utf8");
  const run = fs.readFileSync(path.join(__dirname, "..", "run.sh"), "utf8");
  const keys = new Set(SCHEMA.map((s) => s.key));
  const fromProxy = new Set([...proxy.matchAll(/PROJECT\.([A-Z_]+)/g)].map((m) => m[1]));
  const missing = [...fromProxy].filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `proxy reads settings the GUI does not expose: ${missing}`);
  for (const k of ["PROVIDER", "DISABLE_TELEMETRY", "SYNC_CLAUDE_SESSIONS"])
    assert.ok(run.includes(k) && keys.has(k), `${k} must be read by run.sh and exposed`);

  // The check above only sees what the PROXY reads (PROJECT.X). Anything run.sh reads straight
  // out of a dot file slipped past it — which is how CLAUDE_CODE_AUTO_COMPACT_WINDOW, the knob
  // that decides the context window the app displays, stayed invisible in the GUI. So assert
  // against the dot files themselves: if a setting is persisted, it is exposed.
  for (const f of [".provider", ".privacy", ".sync", ".openai-model", ".diagnostics", ".openrouter-model", ".cohere-model", ".gemini-model"]) {
    const txt = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const persisted = [...txt.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    assert.ok(persisted.length, `${f} should define at least one setting`);
    const absent = persisted.filter((k) => !keys.has(k));
    assert.deepEqual(absent, [], `${f} persists settings the GUI does not expose: ${absent}`);
  }
});

test("the provider enum is proxy|anthropic with a default-upstream selector", () => {
  const prov = SCHEMA.find((s) => s.key === "PROVIDER");
  assert.deepEqual(prov.options, ["proxy", "anthropic"], "the five non-anthropic modes merged into proxy");
  const dp = SCHEMA.find((s) => s.key === "DEFAULT_PROVIDER");
  assert.ok(dp, "DEFAULT_PROVIDER must be exposed");
  assert.equal(dp.file, ".provider");
  assert.deepEqual(dp.options, ["openai", "local", "openrouter", "cohere", "gemini"]);
});

test("every schema entry is well formed", () => {
  for (const s of SCHEMA) {
    assert.ok(s.file && s.key && s.type && s.label, `incomplete entry: ${s.key}`);
    assert.ok(["bool", "int", "text", "enum", "ollama", "ollama-context", "openrouter", "composite"].includes(s.type), `bad type on ${s.key}`);
    if (s.type === "enum") assert.ok(Array.isArray(s.options) && s.options.length, `enum ${s.key} needs options`);
    assert.ok(s.default !== undefined, `${s.key} needs a default`);
  }
});
