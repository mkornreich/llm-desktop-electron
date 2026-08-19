// Tests for the settings server's status and write-validation.
//   node --test settings/server.test.js
//
// It is spawned as a real child rather than required, because it binds a port and prints its
// one-time token on stdout — which is also the only way in, so the test has to go through the
// same door a browser does.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const config = require("./config.js");

const ROOT = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
  });
}

// Boot the server and return { url, token, stop }. The URL it prints carries the token.
async function boot(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, SETTINGS_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start. Output:\n${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=([0-9a-f]+)/);
      if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${port}`, token: m[1] }); }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exited ${c}. Output:\n${out}`)); });
  });
  const api = async (p, opts = {}) => {
    const r = await fetch(`${url.base}${p}${p.includes("?") ? "&" : "?"}t=${url.token}`, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { api, base: url.base, token: url.token, stop: () => child.kill("SIGKILL"), out: () => out };
}

test("the token is required, and it is not guessable from the response", async () => {
  const s = await boot();
  try {
    // Localhost is not an authentication boundary: without this, any page you visited could POST
    // to the settings API and rewrite your config or restart your app.
    const r = await fetch(`${s.base}/api/status`, { signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 403);
    const wrong = await fetch(`${s.base}/api/status?t=deadbeef`, { signal: AbortSignal.timeout(10000) });
    assert.equal(wrong.status, 403);
    const body = await wrong.text();
    assert.ok(!body.includes(s.token), "a rejection must not leak the real token");
  } finally { s.stop(); }
});

test("status separates what is configured from what is actually running", async () => {
  const s = await boot();
  try {
    const { status, body } = await s.api("/api/status");
    assert.equal(status, 200);
    // The bug this fixes: the window read the dot files and presented that as the live state, so
    // an edited-but-not-restarted setting looked applied and a stale proxy looked healthy.
    assert.ok(body.configured, "there must be a configured view");
    assert.match(body.configured.configHash, /^[0-9a-f]{16}$/);
    assert.match(body.configured.codeVersion, /^[0-9a-f]{12}$/);
    assert.ok(["openai", "anthropic", "local"].includes(body.configured.provider));
    // And a separate answer for what the running proxy is, which may be none of the above.
    assert.ok(["absent", "foreign", "stale", "ours"].includes(body.proxyState),
      `unexpected proxyState ${body.proxyState}`);
    assert.ok(Array.isArray(body.appPids));
    assert.ok(body.validation && Array.isArray(body.validation.errors));
    // No secret may reach this endpoint: it is reachable from a page with the token.
    assert.ok(!JSON.stringify(body).includes("sk-"), "no key material in /api/status");
  } finally { s.stop(); }
});

test("a launch-time override is reported as an override, not as saved configuration", async () => {
  // `OPENAI_MODEL=x ./run.sh` resolves identically to a persisted value, so without this the
  // window would show a temporary override as the configuration on disk.
  const s = await boot({ OPENAI_MODEL: "gpt-from-the-environment" });
  try {
    const { body } = await s.api("/api/status");
    assert.equal(body.configured.model, "gpt-from-the-environment");
    assert.ok(body.configured.envOverrides.includes("OPENAI_MODEL"),
      `expected OPENAI_MODEL among ${JSON.stringify(body.configured.envOverrides)}`);
  } finally { s.stop(); }
});

test("a value that cannot work is refused before it is written", async () => {
  const s = await boot({ OPENAI_API_KEY: "test-not-real" });
  const before = config.readValues().OPENAI_REASONING_EFFORT.value;
  try {
    const { status, body } = await s.api("/api/config",
      { method: "POST", body: JSON.stringify({ OPENAI_REASONING_EFFORT: "extreme" }) });
    assert.equal(status, 400);
    assert.match(body.error, /cannot work/);
    assert.match(body.errors.join(" "), /REASONING_EFFORT/);
    // The file must be untouched. These files are mostly documentation and the write is a
    // surgical line replacement, so a bad value is easy to save and only shows up as a broken
    // launch later.
    assert.equal(config.readValues().OPENAI_REASONING_EFFORT.value, before,
      "a refused write must not have changed anything");
  } finally { s.stop(); }
});

test("an unrelated edit is not blocked by a pre-existing problem", async () => {
  // Validated as the DIFFERENCE against the current state. Refusing on any error in the result
  // would make the window unusable whenever the key lives in the environment at launch rather
  // than in a file: every save would be refused for a problem the user did not just create.
  const s = await boot({ OPENAI_API_KEY: "" });     // no key resolvable -> a pre-existing error
  try {
    const { status } = await s.api("/api/status");
    assert.equal(status, 200);
    // A legal value, submitted while that pre-existing error stands. Writing the value it
    // already has keeps the test from mutating the repository's own configuration.
    const current = config.readValues().OPENAI_VERBOSITY.value;
    const r = await s.api("/api/config",
      { method: "POST", body: JSON.stringify({ OPENAI_VERBOSITY: current }) });
    assert.equal(r.status, 200, `expected the write to be allowed, got ${JSON.stringify(r.body)}`);
  } finally { s.stop(); }
});

test("provenance is exposed, and a cross-provider session is flagged", async () => {
  // The inspector this phase calls for. A session's own stored `model` is what the CLIENT selected,
  // which in OpenAI mode is never what answered — so the window has to read the sidecar instead.
  const os = require("node:os");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prov-http-"));
  const base = {
    version: 1, cliSessionId: "aaaa-1111", sessionId: null, droppedEpochs: 0,
    created: { at: "2026-08-01T00:00:00Z", provider: "anthropic", resolvedModel: "claude-opus-4-8" },
    epochs: [
      { at: "2026-08-01T00:00:00Z", kind: "created", provider: "anthropic", resolvedModel: "claude-opus-4-8" },
      { at: "2026-08-02T00:00:00Z", kind: "provider-switch", provider: "openai",
        resolvedModel: "gpt-5.6-sol", wireModel: "claude-opus-4-8", apiSurface: "responses" },
    ],
  };
  fs.writeFileSync(path.join(dir, "aaaa-1111.json"), JSON.stringify(base));

  const s = await boot({ PROXY_PROVENANCE_DIR: dir });
  try {
    const { status, body } = await s.api("/api/provenance");
    assert.equal(status, 200);
    assert.equal(body.sessions.length, 1);
    const row = body.sessions[0];
    assert.equal(row.cliSessionId, "aaaa-1111");
    assert.equal(row.resolvedModel, "gpt-5.6-sol", "the model that actually answered last");
    assert.equal(row.crossProvider, true, "a session answered by both must be flagged, not flattened");
    assert.deepEqual(row.providersSeen.sort(), ["anthropic", "openai"]);
    assert.equal(row.epochs, 2);
    // Whether it matches what is configured NOW is a separate question from what answered then.
    assert.equal(typeof row.staleForCurrentProvider, "boolean");
    assert.ok(["openai", "anthropic", "local"].includes(body.configured));
    // No prompt text, and no key material, ever reaches this endpoint.
    const text = JSON.stringify(body);
    assert.ok(!text.includes("sk-"));
    assert.ok(!/messages|content|system/.test(text.replace(/\bcrossProvider\b/g, "")));
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an empty provenance store is reported as empty, not as an error", async () => {
  // Absence is not evidence of Anthropic: in Anthropic mode the proxy never runs, so nothing is
  // recorded at all. The endpoint says so rather than implying there were no turns.
  const os = require("node:os");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prov-empty-"));
  const s = await boot({ PROXY_PROVENANCE_DIR: dir });
  try {
    const { status, body } = await s.api("/api/provenance");
    assert.equal(status, 200);
    assert.deepEqual(body.sessions, []);
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
