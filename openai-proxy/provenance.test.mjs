// Session provenance: what actually answered, recorded where it cannot be lost.
//   node --test openai-proxy/provenance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  record, read, list, fingerprint, sanitizeId, fileFor, SCHEMA_VERSION, MAX_EPOCHS,
} from "../scripts/lib/provenance.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "prov-"));
const EPOCH = {
  provider: "openai", wireModel: "claude-opus-4-8", resolvedModel: "gpt-5.6-sol",
  apiSurface: "responses", route: "main", capabilityIdentity: "claude-opus-4-8[1m]",
  contextBeta: "context-1m-2025-08-07", configHash: "abc123", codeVersion: "def456",
  source: "persisted",
};

// ---------- the six dimensions ----------

test("the dimensions that used to be one `model` field are recorded separately", () => {
  // The bug this fixes: a session's stored `model` is what the CLIENT selected, and in OpenAI mode
  // that is never what answered. Six things were collapsed into it, so "which model wrote this?"
  // could not be answered afterwards.
  const dir = tmp();
  const r = record("sess-1", EPOCH, { dir });
  assert.equal(r.written, true);
  const rec = read("sess-1", dir);
  const e = rec.created;
  assert.equal(e.wireModel, "claude-opus-4-8", "what arrived on the wire");
  assert.equal(e.resolvedModel, "gpt-5.6-sol", "what actually answered");
  assert.equal(e.capabilityIdentity, "claude-opus-4-8[1m]", "what set the context window");
  assert.equal(e.contextBeta, "context-1m-2025-08-07", "what the client itself negotiated");
  assert.equal(e.apiSurface, "responses");
  assert.equal(e.route, "main");
  assert.equal(e.provider, "openai");
  // Configured capability and negotiated capability are kept apart on purpose: they can disagree,
  // and when they do the negotiated one is what actually applied.
  assert.notEqual(e.capabilityIdentity, e.contextBeta);
});

test("a launch-time override is distinguishable from a saved setting", () => {
  // `OPENAI_MODEL=x ./run.sh` resolves to exactly the same value as a persisted setting, so
  // without this a temporary override is indistinguishable from a saved one forever.
  const dir = tmp();
  record("s", { ...EPOCH, source: "launch override" }, { dir });
  assert.equal(read("s", dir).created.source, "launch override");
});

// ---------- append-only ----------

test("creation provenance is immutable and later changes append", () => {
  const dir = tmp();
  record("s", EPOCH, { dir });
  record("s", { ...EPOCH, provider: "anthropic", resolvedModel: "claude-opus-4-8" }, { dir });
  const rec = read("s", dir);
  // Rewriting the provider to "current" would erase that half the session was answered by
  // something else — which is the exact question this file exists to answer.
  assert.equal(rec.created.provider, "openai", "creation must never be rewritten");
  assert.equal(rec.epochs.length, 2);
  assert.equal(rec.epochs[0].provider, "openai");
  assert.equal(rec.epochs[1].provider, "anthropic");
  // Labelled for what it is. A provider change is not just "changed": the earlier half of the
  // session was answered by something else, and a persisted model id from before is meaningless
  // under the new provider.
  assert.equal(rec.epochs[1].kind, "provider-switch");
});

test("a cross-provider resume is reported to the caller, not just recorded", () => {
  const dir = tmp();
  record("s", EPOCH, { dir });
  const same = record("s", { ...EPOCH, resolvedModel: "gpt-5.4" }, { dir });
  assert.equal(same.providerSwitch, null, "a model change within one provider is not a switch");
  const switched = record("s", { ...EPOCH, provider: "anthropic" }, { dir });
  assert.deepEqual(switched.providerSwitch, { from: "openai", to: "anthropic" });
  assert.match(switched.reason, /provider switched openai -> anthropic/);
  // And it is countable afterwards, so the settings window can say how many sessions are affected.
  assert.equal(list({ dir })[0].switches, 1);
});

test("an ordinary change is not mislabelled as a provider switch", () => {
  const dir = tmp();
  record("s", EPOCH, { dir });
  const r = record("s", { ...EPOCH, route: "safety:block", resolvedModel: "gpt-5.4-2026-03-05" }, { dir });
  assert.equal(r.providerSwitch, null);
  assert.equal(read("s", dir).epochs[1].kind, "changed");
  assert.equal(list({ dir })[0].switches, 0);
});

test("an unchanged setup does not append — a busy session is one epoch, not one per turn", () => {
  const dir = tmp();
  assert.equal(record("s", EPOCH, { dir }).written, true);
  for (let i = 0; i < 50; i++) {
    const r = record("s", EPOCH, { dir });
    assert.equal(r.written, false);
    assert.equal(r.reason, "unchanged");
  }
  assert.equal(read("s", dir).epochs.length, 1, "50 identical turns are one epoch");
});

test("every dimension that matters triggers a new epoch when it changes", () => {
  // If a dimension is missing from the fingerprint, a real change is silently absorbed into the
  // previous epoch and the history says it never happened.
  for (const [k, v] of Object.entries({
    provider: "anthropic", wireModel: "claude-sonnet-5", resolvedModel: "gpt-5.4",
    apiSurface: "chat", route: "safety:block", capabilityIdentity: "claude-opus-4-8",
    contextBound: 900000, configHash: "zzz", codeVersion: "yyy", source: "launch override",
  })) {
    const dir = tmp();
    record("s", EPOCH, { dir });
    const r = record("s", { ...EPOCH, [k]: v }, { dir });
    assert.equal(r.written, true, `a change to ${k} must be recorded`);
    assert.equal(read("s", dir).epochs.length, 2, `a change to ${k} must append an epoch`);
  }
});

test("a mid-session provider or model switch is surfaced, not reduced to the latest", () => {
  const dir = tmp();
  record("s", EPOCH, { dir });
  record("s", { ...EPOCH, provider: "anthropic", resolvedModel: "claude-opus-4-8" }, { dir });
  const [row] = list({ dir });
  assert.deepEqual(row.providersSeen.sort(), ["anthropic", "openai"]);
  assert.deepEqual(row.modelsSeen.sort(), ["claude-opus-4-8", "gpt-5.6-sol"]);
  assert.equal(row.provider, "anthropic", "and the latest is still available");
  assert.equal(row.epochs, 2);
});

test("the epoch list is bounded, and truncation is recorded rather than hidden", () => {
  const dir = tmp();
  for (let i = 0; i < MAX_EPOCHS + 25; i++) record("s", { ...EPOCH, configHash: `h${i}` }, { dir });
  const rec = read("s", dir);
  assert.equal(rec.epochs.length, MAX_EPOCHS, "bounded");
  assert.equal(rec.droppedEpochs, 25, "a truncated history must not read as a complete one");
  assert.equal(rec.created.configHash, "h0", "creation survives truncation");
  assert.equal(list({ dir })[0].droppedEpochs, 25);
});

// ---------- durability ----------

test("a write is atomic: readers see the old record or the new one, never half", () => {
  const dir = tmp();
  record("s", EPOCH, { dir });
  record("s", { ...EPOCH, resolvedModel: "gpt-5.4" }, { dir });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), [],
    "no temp file may be left behind");
  assert.equal(read("s", dir).epochs.length, 2);
});

test("a corrupt record is preserved as evidence, not deleted, and a fresh one starts", () => {
  // A truncated provenance file is itself a fact about a crash. Deleting it destroys that, and
  // returning garbage would poison every later read.
  const dir = tmp();
  record("s", EPOCH, { dir });
  fs.writeFileSync(fileFor("s", dir), "{ half a record");
  assert.equal(read("s", dir), null, "unparseable reads as absent");
  assert.ok(fs.existsSync(`${fileFor("s", dir)}.corrupt`), "the damaged file is kept");
  const r = record("s", EPOCH, { dir });
  assert.equal(r.written, true);
  assert.equal(r.reason, "new session");
});

test("a record from a NEWER schema version is never overwritten", () => {
  // Two checkouts can share a directory. Silently rewriting a future shape with an older one loses
  // whatever that version knew.
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor("s", dir), JSON.stringify({ version: SCHEMA_VERSION + 5, epochs: [] }));
  const rec = read("s", dir);
  assert.match(rec.unreadable, /schema version/);
  const r = record("s", EPOCH, { dir });
  assert.equal(r.written, false, "must refuse rather than clobber");
  assert.match(JSON.parse(fs.readFileSync(fileFor("s", dir), "utf8")).version + "", /\d+/);
  assert.equal(JSON.parse(fs.readFileSync(fileFor("s", dir), "utf8")).version, SCHEMA_VERSION + 5);
});

test("an older schema version is not misread as current", () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor("s", dir), JSON.stringify({ version: 0, epochs: [{ provider: "x" }] }));
  assert.equal(read("s", dir), null, "nothing to migrate from yet, so it does not pretend");
});

test("concurrent writers each land a complete record", async () => {
  // Per-session files mean concurrent writes touch different inodes; this pins that a burst across
  // several sessions leaves every one of them parseable.
  const dir = tmp();
  await Promise.all(Array.from({ length: 40 }, (_, i) =>
    Promise.resolve().then(() => record(`sess-${i % 8}`, { ...EPOCH, configHash: `h${i}` }, { dir }))));
  const rows = list({ dir, limit: 100 });
  assert.equal(rows.length, 8);
  for (const r of rows) assert.ok(r.epochs >= 1);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")))
    JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));   // throws if any is half-written
});

// ---------- the session id is untrusted input ----------

test("a session id that is not id-shaped cannot choose a path", () => {
  // It arrives in an HTTP header and becomes a FILENAME. Rejected rather than escaped.
  for (const bad of ["../../etc/passwd", "/etc/passwd", "a/b", "..", ".", "", null, undefined,
                     "x".repeat(200), "sess id", "a b"]) {
    assert.equal(sanitizeId(bad), null, `${JSON.stringify(bad)} must be rejected`);
    const dir = tmp();
    const r = record(bad, EPOCH, { dir });
    assert.equal(r.written, false, `${JSON.stringify(bad)} must not be written`);
    assert.deepEqual(fs.readdirSync(dir), [], "and must create no file at all");
  }
  // A real one is accepted unchanged.
  assert.equal(sanitizeId("0bfac150-a1d5-4253-86c7-2236cb2f8768"),
    "0bfac150-a1d5-4253-86c7-2236cb2f8768");
});

test("a missing directory is created, and a missing one lists as empty rather than throwing", () => {
  const dir = path.join(tmp(), "nested", "deeper");
  assert.deepEqual(list({ dir }), []);
  assert.equal(record("s", EPOCH, { dir }).written, true);
  assert.equal(read("s", dir).cliSessionId, "s");
});

test("fingerprint ignores the timestamp, or every turn would look like a change", () => {
  const a = fingerprint({ ...EPOCH, at: "2026-01-01T00:00:00Z" });
  const b = fingerprint({ ...EPOCH, at: "2026-06-01T00:00:00Z" });
  assert.equal(a, b);
  assert.notEqual(a, fingerprint({ ...EPOCH, resolvedModel: "other" }));
  // Absent and null must not differ, or an optional field flapping between them would append.
  assert.equal(fingerprint({ provider: "p" }), fingerprint({ provider: "p", route: null }));
});

// ---------- end to end: the header the client actually sends ----------

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";
// Pin the safety model via ENV so it stays distinct from the main model. The upstream below is a loopback
// (non-OpenAI) base, and config.mjs rewrites an unset classifier/safety model to the model-in-use there
// (a local server can't serve the gpt-5.x default) — but only when the value is NOT an env override. This
// test's point is that a safety verdict on a DIFFERENT model is its own provenance epoch, so pin it.
process.env.OPENAI_CLASSIFIER_SAFETY_MODEL = "gpt-5.4-2026-03-05";

const provDir = tmp();
process.env.PROXY_PROVENANCE_DIR = provDir;

let handler = () => {};
const upstream = http.createServer((req, res) => handler(req, res));
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { server } = await import("./proxy.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstream.close(); });

const answer = (res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: "r", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 5, output_tokens: 2 },
  }));
};
const ask = (headers = {}, body = {}) => fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({
    model: "claude-opus-4-8", max_tokens: 32, stream: false,
    messages: [{ role: "user", content: "hi" }], ...body,
  }),
});

const SID = "11111111-2222-3333-4444-555555555555";

test("a turn is attributed to the session id the client sends", async () => {
  handler = (req, res) => answer(res);
  const r = await ask({
    "x-claude-code-session-id": SID,
    "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24",
    "user-agent": "claude-cli/2.1.219 (external, sdk-cli)",
  });
  assert.equal(r.status, 200);
  const rec = read(SID, provDir);
  assert.ok(rec, `expected a record for ${SID} in ${provDir}`);
  assert.equal(rec.created.wireModel, "claude-opus-4-8");
  assert.equal(rec.created.resolvedModel, "gpt-5.6-sol", "what actually answered");
  assert.equal(rec.created.apiSurface, "responses");
  assert.equal(rec.created.route, "main");
  // Read off the client's own beta list, which is stronger evidence than the launcher's config.
  assert.equal(rec.created.contextBeta, "context-1m-2025-08-07");
  assert.equal(rec.created.effortBeta, "effort-2025-11-24");
  assert.equal(rec.created.clientVersion, "2.1.219");
  assert.match(rec.created.configHash, /^[0-9a-f]{16}$/);
});

test("a classifier turn in the same session appends its own epoch", async () => {
  // The route is a dimension, so a safety verdict on a different model is a distinct epoch rather
  // than being absorbed into the agent turn's record.
  handler = (req, res) => answer(res);
  await ask({ "x-claude-code-session-id": SID }, {
    model: "claude-sonnet-5",
    system: "You are a security monitor for autonomous AI coding agents.\nYour ENTIRE response MUST begin with <block>.",
    messages: [{ role: "user", content: "the agent wants to run: rm -rf /" }],
  });
  const rec = read(SID, provDir);
  const safety = rec.epochs.find((e) => e.route === "safety:block");
  assert.ok(safety, `expected a safety epoch, saw ${rec.epochs.map((e) => e.route).join(", ")}`);
  assert.equal(safety.resolvedModel, "gpt-5.4-2026-03-05",
    "the verdict's own model, not the agent turn's");
  assert.ok(rec.epochs.length >= 2);
});

test("a request without the header is served normally and recorded nowhere", async () => {
  // The header is the only session identity available. Inventing one — from the prompt-cache hash,
  // say — would attach one session's history to another, and forks would share a record.
  handler = (req, res) => answer(res);
  const before = fs.readdirSync(provDir).length;
  const r = await ask({});
  assert.equal(r.status, 200, "a turn must never fail for want of provenance");
  assert.equal(fs.readdirSync(provDir).length, before, "and nothing is invented");
});

test("a hostile session id header cannot write outside the provenance directory", async () => {
  handler = (req, res) => answer(res);
  const r = await ask({ "x-claude-code-session-id": "../../../../tmp/pwned" });
  assert.equal(r.status, 200, "the turn still succeeds");
  assert.ok(!fs.existsSync("/tmp/pwned.json"));
  assert.deepEqual(fs.readdirSync(provDir).filter((f) => f.includes("pwned")), []);
});
