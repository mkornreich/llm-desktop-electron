// Settings server for this build: serves the settings window and edits the launcher's dot
// files. Zero dependencies, bound to 127.0.0.1.
//
// Why not an Electron window? run.sh symlinks
//   node_modules/electron/dist/Electron.app/Contents/Resources/app.asar -> app/
// because several of the app's worker paths resolve through <resourcesPath>/app.asar. That
// symlink makes Electron load ANTHROPIC's app and ignore any CLI app path — verified with
// both `electron settings` and `electron --app=settings`, which both booted
// appVersion 1.24012.9. Giving the settings window its own Electron would mean a second
// ~200 MB runtime, and patching a window into Anthropic's bundle would have to be redone on
// every re-extraction. A local page avoids both.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
// No execFile: the pgrep/pkill calls it existed for are gone, replaced by the process-list
// ownership checks in scripts/lib/.
const { spawn } = require("node:child_process");
const config = require("./config.js");

const PORT = parseInt(process.env.SETTINGS_PORT || "8765", 10);
// The proxy's port is a setting, not a constant. It was hard-coded here, so running the proxy on
// any other port made this window report it permanently absent.
const PROXY_PORT = parseInt(process.env.PORT || "8123", 10);
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
// A per-start token. Without it any web page you visit could POST to 127.0.0.1:8765 and
// rewrite your config or restart the app — localhost is not an authentication boundary.
const TOKEN = crypto.randomBytes(16).toString("hex");

const send = (res, code, body, type = "application/json") => {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
};

function authorized(req, url) {
  if (url.searchParams.get("t") === TOKEN) return true;
  if (req.headers["x-settings-token"] === TOKEN) return true;
  return false;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1e6) throw new Error("payload too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// The proxy modules are ESM and this server is CJS, so they load through dynamic import. Cached
// because `import()` of the same specifier is memoised anyway and this keeps the call sites flat.
let esm = null;
async function mods() {
  if (esm) return esm;
  const [procs, runtime, cfg] = await Promise.all([
    import("../scripts/lib/procs.mjs"),
    import("../scripts/lib/proxy-runtime.mjs"),
    import("../openai-proxy/config.mjs"),
  ]);
  return (esm = { procs, runtime, cfg });
}

// Processes belonging to THIS build's app. Chromium spawns a main process plus a renderer, a GPU
// process, utility processes and a crashpad handler; every one of them carries the same
// --user-data-dir on its command line, and all but the main process carry a --type= flag. Only
// the main process may be signalled — SIGTERM to a renderer is either ignored or produces a
// crash report, and neither stops the app.
//
// This is also why `pgrep`/`pkill -f` had to go. `pkill -f llm-desktop-electron/user-data` will
// match anything that merely MENTIONS that path: a grep, an editor, another agent's shell, this
// very server. It is a substring pattern, not an identity. And `pgrep` cannot see the app's main
// process on macOS at all, which is documented at length in scripts/lib/procs.mjs.
async function repoAppPids() {
  const { procs } = await mods();
  const needle = procs.buildApp(config.ROOT);
  return procs.processList()
    .filter(([pid, argv]) =>
      pid !== process.pid && argv.includes(needle) &&
      !argv.includes("--type=") && !argv.includes("crashpad"))
    .map(([pid]) => pid);
}

// Which errors a proposed write would INTRODUCE. Writes are surgical line replacements into
// files that are mostly documentation, so a value that cannot work is easy to save and hard to
// notice: nothing complains until the next launch, and the symptom shows up somewhere else
// entirely. Checked before the write, and reported as the difference against the current state so
// a pre-existing problem does not block an unrelated edit.
async function wouldBreak(updates) {
  const { cfg } = await mods();
  const env = { ...process.env, PORT: String(PROXY_PORT) };
  const before = new Set(cfg.validate({ resolved: cfg.resolve({ env }) }).errors);

  // The prospective state: the project file's current values with the updates applied. Only
  // .openai-model and .provider feed the proxy's configuration; .privacy and .sync do not.
  const project = { ...config.readFile(".openai-model").values };
  for (const [k, v] of Object.entries(updates)) {
    const item = config.SCHEMA.find((s) => s.key === k);
    if (item?.file === ".openai-model") project[k] = String(v);
  }
  const after = cfg.validate({ resolved: cfg.resolve({ env, project }) }).errors;
  return after.filter((e) => !before.has(e));
}

async function status() {
  const { runtime, cfg } = await mods();
  const out = { proxy: null, usage: null, appRunning: false };
  for (const [key, ep] of [["proxy", "/health"], ["usage", "/usage"]]) {
    try {
      const r = await fetch(PROXY + ep, { signal: AbortSignal.timeout(1200) });
      if (r.ok) out[key] = await r.json();
    } catch { /* proxy is legitimately absent in anthropic mode */ }
  }
  const pids = await repoAppPids();
  out.appRunning = pids.length > 0;
  out.appPids = pids;

  // CONFIGURED versus ACTIVE. These were conflated: the window read the dot files and showed the
  // result as the current state, so an edited-but-not-relaunched setting looked live, and a
  // one-launch `OPENAI_MODEL=x ./run.sh` override was invisible. They are now separate fields,
  // and `proxyState` says which of the two the running process actually reflects.
  // Resolved through the port this window is actually watching, not the ambient environment. The
  // port is part of the config hash, so resolving it differently from the running proxy makes
  // every comparison report "stale" — which is how a launcher can end up restarting a healthy
  // proxy forever. Same rule as ensure-proxy.mjs: hash the environment the process has.
  const resolved = cfg.resolve({ env: { ...process.env, PORT: String(PROXY_PORT) } });
  out.configured = {
    provider: cfg.provider(),
    configHash: cfg.configHash({ resolved }),
    codeVersion: cfg.codeVersion(),
    model: resolved.values.OPENAI_MODEL,
    api: resolved.values.OPENAI_API,
    // Settings whose value came from the environment rather than from a file. Persisting nothing
    // and overriding at launch resolves identically, so without this the window would report a
    // temporary override as the saved configuration.
    envOverrides: Object.entries(resolved.sources).filter(([, s]) => s === "env").map(([k]) => k),
  };
  const probe = await runtime.probe({
    port: PROXY_PORT,
    configHash: out.configured.configHash,
    codeVersion: out.configured.codeVersion,
  });
  out.proxyState = probe.state;              // absent | foreign | stale | ours
  out.proxyStateReason = probe.reason;
  out.validation = cfg.validate({ resolved });
  return out;
}

// A real restart, in the order the state requires.
//
// The old version was `pkill -f`, sleep 1500ms, spawn ./run.sh, report `{started: true}` — which
// reported success before anything had started, matched processes by substring, left the proxy
// alone entirely (so a model change did not take effect), and raced the LevelDB lock the app
// holds on its session store.
//
// Order matters and is not arbitrary:
//   1. Stop the APP first. It holds an exclusive LevelDB lock on the session store; starting a
//      new one before the old exits produces a NotOpenError, and killing it mid-write is how a
//      profile gets corrupted.
//   2. Wait for it to actually be gone, rather than sleeping a hopeful interval.
//   3. Stop the proxy only if it is provably OURS. A foreign listener is reported, never killed.
//   4. Wait for the port to be released before anything tries to bind it.
//   5. Launch, then verify the new proxy reports the config hash we expect. Reporting success
//      without that check is what let "restarted" mean "the old settings are still running".
async function relaunch() {
  const { runtime, cfg } = await mods();
  const steps = [];
  const resolved = cfg.resolve({ env: { ...process.env, PORT: String(PROXY_PORT) } });
  const wantConfig = cfg.configHash({ resolved });
  const wantCode = cfg.codeVersion();

  // In-flight work, reported so the window can say what a restart would interrupt. A turn can be
  // minutes of real work, and the previous behaviour discarded it without a word.
  let inflight = 0;
  try {
    const r = await fetch(PROXY + "/health", { signal: AbortSignal.timeout(1200) });
    if (r.ok) inflight = (await r.json()).inflight || 0;
  } catch { /* nothing running */ }
  if (inflight) steps.push(`interrupting ${inflight} request(s) in flight`);

  const pids = await repoAppPids();
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); steps.push(`stopped the app (pid ${pid})`); }
    catch (e) { steps.push(`could not signal the app (pid ${pid}): ${e.message}`); }
  }
  // Wait for the app to release its lock. Bounded: a wedged app must not hang the restart, but
  // relaunching over a live one is worse than reporting the problem.
  const appDeadline = Date.now() + 15000;
  while (Date.now() < appDeadline && (await repoAppPids()).length)
    await new Promise((r) => setTimeout(r, 250));
  const stillUp = await repoAppPids();
  if (stillUp.length)
    return { started: false, steps,
             error: `the app is still running (pid ${stillUp.join(", ")}) after 15s. ` +
                    `Quit it manually — relaunching over a live app can corrupt the session store.` };
  steps.push("the app has exited and released the session store");

  const probe = await runtime.probe({ port: PROXY_PORT, configHash: wantConfig, codeVersion: wantCode });
  if (probe.state === "foreign")
    return { started: false, steps,
             error: `port ${PROXY_PORT} is held by a process that is not this repository's proxy ` +
                    `(${probe.reason}). It will not be stopped.` };
  if (probe.state !== "absent") {
    const stop = await runtime.stopOwned(probe.manifest || runtime.readManifest());
    steps.push(stop.stopped ? `stopped the proxy (${stop.reason})`
                            : `left the proxy running (${stop.reason})`);
    if (stop.stopped && !(await runtime.waitForPortFree(PROXY_PORT)))
      return { started: false, steps, error: `port ${PROXY_PORT} is still accepting connections` };
  }

  const child = spawn("./run.sh", [], { cwd: config.ROOT, detached: true, stdio: "ignore" });
  child.unref();
  steps.push("launched ./run.sh");

  // In Anthropic mode there is deliberately no proxy, so there is nothing to verify. Waiting for
  // one would time out and report a failure for a correct configuration.
  if (cfg.provider() !== "openai")
    return { started: true, steps, provider: cfg.provider(), verified: "no proxy in anthropic mode" };

  const deadline = Date.now() + 40000;
  let last = null;
  while (Date.now() < deadline) {
    last = await runtime.probe({ port: PROXY_PORT, configHash: wantConfig, codeVersion: wantCode });
    if (last.state === "ours")
      return { started: true, steps, verified: wantConfig,
               instance: last.health.instance, pid: last.health.pid, model: last.health.model };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { started: true, steps, verified: false,
           error: `the app was launched, but no proxy is serving config ${wantConfig} ` +
                  `(${last?.state}: ${last?.reason}). See openai-proxy/proxy.log.` };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    if (!authorized(req, url)) return send(res, 403, "Missing or bad token. Launch with ./settings.sh", "text/plain");
    let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    html = html.replace("__SETTINGS_TOKEN__", TOKEN);
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
  if (!authorized(req, url)) return send(res, 403, { error: "bad token" });

  try {
    if (url.pathname === "/api/config" && req.method === "GET")
      return send(res, 200, { schema: config.SCHEMA, values: config.readValues(), root: config.ROOT });

    if (url.pathname === "/api/config" && req.method === "POST") {
      const updates = await readJson(req);
      const bad = await wouldBreak(updates);
      // Only NEW errors block the write. Validating the whole result and refusing on any error
      // would make the window unusable in the perfectly normal case where the key lives in the
      // environment at launch rather than in a file: every save would be refused for a problem
      // the user did not just create and cannot fix here.
      if (bad.length)
        return send(res, 400, { error: `These values cannot work: ${bad.join("; ")}`, errors: bad });
      const written = config.writeValues(updates);
      return send(res, 200, { written, values: config.readValues() });
    }

    if (url.pathname === "/api/status" && req.method === "GET")
      return send(res, 200, await status());

    if (url.pathname === "/api/relaunch" && req.method === "POST")
      return send(res, 200, await relaunch());
    return send(res, 404, { error: "no route" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // stdout is consumed by settings.sh, which opens this URL.
  console.log(`http://127.0.0.1:${PORT}/?t=${TOKEN}`);
});
