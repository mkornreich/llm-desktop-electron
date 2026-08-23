// Settings window for this build — a standalone Electron app that embeds the settings server
// (settings/server.js) and points a native BrowserWindow at it. Deliberately NOT a patch into
// Anthropic's renderer bundle (that would have to be redone on every asar re-extraction and fight
// the IPC origin validation), and deliberately reusing the server rather than re-implementing its
// logic — the careful relaunch ordering, proxy-state probing, write validation, and the live
// model-choice/provenance endpoints — over IPC. One implementation, one set of tests. The server
// binds an ephemeral loopback port guarded by a one-time token, so nothing else can reach it.
//
// It runs on the SAME Electron binary the app uses, via a shadow dist (settings/.electron-runtime)
// whose resources/ has no app.asar symlink — so `electron settings/` loads THIS app instead of
// Anthropic's bundle. settings.sh builds that shadow and launches this.
"use strict";
const { app, BrowserWindow, shell } = require("electron");

// Ephemeral port unless a caller pins one: the embedded instance must never collide with a
// standalone `node settings/server.js` on 8765. Set before requiring the server, which reads it at load.
process.env.SETTINGS_PORT = process.env.SETTINGS_PORT || "0";
const server = require("./server.js");

let info = null;   // { url, token, port, close } from server.start()
let win = null;    // held at module scope so the window is not garbage-collected (which would close it)

async function createWindow() {
  // Electron owns the window lifecycle, so the server's heartbeat watchdog (which self-shuts a
  // browser-hosted page) stays off; window-all-closed closes the server instead.
  if (!info) info = await server.start({ watchdog: false });
  win = new BrowserWindow({
    width: 920,
    height: 940,
    minWidth: 620,
    title: "LLM Desktop — Settings",
    backgroundColor: "#0f0f0f",       // the page is dark-themed; avoid a white first paint
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(info.url);
  console.log(`[settings] serving on ${info.url}`);   // -> settings/electron.log (gitignored)
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.error(`[settings] load failed ${code} ${desc} ${url}`));
  win.webContents.on("render-process-gone", (_e, d) =>
    console.error(`[settings] renderer gone: ${d.reason}`));
  win.on("closed", () => { win = null; });
  // Outbound links (e.g. the OpenRouter privacy page the picker points to) open in the real
  // browser, never as a new window inside the settings app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  return win;
}

app.whenReady().then(createWindow).catch((e) => {
  console.error(`[settings] could not start: ${e.message}`);
  app.exit(1);
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", async () => {
  try { await info?.close(); } catch { /* already down */ }
  app.quit();
});
