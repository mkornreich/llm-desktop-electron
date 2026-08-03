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
const { execFile, spawn } = require("node:child_process");
const config = require("./config.js");

const PORT = parseInt(process.env.SETTINGS_PORT || "8765", 10);
const PROXY = "http://127.0.0.1:8123";
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

async function status() {
  const out = { proxy: null, usage: null, appRunning: false };
  for (const [key, ep] of [["proxy", "/health"], ["usage", "/usage"]]) {
    try {
      const r = await fetch(PROXY + ep, { signal: AbortSignal.timeout(1200) });
      if (r.ok) out[key] = await r.json();
    } catch { /* proxy is legitimately absent in anthropic mode */ }
  }
  out.appRunning = await new Promise((res) =>
    execFile("pgrep", ["-f", "llm-desktop-electron/user-data"], (e, so) => res(!e && so.trim().length > 0)));
  return out;
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
      const written = config.writeValues(updates);
      return send(res, 200, { written, values: config.readValues() });
    }

    if (url.pathname === "/api/status" && req.method === "GET")
      return send(res, 200, await status());

    if (url.pathname === "/api/relaunch" && req.method === "POST") {
      await new Promise((r) => execFile("pkill", ["-f", "llm-desktop-electron/user-data"], () => r()));
      await new Promise((r) => setTimeout(r, 1500));
      const child = spawn("./run.sh", [], { cwd: config.ROOT, detached: true, stdio: "ignore" });
      child.unref();
      return send(res, 200, { started: true });
    }
    return send(res, 404, { error: "no route" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // stdout is consumed by settings.sh, which opens this URL.
  console.log(`http://127.0.0.1:${PORT}/?t=${TOKEN}`);
});
