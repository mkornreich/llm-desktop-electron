// Identity and ownership for the translation proxy.
//
// THE PROBLEM THIS SOLVES. run.sh decided whether to start a proxy by asking whether anything
// answered /health, and settings' relaunch killed processes by `pkill -f`. Neither knows what
// it is talking to, which produced three distinct failures:
//
//   * Change a model, relaunch, and the OLD proxy kept answering. /health said ok, so the
//     launcher reused it and reported success. Config on disk and config in memory could
//     disagree for as long as the process lived.
//   * The proxy crashed on 08-13 and a replacement was started by hand. It ran with PPID 1,
//     which is exactly what a foreign process looks like. Nothing could tell "my proxy, whose
//     parent exited" from "someone else's server on my port", so the only safe move was to
//     leave it alone — or the unsafe one, to kill whatever was there.
//   * `pkill -f llm-desktop-electron/user-data` matches on a substring of a command line. Any
//     process that merely MENTIONS that path — a grep, an editor, another agent's shell — is a
//     candidate. It is a pattern, not an identity.
//
// So a running proxy writes a manifest saying who it is, and serves the same instance nonce
// from /health. The nonce is what makes ownership provable rather than inferred: only the
// process that generated it can serve it, so matching it rules out a recycled PID, a foreign
// server, and a stale manifest in one comparison.
//
// ORDER OF EVIDENCE, weakest to strongest:
//   1. something answers /health                    -> a server exists
//   2. it reports our configHash and codeVersion    -> it would behave as configured
//   3. it reports a nonce matching our manifest     -> it IS the process we started
// Only (3) authorises stopping it.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { processList } from "./procs.mjs";

export const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Resolved LAZILY for the same reason the provenance store is: a module-level constant is captured
// before a test can redirect it. It also has to be redirectable at all — several test files start
// real proxies concurrently, and a single shared manifest makes them fight over ownership, which
// showed up as a launcher test that passed alone and failed in the suite.
export const defaultManifest = () =>
  process.env.PROXY_MANIFEST_FILE || path.join(REPO, "openai-proxy", "proxy-runtime.json");
export const MANIFEST = path.join(REPO, "openai-proxy", "proxy-runtime.json");

// A process running THIS repository's proxy. Matched on the absolute script path so a proxy
// from another checkout — or a same-named file anywhere else — is never mistaken for ours.
export const PROXY_ARGV = path.join(REPO, "openai-proxy", "proxy.mjs");

export function newInstanceId() {
  return crypto.randomBytes(8).toString("hex");
}

// Atomic: write a sibling temp file, then rename. A crash mid-write must not leave a truncated
// manifest, because a truncated manifest is unparseable and unparseable reads as "not mine" —
// which would strand a perfectly healthy proxy as unownable.
export function writeManifest(m, file = defaultManifest()) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return m;
}

export function readManifest(file = defaultManifest()) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function clearManifest(file = defaultManifest()) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// A process's working directory, or null. Needed because an argv is not always a path: the
// launcher used to start the proxy as `cd openai-proxy && node proxy.mjs`, and the README still
// documents running it that way by hand, so the argv reads `node proxy.mjs` with no directory in
// it at all. Matching the absolute path alone therefore reports the user's own proxy as foreign —
// which is exactly what happened the first time this was checked against a live process rather
// than against a fixture.
export function processCwd(pid) {
  try {
    // -Fn is the machine-readable form: one field per line, `n` prefixing the path.
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) if (line.startsWith("n")) return line.slice(1);
  } catch { /* lsof missing, or the process went away */ }
  return null;
}

// Which pid is listening on a port. Better than scanning for a process that looks like ours when
// several could exist, because the port is the thing actually in contention.
export function listenerPid(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pid = parseInt(out.trim().split("\n")[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

// Does this process EXECUTE this repository's proxy?
//
// "Mentions the path" is not the question — that is precisely the `pkill -f` bug being replaced,
// and it bites here too: `grep -r proxy.mjs .` run from openai-proxy/ names the file, sits in the
// right directory, and is emphatically not the proxy. So the argv is parsed as a command line:
// the executable must be node, and the SCRIPT ARGUMENT must resolve to our proxy.
//
// The script path may be absolute (how the supervisor spawns it) or relative (`cd openai-proxy &&
// node proxy.mjs`, which is what the old launcher did and what the README still documents), so a
// relative one is resolved against the process's working directory.
//
// Fails closed throughout: anything unparseable or unprovable is not ours, because the answer
// authorises sending a signal.
export function runsOurProxy(pid, argv, cwdOf = processCwd) {
  const tokens = String(argv || "").trim().split(/\s+/);
  if (!tokens.length) return false;
  // The executable. `node`, `/usr/local/bin/node`, `node22` — but not `grep`, and not `sh -c`.
  if (!/^(?:.*\/)?node[0-9.]*$/.test(tokens[0])) return false;
  // The first non-flag argument after the executable is the script. Stopping at the first one is
  // what makes a later mention of the filename irrelevant.
  const script = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!script || !script.endsWith("proxy.mjs")) return false;
  if (path.isAbsolute(script)) return script === PROXY_ARGV;
  const cwd = cwdOf(pid);
  return !!cwd && path.resolve(cwd, script) === PROXY_ARGV;
}

// Is a PID both alive AND running our proxy? Liveness alone is not enough: PIDs are recycled, and
// signal 0 on a recycled PID succeeds against a completely unrelated program.
export function pidIsOurProxy(pid, ps = null, cwdOf = processCwd) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }     // gone, or not ours to signal
  return processList(ps).some(([p, argv]) => p === pid && runsOurProxy(p, argv, cwdOf));
}

// What is on the port, and may we act on it?
//
//   state: "absent"   nothing answered
//          "foreign"  something answered but is not our proxy — never to be killed
//          "stale"    ours, but running a different config or different code
//          "ours"     ours, and current
//
// `fetchImpl` is injectable so the tests do not need a socket.
export async function probe({ port, configHash, codeVersion, file = defaultManifest(),
                              fetchImpl = fetch, timeoutMs = 1500, ps = null,
                              cwdOf = processCwd, listener = listenerPid } = {}) {
  const manifest = readManifest(file);
  let health = null;
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`,
      { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) health = await r.json();
  } catch { /* nothing listening, or not speaking HTTP */ }

  if (!health) {
    // Nothing is answering. If the manifest still claims a live process running our proxy, it
    // is up but wedged — not answering HTTP while holding the port. That is a distinct state
    // from "absent" because the port is not actually free.
    if (manifest && pidIsOurProxy(manifest.pid, ps, cwdOf))
      return { state: "stale", reason: "not answering /health but the process is alive", manifest, health: null };
    return { state: "absent", reason: manifest ? "manifest is stale; no process" : "nothing running",
             manifest, health: null };
  }

  // Answering, but is it ours? An instance nonce we never issued means someone else's server.
  if (!health.instance || !manifest || health.instance !== manifest.instance) {
    // MIGRATION. A proxy started before instance ids existed answers /health with no `instance`
    // and wrote no manifest, so the nonce comparison above calls it foreign — which would make
    // the first launch after this change refuse to start, reporting the user's own proxy as
    // somebody else's process squatting on the port.
    //
    // It is still identifiable, just by different evidence: a live process whose argv is the
    // ABSOLUTE path of this repository's proxy.mjs, answering with this proxy's own signature
    // string. For something foreign to satisfy both it would have to be running this very file,
    // in which case it is ours. Reported as stale, because it predates everything that makes a
    // proxy verifiable and must be replaced rather than reused.
    // Prefer the pid actually listening on the port — the port is the thing in contention, and
    // there could be more than one of our proxies alive on different ports. Fall back to scanning
    // when lsof is unavailable.
    let legacy = null;
    if (!health.instance && health.proxy === "anthropic->openai") {
      const lp = listener(port);
      if (lp && pidIsOurProxy(lp, ps, cwdOf)) legacy = lp;
      else {
        const hit = processList(ps).find(([p, argv]) => runsOurProxy(p, argv, cwdOf));
        if (hit) legacy = hit[0];
      }
    }
    if (legacy)
      return { state: "stale", reason: "a proxy started before instance ids existed (no manifest)",
               manifest: { pid: legacy, instance: null, legacy: true }, health };
    return { state: "foreign",
             reason: health.instance ? "answers with an instance id we did not issue"
                                     : "answers /health but reports no instance id",
             manifest, health };
  }
  if (!pidIsOurProxy(health.pid ?? manifest.pid, ps, cwdOf))
    return { state: "foreign", reason: "reports our instance id but its pid is not running our proxy",
             manifest, health };

  if (codeVersion && health.codeVersion !== codeVersion)
    return { state: "stale", reason: `running proxy code ${health.codeVersion}, on disk is ${codeVersion}`,
             manifest, health };
  if (configHash && health.configHash !== configHash)
    return { state: "stale", reason: `running config ${health.configHash}, on disk is ${configHash}`,
             manifest, health };

  return { state: "ours", reason: "current", manifest, health };
}

// Stop a proxy we own, and only one we own. SIGTERM, wait, then SIGKILL — a proxy mid-stream
// holds client connections, and dropping them is the very failure this project spent a phase
// fixing, so it gets a chance to finish.
export async function stopOwned(manifest, { sigtermGraceMs = 4000, pollMs = 100, ps = null,
                                            cwdOf = processCwd,
                                            kill = process.kill.bind(process) } = {}) {
  if (!manifest?.pid) return { stopped: false, reason: "no manifest pid" };
  if (!pidIsOurProxy(manifest.pid, ps, cwdOf))
    return { stopped: false, reason: "pid is not running our proxy — refusing to signal it" };
  try { kill(manifest.pid, "SIGTERM"); } catch { return { stopped: true, reason: "already gone" }; }

  const deadline = Date.now() + sigtermGraceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!pidIsOurProxy(manifest.pid, null, cwdOf)) return { stopped: true, reason: "exited on SIGTERM" };
  }
  try { kill(manifest.pid, "SIGKILL"); } catch { /* raced us to it */ }
  await new Promise((r) => setTimeout(r, pollMs));
  return { stopped: !pidIsOurProxy(manifest.pid, null, cwdOf), reason: "SIGKILL after grace period" };
}

// Wait for a port to stop accepting. Starting a replacement before the old listener releases
// the port produces EADDRINUSE, and the launcher then reports a failure that is really a race.
export async function waitForPortFree(port, { timeoutMs = 8000, pollMs = 150,
                                             fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
    } catch { return true; }                     // refused/timed out: nothing is listening
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
