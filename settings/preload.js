// The renderer's entire capability surface. Nothing else is exposed.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settings", {
  read:     ()        => ipcRenderer.invoke("config:read"),
  write:    (updates) => ipcRenderer.invoke("config:write", updates),
  status:   ()        => ipcRenderer.invoke("status:get"),
  relaunch: ()        => ipcRenderer.invoke("app:relaunch"),
  reveal:   (file)    => ipcRenderer.invoke("shell:reveal", file),
});
