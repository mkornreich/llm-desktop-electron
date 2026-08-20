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
  const [procs, runtime, cfg, prov] = await Promise.all([
    import("../scripts/lib/procs.mjs"),
    import("../scripts/lib/proxy-runtime.mjs"),
    import("../openai-proxy/config.mjs"),
    import("../scripts/lib/provenance.mjs"),
  ]);
  return (esm = { procs, runtime, cfg, prov });
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
  // one would time out and report a failure for a correct configuration. Every other mode (openai,
  // local, openrouter) runs the proxy and MUST be verified — the old `!== "openai"` check wrongly
  // skipped verification for local and openrouter.
  if (cfg.provider() === "anthropic")
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

// The settings window is a plain browser page, so there is no close event to listen for. The page
// heartbeats every couple of seconds; when the beats stop — window closed, tab closed, browser
// quit — the server shuts itself down rather than lingering as an orphan on 127.0.0.1. A request in
// flight (a relaunch can take ~a minute) blocks shutdown, and the boot grace covers a browser that
// is still cold-starting and has not sent its first beat yet.
let activeRequests = 0, seenBeat = false, lastBeat = 0;
let closeAt = 0;   // set by an unload beacon; a later heartbeat clears it, so a reload is not a close
const startedAt = Date.now();
const BOOT_GRACE_MS  = parseInt(process.env.SETTINGS_BOOT_GRACE_MS  || "120000", 10);
const IDLE_GRACE_MS  = parseInt(process.env.SETTINGS_IDLE_GRACE_MS  || "6000", 10);
const CLOSE_GRACE_MS = parseInt(process.env.SETTINGS_CLOSE_GRACE_MS || "2500", 10);

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    if (!authorized(req, url)) return send(res, 403, "Missing or bad token. Launch with ./settings.sh", "text/plain");
    let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    html = html.replace("__SETTINGS_TOKEN__", TOKEN);
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
  if (!authorized(req, url)) return send(res, 403, { error: "bad token" });

  // Window liveness. The page pings /api/heartbeat; the unload beacon hits /api/close for a faster
  // exit. Both are deliberately trivial and require the token like every other /api route.
  if (url.pathname === "/api/heartbeat") { seenBeat = true; lastBeat = Date.now(); closeAt = 0; return send(res, 200, { ok: true }); }
  if (url.pathname === "/api/close") { closeAt = Date.now(); return send(res, 200, { ok: true }); }

  try {
    if (url.pathname === "/api/config" && req.method === "GET")
      return send(res, 200, { schema: config.SCHEMA, values: config.readValues(), root: config.ROOT,
                              localModel: config.readFile(".local-model").values });

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
      return send(res, 200, { written, values: config.readValues(),
                              localModel: config.readFile(".local-model").values });
    }

    // Installed Ollama models, for the local model picker. Unioned across the managed side port
    // and the system Ollama on 11434 (they share a models dir). Empty when no Ollama is running.
    //
    // The picker only offers models the current config can actually RUN. When thinking is on — the
    // default (OPENAI_SHOW_THINKING=1) — the proxy asks the model to think on every turn, and Ollama
    // 400s a model without the "thinking" capability (`<model> does not support thinking`). So with
    // thinking on, non-thinking models are filtered out rather than left selectable to fail at
    // runtime; with thinking explicitly off, every installed model is offered.
    if (url.pathname === "/api/ollama-models" && req.method === "GET") {
      const localVals = config.readFile(".local-model").values;
      const managed = parseInt(localVals.OLLAMA_MANAGED_PORT || "11435", 10) || 11435;
      const ports = [...new Set([managed, 11434])];
      // OPENAI_SHOW_THINKING may live in either file; default (unset) is ON, matching the proxy.
      const showThinkingRaw = localVals.OPENAI_SHOW_THINKING ?? config.readFile(".openai-model").values.OPENAI_SHOW_THINKING;
      const requireThinking = showThinkingRaw === undefined
        ? true : !/^(0|false|off|no)$/i.test(String(showThinkingRaw).trim());

      // name -> the first port serving it; capabilities are identical wherever a model is served.
      const port = new Map();
      for (const p of ports) {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/api/tags`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) for (const m of ((await r.json()).models || [])) if (m && m.name && !port.has(m.name)) port.set(m.name, p);
        } catch { /* that Ollama instance is not up */ }
      }
      // Ask each model for its capabilities AND its maximum context. /api/show returns capabilities
      // (["completion","tools","thinking"]) plus model_info carrying "<arch>.context_length" — the
      // model's max supported context, which the picker snaps the context field to on model change.
      const capabilities = {};
      const maxContext = {};
      await Promise.all([...port].map(async ([name, p]) => {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/api/show`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(2500),
          });
          if (r.ok) {
            const j = await r.json();
            capabilities[name] = j.capabilities || [];
            const info = j.model_info || {};
            const ck = Object.keys(info).find((k) => /(^|\.)context_length$/.test(k));
            if (ck && Number.isFinite(info[ck])) maxContext[name] = info[ck];
          }
        } catch { /* leave undefined -> not-thinking / unknown max */ }
      }));

      const all = [...port.keys()].sort();
      const canThink = (n) => Array.isArray(capabilities[n]) && capabilities[n].includes("thinking");
      const models = (requireThinking ? all.filter(canThink) : all);
      return send(res, 200, { models, all, capabilities, maxContext, requireThinking, ports });
    }

    // Tool-capable OpenRouter models, for the openrouter picker. Fetches the public models catalog
    // (no auth), keeps models whose supported_parameters include "tools" (the agent is tool calls
    // end to end), and flags the free ones (pricing.prompt and .completion both "0"). Free models
    // are heavily rate-limited and need data-sharing enabled at openrouter.ai/settings/privacy — the
    // picker help says so. On any network error it returns empty and the field falls back to text.
    if (url.pathname === "/api/openrouter-models" && req.method === "GET") {
      let models = [];
      try {
        const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          models = ((await r.json()).data || [])
            .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
            .map((m) => ({
              id: m.id,
              name: m.name || m.id,
              free: !!(m.pricing && m.pricing.prompt === "0" && m.pricing.completion === "0"),
              context: m.context_length || null,
            }))
            // Free first, then alphabetical — the free ones are what the picker is mostly for.
            .sort((a, b) => (a.free === b.free ? a.id.localeCompare(b.id) : a.free ? -1 : 1));
        }
      } catch { /* OpenRouter unreachable -> empty; the field falls back to a text input */ }
      return send(res, 200, { models });
    }

    if (url.pathname === "/api/status" && req.method === "GET")
      return send(res, 200, await status());

    // Which model actually answered each session. The session store is shared with the real Claude
    // Desktop, so this comes from a repo-owned sidecar rather than from the session files — see
    // scripts/lib/provenance.mjs. This is the inspector the phase calls for; a sidebar badge would
    // need a version-gated patch into the app's own UI, which adding JSON fields does not achieve.
    if (url.pathname === "/api/provenance" && req.method === "GET") {
      const { prov, cfg } = await mods();
      const configured = cfg.provider();
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 500);
      const sessions = prov.list({ limit }).map((s) => ({
        ...s,
        // A session answered by one provider and resumed under another is the case a single
        // "current provider" field would have erased. Resuming it also carries a persisted model id
        // that is meaningless under the new provider, and nothing else says so.
        crossProvider: s.providersSeen.length > 1,
        staleForCurrentProvider: !!s.provider && s.provider !== configured,
      }));
      return send(res, 200, {
        configured,
        sessions,
        // Absence is not evidence of Anthropic. In Anthropic mode the proxy never runs, so nothing
        // records anything — saying so is the difference between "no record" and "no OpenAI turns".
        note: configured === "anthropic"
          ? "The agent is set to Anthropic, so no proxy is running and nothing new is being recorded. " +
            "Sessions below are historical."
          : null,
      });
    }

    if (url.pathname === "/api/relaunch" && req.method === "POST")
      return send(res, 200, await relaunch());
    return send(res, 404, { error: "no route" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  activeRequests++;
  try { await handle(req, res); }
  finally { activeRequests--; }
});

function shutdown(why) {
  console.log(`[settings] ${why}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();   // force it if a keep-alive socket lingers
}

// One watchdog tick. unref() so it never keeps the process alive on its own — the http server does
// that, and the moment the server is the only thing left running we want to be free to exit.
setInterval(() => {
  if (activeRequests > 0) return;                    // don't cut off an in-flight request or relaunch
  const now = Date.now();
  if (!seenBeat) { if (now - startedAt > BOOT_GRACE_MS) shutdown("the window never opened"); return; }
  if (closeAt && now - closeAt > CLOSE_GRACE_MS) return shutdown("the settings window was closed");
  if (now - lastBeat > IDLE_GRACE_MS) shutdown("the settings window went away");
}, 1500).unref();

server.listen(PORT, "127.0.0.1", () => {
  // stdout is consumed by settings.sh, which opens this URL.
  console.log(`http://127.0.0.1:${PORT}/?t=${TOKEN}`);
});
