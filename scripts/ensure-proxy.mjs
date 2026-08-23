#!/usr/bin/env node
// Make sure the proxy that is running is the one the configuration on disk describes.
//
// This replaces run.sh's old test, which was `curl -sf /health` — "something answered, good
// enough". It was not good enough three separate ways:
//
//   * A configuration change did not take effect. The old proxy answered /health, so the
//     launcher reused it and printed "proxy healthy" while serving the previous model. There
//     was no way to notice from outside the process.
//   * A foreign server on the port was indistinguishable from ours, so the only options were to
//     trust it or to kill it. `pkill -f` chose the second, matching any process whose command
//     line merely mentioned the path.
//   * A proxy that had crashed left the port free, and a hand-started replacement ran with
//     PPID 1 — unownable, so the next launch could neither reuse nor replace it safely.
//
// Now the decision is made from evidence: an instance nonce proves identity, a config hash
// proves equivalence, and a code hash catches a proxy running older translation logic. Exit
// status is what run.sh reads: 0 means a correct proxy is serving, non-zero means it is not and
// the launcher must not pretend otherwise.
//
// Usage:  node scripts/ensure-proxy.mjs [--port N]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configHash, codeVersion, resolve, validate, snapshot } from "../openai-proxy/config.mjs";
import { probe, stopOwned, stopSupervisor, waitForPortFree, readManifest, listenerPid,
         pidIsOurProxy, pidIsOurSupervisor, parentPid, REPO } from "./lib/proxy-runtime.mjs";

const LOG = path.join(REPO, "openai-proxy", "proxy.log");
const SUPERVISOR = path.join(REPO, "openai-proxy", "supervise.mjs");
const LOG_MAX = 8 * 1024 * 1024;

const say = (m) => process.stdout.write(`[proxy-check] ${m}\n`);

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i > 0 ? process.argv[i + 1] : null;
})();

// The port has to be decided BEFORE the config is resolved, and then the config has to be
// resolved through the exact environment the child will receive.
//
// Getting this wrong is not theoretical — it was the first thing the end-to-end check caught.
// Resolving with the ambient environment while spawning the child with PORT overridden makes the
// two processes resolve DIFFERENT configurations, so the launcher computes one hash, the proxy
// reports another, and every probe says "stale" forever: the launcher stops a perfectly good
// proxy, starts another, declares it stale too, and reports failure. It only worked at all
// because the default port happens to make both sides agree.
//
// The rule this encodes: a config hash is a claim about what a specific process will resolve, so
// it must be computed from that process's environment and nothing else.
const port = argPort || process.env.PORT || String(resolve().values.PORT);
// run.sh passes --restart so every launch brings up a FRESH proxy on the current code and config,
// instead of reusing whatever is on the port. Reuse is what let a stale (or, after a manifest got
// overwritten, an untracked) proxy keep serving the previous settings. Other callers and the tests
// omit the flag and keep the reuse-if-current behaviour. Also honoured via LLMD_PROXY_RESTART=1.
const RESTART = process.argv.includes("--restart") || process.env.LLMD_PROXY_RESTART === "1";
const childEnv = { ...process.env, PORT: port };
const resolved = resolve({ env: childEnv });
const wantConfig = configHash({ resolved });
const wantCode = codeVersion();

// APPEND, and rotate at 8MB. This used to be `> proxy.log`, which truncated on every launch —
// so by the time a bug was reported the evidence for it was already gone.
function rotateLog() {
  try {
    if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, `${LOG}.1`);
  } catch { /* no log yet */ }
}

function startSupervisor() {
  rotateLog();
  const fd = fs.openSync(LOG, "a");
  // Detached with the log as stdout/stderr: the supervisor must outlive this process and the
  // launcher shell, and its lines have to interleave with the proxy's own in one file. Splitting
  // them across two logs would split every incident in half.
  const child = spawn(process.execPath, [SUPERVISOR], {
    cwd: path.join(REPO, "openai-proxy"),
    env: childEnv,               // the same environment the hash above was computed from
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

// Wait for a proxy that is not merely alive but is the one we asked for.
async function waitForOurs({ timeoutMs = 25000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const p = await probe({ port, configHash: wantConfig, codeVersion: wantCode });
    if (p.state === "ours") return p;
    // A foreign occupant will not become ours by waiting, and neither will a proxy that keeps
    // reporting a different config — that means it is reading different settings than we are.
    if (p.state === "foreign" && p.health) return p;
    last = p;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last || { state: "absent", reason: "timed out waiting for the proxy to come up" };
}

async function main() {
  // Say what is being enforced before enforcing it, so the log explains its own decisions.
  const snap = snapshot({ resolved });
  say(`want config ${wantConfig} code ${wantCode} on port ${port} ` +
      `(model ${resolved.values.OPENAI_MODEL}, api ${resolved.values.OPENAI_API})`);

  const { errors, warnings } = validate({ resolved });
  for (const w of warnings) say(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) say(`error: ${e}`);
    // A config that cannot work must fail HERE, before the app launches. Starting the app first
    // and failing later is what produced "the app is up and every turn errors".
    say("refusing to start the proxy with a configuration that cannot work");
    return 1;
  }

  const found = await probe({ port, configHash: wantConfig, codeVersion: wantCode });

  // Reuse a correct proxy UNLESS a restart was requested (run.sh always requests one).
  if (found.state === "ours" && !RESTART) {
    say(`reusing the running proxy: instance ${found.health.instance} pid ${found.health.pid}`);
    return 0;
  }

  // Free the port before starting fresh. The port may be signalled ONLY when a process that
  // provably runs THIS repository's proxy.mjs holds it — pidIsOurProxy inspects the argv, not a
  // command-line substring. That authorises stopping a proxy we track by nonce (ours / stale) AND
  // one whose manifest we no longer have (foreign-by-nonce: a prior session, or a manifest another
  // checkout overwrote — exactly the "instance id we did not issue" case). A genuinely foreign,
  // NON-proxy listener still fails the argv check and is never touched: the original guarantee holds.
  if (found.state !== "absent") {
    // ours / stale are identified by the manifest pid; a foreign occupant by whoever holds the port.
    const proxyPid = found.state === "foreign" ? listenerPid(port) : (found.manifest || readManifest())?.pid;
    if (!proxyPid || !pidIsOurProxy(proxyPid)) {
      // The one case where the right move is to do nothing. Killing an unidentified listener to free
      // a port is how you take down someone else's work.
      say(`ERROR: port ${port} is held by a process that is not this repository's proxy ` +
          `(${found.reason}).`);
      say(`It will NOT be stopped. Free the port, or set PORT to something else and relaunch.`);
      return 1;
    }
    // Stop the SUPERVISOR (the proxy's parent), not just the proxy child. A managed proxy is spawned
    // by supervise.mjs, which respawns it on any exit — so killing only the child leaves the old
    // supervisor to bring up a replacement (with its OWN, previous-launch environment) that then
    // races the fresh proxy for the port. Signalling the supervisor makes it stop its child and exit
    // without respawning. A proxy with no supervisor of ours (hand-started, or its supervisor already
    // gone) is stopped directly. Both stops verify the argv before signalling, so nothing foreign is hit.
    const supPid = parentPid(proxyPid);
    const viaSupervisor = supPid && pidIsOurSupervisor(supPid);
    const label = found.state === "stale" ? `the running proxy is stale — ${found.reason}; restarting`
      : found.state === "foreign" ? `restarting an untracked proxy on port ${port} (${found.reason})`
      : `restarting the running proxy`;
    say(viaSupervisor ? `${label} (supervisor pid ${supPid}, proxy pid ${proxyPid})`
                      : `${label} (proxy pid ${proxyPid}; no supervisor of ours)`);
    const stop = viaSupervisor ? await stopSupervisor(supPid) : await stopOwned({ pid: proxyPid });
    if (!stop.stopped) {
      say(`ERROR: could not stop the proxy (${stop.reason})`);
      return 1;
    }
    say(`stopped the proxy (${stop.reason})`);
    // Binding before the old listener lets go yields EADDRINUSE, which the launcher would then
    // report as a startup failure when it is really a race.
    if (!(await waitForPortFree(port))) {
      say(`ERROR: port ${port} is still accepting connections after the proxy was stopped`);
      return 1;
    }
  }

  const pid = startSupervisor();
  say(`started the supervisor (pid ${pid}); it will restart the proxy if it dies`);

  const up = await waitForOurs();
  if (up.state === "ours") {
    say(`proxy healthy: instance ${up.health.instance} pid ${up.health.pid} ` +
        `model ${up.health.model} api ${up.health.api} config ${up.health.configHash}`);
    return 0;
  }
  say(`ERROR: the proxy did not come up as configured (${up.state}: ${up.reason})`);
  say(`See ${LOG} for the reason — the supervisor logs why each start failed.`);
  return 1;
}

process.exitCode = await main();
