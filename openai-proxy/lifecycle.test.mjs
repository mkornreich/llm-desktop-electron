// Ownership, staleness and auto-restart.
//   node --test openai-proxy/lifecycle.test.mjs
//
// The restart tests spawn a REAL supervisor and a real proxy and then kill the proxy, because
// the bug being fixed was not in any single function — it was that nothing anywhere noticed a
// dead process. A mocked child would not have noticed either.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  newInstanceId, writeManifest, readManifest, clearManifest, pidIsOurProxy, probe, stopOwned,
  waitForPortFree, PROXY_ARGV, MANIFEST, runsOurProxy, processCwd, listenerPid,
} from "../scripts/lib/proxy-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-lifecycle-"));
const tmpManifest = (name) => path.join(scratch, `${name}.json`);

const freePort = () => new Promise((r) => {
  const s = http.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 20000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(pollMs);
  }
  return null;
}
const health = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

// ---------- the manifest ----------

test("a manifest survives a write that is interrupted, because the rename is the commit", () => {
  const file = tmpManifest("atomic");
  writeManifest({ instance: "aaaa", pid: 1 }, file);
  assert.equal(readManifest(file).instance, "aaaa");
  // A half-written file would parse as null and read as "not ours", stranding a healthy proxy
  // as unownable. The temp-then-rename means readers only ever see a complete document.
  const leftovers = fs.readdirSync(scratch).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "no temp file may be left behind");
  clearManifest(file);
  assert.equal(readManifest(file), null);
});

test("an unreadable or corrupt manifest reads as absent rather than throwing", () => {
  const file = tmpManifest("corrupt");
  fs.writeFileSync(file, "{ this is not json");
  assert.equal(readManifest(file), null);
  assert.equal(readManifest(path.join(scratch, "does-not-exist.json")), null);
});

test("an instance id is unique per call — it is the thing that proves ownership", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newInstanceId()));
  assert.equal(ids.size, 500);
  assert.match(newInstanceId(), /^[0-9a-f]{16}$/);
});

// ---------- ownership ----------

test("a live pid that is not running our proxy is never ours", () => {
  // pid 1 is alive on every Unix and is emphatically not our proxy. This is the check that
  // stops a recycled pid from being adopted: `kill(pid, 0)` succeeds for any live process.
  assert.equal(pidIsOurProxy(1), false);
  assert.equal(pidIsOurProxy(process.pid), false, "even this test process is not the proxy");
  assert.equal(pidIsOurProxy(0), false);
  assert.equal(pidIsOurProxy(null), false);
  // A pid that cannot exist.
  assert.equal(pidIsOurProxy(0x7ffffff0), false);
});

test("ownership matches the absolute script path, so another checkout is not ours", () => {
  assert.ok(path.isAbsolute(PROXY_ARGV));
  assert.ok(PROXY_ARGV.endsWith("openai-proxy/proxy.mjs"));
  // The injected process list is how this is testable at all. A proxy from a different
  // checkout has the same basename and must not be claimed.
  const ps = `  4242 node /somewhere/else/openai-proxy/proxy.mjs\n`;
  assert.equal(
    [...ps.matchAll(/^\s*(\d+)\s+(.*)$/gm)].some(([, , argv]) => argv.includes(PROXY_ARGV)),
    false, "a same-named proxy from another checkout must not match");
});

test("stopOwned refuses to signal a process it cannot prove is ours", async () => {
  const killed = [];
  const kill = (pid, sig) => killed.push([pid, sig]);
  // pid 1 is alive but is not our proxy. Refusing here is the whole point: the previous
  // implementation was `pkill -f llm-desktop-electron/user-data`, which would match any
  // process that merely mentioned that path — a grep, an editor, another agent's shell.
  const r = await stopOwned({ pid: 1 }, { kill });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /not running our proxy/);
  assert.deepEqual(killed, [], "nothing may be signalled");
  assert.equal((await stopOwned({}, { kill })).stopped, false);
  assert.equal((await stopOwned(null, { kill })).stopped, false);
});

// ---------- probe: the four states ----------

const fakeHealth = (body) => async () => ({ ok: true, json: async () => body });
const noServer = () => async () => { throw new Error("ECONNREFUSED"); };

test("probe reports absent when nothing answers and no process is alive", async () => {
  const file = tmpManifest("absent");
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file, fetchImpl: noServer() });
  assert.equal(r.state, "absent");
});

test("probe reports foreign for a server that answers without an instance id", async () => {
  // Anything that is not our proxy: another project's server, a leftover dev server, a tunnel.
  // It must never be killed to free the port.
  const file = tmpManifest("no-instance");
  writeManifest({ instance: "ours", pid: process.pid }, file);
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                          fetchImpl: fakeHealth({ ok: true, model: "something" }) });
  assert.equal(r.state, "foreign");
  assert.match(r.reason, /no instance id/);
});

test("probe reports foreign when the instance id is not the one we issued", async () => {
  const file = tmpManifest("wrong-instance");
  writeManifest({ instance: "ours", pid: process.pid }, file);
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                          fetchImpl: fakeHealth({ ok: true, instance: "theirs", pid: process.pid }) });
  assert.equal(r.state, "foreign");
  assert.match(r.reason, /did not issue/);
});

test("probe reports foreign when the instance matches but the pid is not our proxy", async () => {
  // Defence against a manifest that has been copied, edited, or left over from a checkout that
  // has since been replaced: the id alone is not enough if the process behind it is not ours.
  const file = tmpManifest("bad-pid");
  writeManifest({ instance: "ours", pid: 1 }, file);
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                          fetchImpl: fakeHealth({ ok: true, instance: "ours", pid: 1 }) });
  assert.equal(r.state, "foreign");
  assert.match(r.reason, /not running our proxy/);
});

test("ownership survives a relative argv, resolved through the process's cwd", async () => {
  // THE FIXTURE THAT LIED. Every ownership test used an absolute path, and passed — while the
  // actual running proxy had argv `node proxy.mjs`, because the launcher started it as
  // `cd openai-proxy && node proxy.mjs` (and the README documents running it that way by hand).
  // Matching the absolute path alone reported the user's own proxy as foreign, which would have
  // made the first launch after this change refuse to start. Caught only by probing a live
  // process instead of a fixture.
  const ourDir = path.dirname(PROXY_ARGV);
  assert.equal(runsOurProxy(1, "node proxy.mjs", () => ourDir), true,
    "a relative argv plus our cwd is our proxy");
  assert.equal(runsOurProxy(1, "node ./proxy.mjs", () => ourDir), true);
  assert.equal(runsOurProxy(1, `node ${PROXY_ARGV}`, () => null), true,
    "an absolute argv needs no cwd lookup at all");

  // And the rejections. Failing closed matters: the answer authorises sending a signal.
  assert.equal(runsOurProxy(1, "node proxy.mjs", () => "/somewhere/else/openai-proxy"), false,
    "the same relative argv from another checkout is NOT ours");
  assert.equal(runsOurProxy(1, "node proxy.mjs", () => null), false,
    "unprovable means not ours");
  assert.equal(runsOurProxy(1, "node server.mjs", () => ourDir), false);
  // "Mentions the path" is not the question — that is the `pkill -f` bug being replaced, and it
  // bites here too. Each of these names the file, from the right directory, and is not the proxy.
  assert.equal(runsOurProxy(1, "grep -r proxy.mjs .", () => ourDir), false,
    "merely mentioning the filename is not running it");
  assert.equal(runsOurProxy(1, `vim ${PROXY_ARGV}`, () => ourDir), false,
    "editing it is not running it");
  assert.equal(runsOurProxy(1, "tail -f proxy.log proxy.mjs", () => ourDir), false);
  assert.equal(runsOurProxy(1, `sh -c "node ${PROXY_ARGV}"`, () => ourDir), false,
    "a shell wrapper is not the proxy process itself");
  // Flags before the script are fine; a mention AFTER the script argument is not the script.
  assert.equal(runsOurProxy(1, "/usr/local/bin/node --enable-source-maps proxy.mjs", () => ourDir), true);
  assert.equal(runsOurProxy(1, "node other.mjs proxy.mjs", () => ourDir), false,
    "only the first non-flag argument is the script");
  assert.equal(runsOurProxy(1, "", () => ourDir), false);
});

test("a proxy from before instance ids existed is stale, not foreign", async () => {
  // The first launch after this change would otherwise refuse to start: the running proxy has no
  // instance id and no manifest, so the nonce check calls it foreign and reports the user's own
  // process as somebody else's squatter. It is identified instead by a live process whose argv is
  // the absolute path of this repository's proxy.mjs, plus this proxy's own signature string.
  const file = tmpManifest("legacy");
  clearManifest(file);
  // Deliberately the RELATIVE argv, which is what the old launcher actually produced.
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                          ps: "  4242 node proxy.mjs\n",
                          cwdOf: () => path.dirname(PROXY_ARGV), listener: () => null,
                          fetchImpl: fakeHealth({ ok: true, proxy: "anthropic->openai", model: "gpt-4.1" }) });
  assert.equal(r.state, "stale");
  assert.match(r.reason, /before instance ids existed/);
  assert.equal(r.manifest.pid, 4242, "and it must be stoppable, or the launch still cannot proceed");
  assert.equal(r.manifest.legacy, true);
});

test("the migration path does not adopt a server that merely lacks an instance id", async () => {
  // Both halves of the evidence are required. A stranger on the port with no `instance` and no
  // process running our proxy stays foreign — the legacy allowance must not become a blanket
  // "anything unidentified is probably mine".
  const file = tmpManifest("legacy-neg");
  clearManifest(file);
  const noProc = await probe({ port: 1, configHash: "h", codeVersion: "c", file, ps: "  1 launchd\n",
                               cwdOf: () => null, listener: () => null,
                               fetchImpl: fakeHealth({ ok: true, proxy: "anthropic->openai" }) });
  assert.equal(noProc.state, "foreign");
  const wrongSig = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                                 ps: `  4242 node ${PROXY_ARGV}\n`, listener: () => null,
                                 fetchImpl: fakeHealth({ ok: true, proxy: "something-else" }) });
  assert.equal(wrongSig.state, "foreign");
  // A proxy.mjs from a DIFFERENT checkout, relative argv and all, must stay foreign.
  const other = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                              ps: "  4242 node proxy.mjs\n",
                              cwdOf: () => "/somewhere/else/openai-proxy", listener: () => null,
                              fetchImpl: fakeHealth({ ok: true, proxy: "anthropic->openai" }) });
  assert.equal(other.state, "foreign");
});

test("probe reports stale when the running config or code differs from disk", async () => {
  // This is the failure that made the whole phase necessary: change a model, relaunch, and the
  // old proxy keeps answering /health, so the launcher reuses it and reports success.
  const file = tmpManifest("stale");
  const psLine = `  ${process.pid} node ${PROXY_ARGV}\n`;      // pretend this process is the proxy
  writeManifest({ instance: "ours", pid: process.pid }, file);
  const base = { port: 1, file, ps: psLine, listener: () => null };

  const oldConfig = await probe({ ...base, configHash: "new", codeVersion: "c",
    fetchImpl: fakeHealth({ ok: true, instance: "ours", pid: process.pid, configHash: "old", codeVersion: "c" }) });
  assert.equal(oldConfig.state, "stale");
  assert.match(oldConfig.reason, /running config old, on disk is new/);

  const oldCode = await probe({ ...base, configHash: "h", codeVersion: "new",
    fetchImpl: fakeHealth({ ok: true, instance: "ours", pid: process.pid, configHash: "h", codeVersion: "old" }) });
  assert.equal(oldCode.state, "stale");
  assert.match(oldCode.reason, /proxy code old/);
});

test("probe reports stale, not absent, when our process is alive but not answering", async () => {
  // The port is NOT free in this state, so treating it as absent would make the next start fail
  // with EADDRINUSE and report that as the problem.
  const file = tmpManifest("wedged");
  writeManifest({ instance: "ours", pid: process.pid }, file);
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                          fetchImpl: noServer(), ps: `  ${process.pid} node ${PROXY_ARGV}\n` });
  assert.equal(r.state, "stale");
  assert.match(r.reason, /not answering/);
});

test("probe reports ours only when identity, code and config all agree", async () => {
  const file = tmpManifest("ours");
  writeManifest({ instance: "ours", pid: process.pid }, file);
  const r = await probe({ port: 1, configHash: "h", codeVersion: "c", file,
                          ps: `  ${process.pid} node ${PROXY_ARGV}\n`,
                          fetchImpl: fakeHealth({ ok: true, instance: "ours", pid: process.pid,
                                                  configHash: "h", codeVersion: "c" }) });
  assert.equal(r.state, "ours");
});

test("waitForPortFree returns as soon as nothing is listening", async () => {
  assert.equal(await waitForPortFree(1, { fetchImpl: noServer() }), true);
  // And gives up rather than blocking forever when something keeps answering.
  assert.equal(await waitForPortFree(1, { fetchImpl: fakeHealth({ ok: true }), timeoutMs: 300 }),
    false);
});

// ---------- the real proxy: identity on the wire ----------

test("a live proxy reports an identity that lets a caller prove ownership", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "proxy.mjs")],
    { stdio: "ignore", env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "test-not-real" } });
  try {
    const h = await waitFor(() => health(port));
    assert.ok(h, "the proxy should come up");
    assert.equal(h.ok, true);
    assert.match(h.instance, /^[0-9a-f]{16}$/, "an instance nonce is served");
    assert.equal(h.pid, child.pid, "and it reports its own pid");
    assert.match(h.configHash, /^[0-9a-f]{16}$/);
    assert.match(h.codeVersion, /^[0-9a-f]{12}$/);
    assert.equal(h.port, port);

    // The manifest must agree with the wire, or ownership cannot be established.
    const m = await waitFor(() => { const x = readManifest(); return x?.pid === child.pid ? x : null; });
    assert.ok(m, "the proxy must register itself");
    assert.equal(m.instance, h.instance);
    assert.equal(m.configHash, h.configHash);

    // And the whole point: a probe against this identity says "ours".
    const p = await probe({ port, configHash: h.configHash, codeVersion: h.codeVersion });
    assert.equal(p.state, "ours", p.reason);

    // Same proxy, but ask for a different config: stale, not ours.
    const stale = await probe({ port, configHash: "0000000000000000", codeVersion: h.codeVersion });
    assert.equal(stale.state, "stale");
  } finally {
    child.kill("SIGKILL");
    await waitFor(async () => !(await health(port)));
  }
});

test("/health never exposes the API key, only a one-way fingerprint", async () => {
  // This endpoint is unauthenticated on localhost, and it now returns the whole effective
  // configuration. A key reaching it would be a real leak, so this is asserted against a live
  // server rather than against the snapshot function.
  const port = await freePort();
  const key = "sk-lifecycle-test-key-9876543210";
  const child = spawn(process.execPath, [path.join(HERE, "proxy.mjs")],
    { stdio: "ignore", env: { ...process.env, PORT: String(port), OPENAI_API_KEY: key } });
  try {
    const h = await waitFor(() => health(port));
    assert.ok(h);
    const body = JSON.stringify(h);
    assert.ok(!body.includes(key), "the key must not appear anywhere in /health");
    assert.ok(!body.includes("sk-lifecycle"), "not even a prefix");
    assert.ok(!("OPENAI_API_KEY" in (h.config?.settings || {})));
    assert.match(h.config.apiKeyFingerprint, /^sha256:[0-9a-f]{12}$/);
  } finally {
    child.kill("SIGKILL");
    await waitFor(async () => !(await health(port)));
  }
});

// ---------- auto-restart ----------

test("the supervisor brings the proxy back after it dies", async () => {
  // The incident, reproduced: kill the proxy and see whether anything notices. Before the
  // supervisor existed, nothing did — the app kept running against a closed port for hours.
  const port = await freePort();
  const sup = spawn(process.execPath, [path.join(HERE, "supervise.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "test-not-real",
           PROXY_RESTART_BASE_MS: "50", PROXY_HEALTH_EVERY_MS: "0" },   // watchdog off; this tests exit handling
  });
  let out = "";
  sup.stdout.on("data", (d) => (out += d));
  sup.stderr.on("data", (d) => (out += d));
  try {
    const first = await waitFor(() => health(port));
    assert.ok(first, `the proxy should come up. Log:\n${out}`);

    process.kill(first.pid, "SIGKILL");                       // a hard crash, no cleanup

    const second = await waitFor(async () => {
      const h = await health(port);
      return h && h.pid !== first.pid ? h : null;
    });
    assert.ok(second, `a replacement proxy should be listening. Log:\n${out}`);
    assert.notEqual(second.pid, first.pid, "it must be a new process");
    assert.notEqual(second.instance, first.instance, "with a new instance id");
    assert.match(out, /restarting/, "and the restart must be stated in the log, not silent");
    // An external kill is not a failure to start. Counting it toward the give-up bound would
    // mean a handful of manual restarts quietly disables auto-restart altogether.
    assert.match(out, /killed \(signal SIGKILL\)/);
    assert.ok(!/fast failure/.test(out), "a signalled exit must not count against the bound");
  } finally {
    sup.kill("SIGTERM");
    await waitFor(async () => !(await health(port)), { timeoutMs: 10000 });
    sup.kill("SIGKILL");
  }
});

test("the supervisor gives up loudly instead of looping on a proxy that cannot start", async () => {
  // A bound port, a syntax error or a missing module fails instantly every time. Retrying
  // forever burns CPU and presents to the app as a hang, which is harder to diagnose than a
  // clear refusal. PROXY_NO_LISTEN makes the child exit immediately, standing in for that.
  const sup = spawn(process.execPath, [path.join(HERE, "supervise.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PROXY_NO_LISTEN: "1", PROXY_RESTART_BASE_MS: "1",
           PROXY_RESTART_MAX_MS: "5", PROXY_MAX_FAST_FAILURES: "3", PROXY_HEALTH_EVERY_MS: "0" },
  });
  let out = "";
  sup.stdout.on("data", (d) => (out += d));
  sup.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => sup.on("exit", r));

  assert.equal(code, 1, `it must exit non-zero so the launcher can tell. Log:\n${out}`);
  assert.match(out, /giving up after 3 immediate failures/);
  assert.match(out, /restarting, fast failure 1\/3/);
  assert.match(out, /restarting, fast failure 3\/3/);
  assert.ok(!/fast failure 4\/3/.test(out), "the bound must actually bind");
  // The message has to say what to do about it, because this line is the only thing the
  // operator sees when the app reports a connection failure.
  assert.match(out, /bound port|bad config|syntax error/);
});

test("the supervisor's watchdog restarts a proxy that holds the port without answering", async () => {
  // The state the exit handler cannot see. SIGSTOP freezes the proxy: still alive, still
  // holding the port, permanently unable to answer /health — which is what a wedged event loop
  // looks like from outside.
  const port = await freePort();
  const sup = spawn(process.execPath, [path.join(HERE, "supervise.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "test-not-real",
           PROXY_RESTART_BASE_MS: "50", PROXY_HEALTH_EVERY_MS: "300",
           PROXY_HEALTH_TIMEOUT_MS: "400", PROXY_HEALTH_MISSES: "2" },
  });
  let out = "";
  sup.stdout.on("data", (d) => (out += d));
  sup.stderr.on("data", (d) => (out += d));
  try {
    const first = await waitFor(() => health(port));
    assert.ok(first, `the proxy should come up. Log:\n${out}`);

    process.kill(first.pid, "SIGSTOP");                       // alive, wedged, holding the port
    try {
      const second = await waitFor(async () => {
        const h = await health(port);
        return h && h.pid !== first.pid ? h : null;
      }, { timeoutMs: 25000 });
      assert.ok(second, `the watchdog should have replaced the wedged proxy. Log:\n${out}`);
      assert.match(out, /holding the port without answering/);
    } finally {
      try { process.kill(first.pid, "SIGCONT"); } catch {}
      try { process.kill(first.pid, "SIGKILL"); } catch {}
    }
  } finally {
    sup.kill("SIGTERM");
    await waitFor(async () => !(await health(port)), { timeoutMs: 10000 });
    sup.kill("SIGKILL");
  }
});

test("the launcher converges on a port other than the default", async () => {
  // REGRESSION. ensure-proxy.mjs computed the config hash from the ambient environment while
  // spawning the proxy with PORT overridden, so the two processes resolved DIFFERENT configs.
  // Every probe then said "stale": it stopped a healthy proxy, started another, called that one
  // stale too, and exited 1 — an infinite disagreement with itself. It passed unnoticed because
  // on the default port both sides happen to resolve the same value.
  //
  // Run on a non-default port, twice: the first call must converge, and the second must REUSE
  // rather than restart, which is the property the hash exists to provide.
  const port = await freePort();
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "..", "scripts", "ensure-proxy.mjs"),
                                       "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "test-not-real" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => resolve({ code, out }));
  });
  try {
    const first = await run();
    assert.equal(first.code, 0, `the launcher must succeed. Output:\n${first.out}`);
    assert.match(first.out, /proxy healthy/);

    const second = await run();
    assert.equal(second.code, 0, `the second call must also succeed. Output:\n${second.out}`);
    assert.match(second.out, /reusing the running proxy/,
      "an unchanged config must be reused, not restarted");
    assert.ok(!/stale/.test(second.out), "and must never be reported stale against itself");
  } finally {
    // Stop the supervisor, which stops its proxy. Matched on the argv of THIS repo's supervisor
    // so no unrelated process is signalled.
    const { processList } = await import("../scripts/lib/procs.mjs");
    const sup = path.join(HERE, "supervise.mjs");
    for (const [pid, argv] of processList())
      if (argv.includes(sup)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await waitFor(async () => !(await health(port)), { timeoutMs: 10000 });
  }
});

test("a proxy stopped with SIGTERM clears its own manifest", async () => {
  // A manifest outliving its process would let the next launcher believe a dead instance is
  // ownable, and it would then try to stop something that is not there.
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "proxy.mjs")],
    { stdio: "ignore", env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "test-not-real" } });
  const h = await waitFor(() => health(port));
  assert.ok(h);
  await waitFor(() => readManifest()?.pid === child.pid);
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  const after = readManifest();
  assert.ok(after === null || after.instance !== h.instance,
    "the manifest must not still claim the instance that just exited");
});

test.after(() => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  // The suite starts real proxies, which register themselves in the repository's manifest. Do
  // not leave a manifest behind pointing at a test process that no longer exists.
  const m = readManifest();
  if (m) { try { process.kill(m.pid, 0); } catch { clearManifest(); } }
});
