#!/usr/bin/env node
// Discover the on-device Ollama *thinking* models, for the Code-tab model dropdown.
//
// The dropdown is populated from the app bootstrap (the renderer-unlock preload injects a model
// list), NOT from the proxy's /v1/models — and that preload is sandboxed and cannot fetch a live
// list itself (localhost is blocked by claude.ai's CORS/CSP). So run.sh runs THIS at launch, and
// passes the result to the page through the preload via an environment variable (LLMD_LOCAL_MODELS)
// plus the reachable Ollama base (LLMD_LOCAL_BASE), which the proxy uses to route a `local:<model>`
// pick (resolvePickedProvider).
//
// Only THINKING models are offered: the proxy asks the model to think on every turn by default and
// Ollama 400s a model without the "thinking" capability. This mirrors settings/server.js's
// /api/ollama-models filter (capabilities from /api/show include "thinking").
//
// Output on success: two lines on stdout —
//   line 1: the Ollama /v1 base URL to route local picks to (http://127.0.0.1:<port>/v1)
//   line 2: a JSON array of thinking model names, e.g. ["qwen3:8b","gpt-oss:20b"]
// Prints nothing (exit 0) when no Ollama is reachable or no thinking model is installed.

const managed = parseInt(process.env.OLLAMA_MANAGED_PORT || "11435", 10) || 11435;
const ports = [...new Set([managed, 11434])];   // managed instance first, then the system Ollama

// name -> the first port serving it (capabilities are identical wherever a model is served).
const port = new Map();
for (const p of ports) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) for (const m of ((await r.json()).models || [])) if (m && m.name && !port.has(m.name)) port.set(m.name, p);
  } catch { /* that Ollama instance is not up */ }
}
if (!port.size) process.exit(0);

// Ask each model whether it supports thinking (/api/show -> capabilities).
const canThink = new Map();
await Promise.all([...port].map(async ([name, p]) => {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/show`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(2500),
    });
    if (r.ok) {
      const caps = (await r.json()).capabilities;
      canThink.set(name, Array.isArray(caps) && caps.includes("thinking"));
    }
  } catch { /* leave undefined -> treated as non-thinking */ }
}));

const models = [...port.keys()].filter((n) => canThink.get(n)).sort();
if (!models.length) process.exit(0);

// Route local picks to the first probed port (managed preferred) that serves a thinking model —
// managed carries the big context run.sh sized, and both ports share a models dir.
const basePort = ports.find((p) => models.some((n) => port.get(n) === p)) ?? ports[0];
process.stdout.write(`http://127.0.0.1:${basePort}/v1\n`);
process.stdout.write(JSON.stringify(models) + "\n");
