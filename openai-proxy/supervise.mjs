#!/usr/bin/env node
// Keeps the translation proxy running.
//
// WHY. The proxy died twice in three days from the same cause: a socket read timed out, undici
// rejected its own internal fetch task with TypeError("terminated"), and Node's default
// --unhandled-rejections=throw took the process down. The Electron app, run.sh and four live
// agents all stayed up pointing at a closed port, and nothing anywhere noticed. The second time
// it sat dead for hours; when the port came back, three queued agents fired at once.
//
// The proxy now has process-level guards, so that exact crash no longer kills it. This exists
// for everything those guards deliberately do NOT catch: a genuine bug exits 1 on purpose,
// because continuing on unknown corrupt state is worse than a restart. "Restart" has to mean
// something for that to be the right trade, and until now it did not.
//
// WHAT IT IS NOT. It does not watch the config files. Restarting the moment a setting changes
// would kill whatever turn is in flight, and a turn can be minutes of work; the launcher and
// the settings window do explicit, announced restarts instead. It also does not retry forever —
// a proxy that cannot start (a bound port, a syntax error, a missing key) must fail visibly
// rather than spin, because a silent restart loop looks exactly like a hang from the app.
//
// Usage:  node supervise.mjs          (run.sh starts this instead of proxy.mjs)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, clearManifest } from "../scripts/lib/proxy-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "proxy.mjs");

// Supervisor-only knobs, read here rather than added to config.mjs on purpose: they change how
// the RUNTIME is managed, not how a request is translated, so they must not make an otherwise
// current proxy look stale to the launcher's config-hash comparison.
const num = (name, dflt) => {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const RESTART_BASE_MS   = num("PROXY_RESTART_BASE_MS", 500);
const RESTART_MAX_MS    = num("PROXY_RESTART_MAX_MS", 30_000);
// A start that survives this long is treated as healthy, which resets the backoff. Without it,
// a proxy that crashes once a day would eventually be waiting 30s to come back.
const HEALTHY_AFTER_MS  = num("PROXY_HEALTHY_AFTER_MS", 60_000);
// Consecutive fast failures tolerated before giving up. A bound port or a syntax error fails
// instantly every time, and looping on it burns CPU while presenting as a hang.
const MAX_FAST_FAILURES = num("PROXY_MAX_FAST_FAILURES", 8);

// Watchdog for the state the exit handler cannot see: alive, holding the port, not answering.
// Deliberately slow to fire — Node is single-threaded, so a genuinely busy proxy can be late to
// answer, and killing a working proxy mid-turn is a worse failure than a slow /health. Three
// consecutive misses with a 5s timeout means roughly 45 seconds of unresponsiveness.
const HEALTH_EVERY_MS   = num("PROXY_HEALTH_EVERY_MS", 15_000);
const HEALTH_TIMEOUT_MS = num("PROXY_HEALTH_TIMEOUT_MS", 5_000);
const HEALTH_MISSES     = num("PROXY_HEALTH_MISSES", 3);
const PORT              = process.env.PORT || "8123";

const log = (m) => {
  const t = new Date().toISOString().slice(5, 19).replace("T", " ");
  process.stdout.write(`[supervisor ${t}] ${m}\n`);
};

let child = null;
let stopping = false;
let fastFailures = 0;
let starts = 0;
let misses = 0;
let healthTimer = null;

function backoffMs() {
  // Exponential from the base, capped. No jitter: there is exactly one supervisor, so there is
  // no thundering herd to spread out, and a predictable delay is easier to read in a log.
  return Math.min(RESTART_BASE_MS * 2 ** Math.max(0, fastFailures - 1), RESTART_MAX_MS);
}

async function healthOnce() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`,
      { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!r.ok) return false;
    const j = await r.json();
    // Any well-formed answer counts. Comparing the instance id here would be wrong: the child
    // rewrites the manifest at each start, and a check that raced that write would kill a
    // healthy proxy for failing to prove itself.
    return j?.ok === true;
  } catch { return false; }
}

function startHealthWatch() {
  if (healthTimer || !HEALTH_EVERY_MS || !HEALTH_MISSES) return;
  healthTimer = setInterval(async () => {
    if (stopping || !child) return;
    if (await healthOnce()) { misses = 0; return; }
    misses++;
    log(`! /health did not answer within ${HEALTH_TIMEOUT_MS}ms (${misses}/${HEALTH_MISSES})`);
    if (misses < HEALTH_MISSES) return;
    misses = 0;
    log(`!! proxy is holding the port without answering — restarting pid ${child.pid}`);
    // SIGTERM first: the proxy's own handler closes the server and clears its manifest, which
    // keeps ownership records honest. SIGKILL only if it will not go.
    const doomed = child;
    try { doomed.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { if (doomed === child) doomed.kill("SIGKILL"); } catch {} }, 4000).unref?.();
  }, HEALTH_EVERY_MS);
  healthTimer.unref?.();
}

function start() {
  starts++;
  const startedAt = Date.now();
  // stdio inherited: run.sh already appends this process's output to proxy.log, so the child's
  // lines land in the same file, in order, with the supervisor's own lines interleaved. A
  // separate log would split one incident across two files.
  child = spawn(process.execPath, [CHILD], { stdio: "inherit", env: process.env });
  log(`started proxy pid ${child.pid} (start #${starts})`);
  startHealthWatch();

  child.on("exit", (code, signal) => {
    const alive = Date.now() - startedAt;
    child = null;
    misses = 0;
    if (stopping) return;

    // A manifest left behind by a process that is gone would let the launcher believe a dead
    // instance is ownable. The child clears it on SIGTERM; it cannot on a hard crash, which is
    // precisely the case that matters here.
    const m = readManifest();
    if (m && !isAlive(m.pid)) clearManifest();

    // The give-up bound is for a proxy that CANNOT START — a bound port, a bad config, a
    // syntax error. Those exit with a code, immediately, every time.
    //
    // An exit by SIGNAL is a different thing entirely: something outside decided to stop it.
    // That includes this supervisor's own watchdog, a hand `kill`, and the OOM killer. Counting
    // those toward the bound would mean eight manual restarts silently disable auto-restart —
    // so they restart on the base delay and never accumulate. Unbounded is correct here: if
    // something external keeps killing the proxy, bringing it back is exactly the job, and
    // every occurrence is logged.
    if (signal) {
      log(`proxy was killed (signal ${signal}) after ${alive}ms — restarting`);
    } else if (alive >= HEALTHY_AFTER_MS) {
      // It ran long enough to have been working, so this is a crash rather than a bad start.
      // Reset the backoff, or a proxy that crashes once a day would creep up to a 30s wait.
      fastFailures = 0;
      log(`proxy exited (code ${code}) after ${Math.round(alive / 1000)}s — restarting`);
    } else {
      fastFailures++;
      log(`proxy exited (code ${code}) after only ${alive}ms — restarting, ` +
          `fast failure ${fastFailures}/${MAX_FAST_FAILURES}`);
    }

    if (fastFailures >= MAX_FAST_FAILURES) {
      log(`!! giving up after ${fastFailures} immediate failures. The proxy cannot start — ` +
          `check the lines above this one (a bound port, a bad config, or a syntax error). ` +
          `Nothing will retry, so the app will report connection failures rather than hanging.`);
      process.exitCode = 1;
      return;
    }
    const wait = backoffMs();
    if (wait) log(`waiting ${wait}ms before the next start`);
    setTimeout(start, wait);
  });

  child.on("error", (e) => log(`! could not spawn the proxy: ${e.message}`));
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Forward a stop to the child and wait for it, so a shutdown does not leave an orphan holding
// the port — which is how the hand-restarted proxy ended up as PPID 1 with no owner.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    if (healthTimer) clearInterval(healthTimer);
    log(`received ${sig} — stopping the proxy`);
    if (!child) process.exit(0);
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    const doomed = child;
    setTimeout(() => { try { doomed.kill("SIGKILL"); } catch {} process.exit(0); }, 5000).unref?.();
    doomed.on("exit", () => process.exit(0));
  });
}

// The supervisor dying for any other reason must not orphan the proxy either.
process.on("exit", () => {
  if (child && !stopping) { try { child.kill("SIGTERM"); } catch {} }
});

start();
