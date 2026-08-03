// Settings window for this build — a standalone Electron app, deliberately NOT a patch
// into Anthropic's bundle. Patching their renderer to add a window would mean re-doing it
// on every asar re-extraction and would fight the IPC origin validation; a separate window
// that edits the dot files has neither problem and works in both provider modes.
"use strict";
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const config = require("./config.js");

const PROXY = "http://127.0.0.1:8123";

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 900,
    minWidth: 620,
    title: "LLM Desktop — Settings",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,     // renderer gets only what preload exposes
      nodeIntegration: false,
      sandbox: false,             // preload needs require() for the config module
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  return win;
}

// ---- IPC: the whole surface the renderer gets ----

ipcMain.handle("config:read", () => ({
  schema: config.SCHEMA,
  values: config.readValues(),
  root: config.ROOT,
}));

ipcMain.handle("config:write", (_e, updates) => {
  if (!updates || typeof updates !== "object") throw new Error("bad payload");
  const written = config.writeValues(updates);
  return { written, values: config.readValues() };
});

// Live status, so the window shows what is actually running rather than what is configured.
ipcMain.handle("status:get", async () => {
  const out = { proxy: null, usage: null, appRunning: false };
  try {
    const r = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(1200) });
    if (r.ok) out.proxy = await r.json();
  } catch { /* not running — that is a normal state in anthropic mode */ }
  try {
    const r = await fetch(`${PROXY}/usage`, { signal: AbortSignal.timeout(1200) });
    if (r.ok) out.usage = await r.json();
  } catch { /* ditto */ }
  out.appRunning = await new Promise((res) =>
    execFile("pgrep", ["-f", "llm-desktop-electron/user-data"], (err, stdout) =>
      res(!err && stdout.trim().length > 0)));
  return out;
});

// Most settings are read at launch, so offer to apply them the only way that works.
ipcMain.handle("app:relaunch", async () => {
  await new Promise((res) => execFile("pkill", ["-f", "llm-desktop-electron/user-data"], () => res()));
  await new Promise((r) => setTimeout(r, 1500));
  const child = spawn("./run.sh", [], { cwd: config.ROOT, detached: true, stdio: "ignore" });
  child.unref();
  return { started: true };
});

ipcMain.handle("shell:reveal", (_e, file) => {
  shell.showItemInFolder(config.filePath(file));
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
