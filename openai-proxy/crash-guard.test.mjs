// The proxy must survive a dropped upstream connection that surfaces OUTSIDE any await.
//   node --test openai-proxy/crash-guard.test.mjs
//
// This is a regression test for a real outage. On 08-13 at 05:32:47 the proxy died:
//
//   TypeError: terminated
//       at Fetch.onAborted (undici/lib/web/fetch/index.js:2132:49)
//     [cause]: Error: read ETIMEDOUT { errno: -60, syscall: 'read' }
//   Node.js v26.5.0
//
// One long turn's socket timed out. undici rejected the fetch's own internal task, so the
// rejection was unhandled, and Node's default --unhandled-rejections=throw killed the process.
// The Electron app, the launcher and four live Claude Code agents kept running against a dead
// port; every OpenAI-mode turn failed to connect until someone restarted it by hand.
//
// The transport retry cannot catch this: it only sees what is thrown out of `await`. These tests
// drive the process-level handlers directly, in a real child process, because that is the only
// way to observe "did the process stay alive".
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROXY = fileURLToPath(new URL("./proxy.mjs", import.meta.url));

// Boot a real proxy child, run one snippet of code inside it via stdin-driven eval, and report
// whether it is still alive afterwards. PROXY_NO_LISTEN keeps it off the real port.
function runInProxy({ throwWhat, waitMs = 900 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e", `
        process.env.PROXY_NO_LISTEN = "1";
        process.env.OPENAI_API_KEY = "test-key-not-real";
        await import(${JSON.stringify(PROXY)});
        // Reject OUTSIDE any await, exactly as undici does from its fetch task.
        ${throwWhat}
        setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, ${waitMs});
      `,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code, signal) => resolve({ code, signal, out, err }));
  });
}

test("a dropped upstream connection does not kill the proxy", async () => {
  // The exact shape undici produces: TypeError("terminated") wrapping a socket errno.
  const r = await runInProxy({
    throwWhat: `
      const e = new TypeError("terminated");
      e.cause = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "read" });
      Promise.reject(e);
    `,
  });
  assert.match(r.out, /STILL_ALIVE/,
    `the proxy must survive a dropped socket. stdout=${r.out} stderr=${r.err.slice(0, 400)}`);
  assert.equal(r.code, 0, "it should exit cleanly on its own terms, not crash");
  // And it must say what happened — a silent survival is its own debugging problem.
  assert.match(r.out, /dropped upstream connection/,
    "the loss must be logged, naming the cause");
});

test("the ETIMEDOUT shape from the real outage is recognised", async () => {
  // The production stack had the errno on the cause, with no `terminated` message at top level.
  const r = await runInProxy({
    throwWhat: `
      const inner = new Error("read ETIMEDOUT");
      inner.errno = -60; inner.code = "ETIMEDOUT"; inner.syscall = "read";
      const e = new TypeError("terminated"); e.cause = inner;
      Promise.reject(e);
    `,
  });
  assert.match(r.out, /STILL_ALIVE/, `must survive the exact production shape. stderr=${r.err.slice(0, 400)}`);
});

test("a real bug still exits, so a supervisor can restart on clean state", async () => {
  // The guard is deliberately narrow. A programming error means unknown corrupt state, and
  // limping on is worse than restarting — this is the half that must NOT be swallowed.
  const r = await runInProxy({
    throwWhat: `Promise.reject(new TypeError("cannot read properties of undefined (reading 'map')"));`,
  });
  assert.doesNotMatch(r.out, /STILL_ALIVE/, "a genuine bug must not be swallowed");
  assert.equal(r.code, 1, "it must exit non-zero so a supervisor knows it failed");
  assert.match(r.out + r.err, /unhandledRejection/, "and must log why it died");
});

test("a synchronous uncaught exception is handled the same way", async () => {
  const r = await runInProxy({
    throwWhat: `
      setTimeout(() => {
        const e = new TypeError("terminated");
        e.cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        throw e;                       // uncaughtException, not a rejection
      }, 10);
    `,
  });
  assert.match(r.out, /STILL_ALIVE/,
    `a transport-shaped uncaughtException must not kill the proxy. stderr=${r.err.slice(0, 400)}`);
});
