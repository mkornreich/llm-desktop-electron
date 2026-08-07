// Tests for the one-time session merge (github issue #3).
//   node --test scripts/merge-sessions.test.mjs
//
// The merge runs once, against the user's real session store, and a wrong decision loses a
// session permanently. So the resolution rules are tested against scratch trees rather than
// trusted to a single live run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { planMerge, sessionFiles, stamp } = await import("./merge-sessions.mjs");

const ORG = "7f8f19e4/bcf0b4b7";   // the <user>/<org> shape both sides really use

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-"));
  for (const [name, doc] of Object.entries(files)) {
    const p = path.join(dir, ORG, `local_${name}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
  }
  return dir;
}
const rel = (name) => path.join(ORG, `local_${name}.json`);
const cleanup = [];
test.after(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });
function pair(a, b) {
  const ra = tree(a), rb = tree(b);
  cleanup.push(ra, rb);
  return [ra, rb];
}

test("a file only in one tree is kept, never dropped", () => {
  const [real, build] = pair(
    { onlyreal: { lastActivityAt: 1 } },
    { onlybuild: { lastActivityAt: 1 } },
  );
  const p = planMerge(real, build);
  assert.deepEqual(p.keep, [rel("onlyreal")], "real-only survives untouched");
  assert.deepEqual(p.add, [rel("onlybuild")], "build-only is added to the real install");
  // the whole point: nothing is ever scheduled for deletion
  assert.ok(!("remove" in p), "the plan has no removal category at all");
});

test("identical files are a no-op, not a rewrite", () => {
  const doc = { lastActivityAt: 5, title: "same" };
  const [real, build] = pair({ x: doc }, { x: doc });
  const p = planMerge(real, build);
  assert.deepEqual(p.same, [rel("x")]);
  assert.equal(p.buildWins.length + p.realWins.length, 0);
});

test("when contents differ, the newer lastActivityAt wins", () => {
  const [real, build] = pair(
    { older: { lastActivityAt: 100, title: "real" }, newer: { lastActivityAt: 900, title: "real" } },
    { older: { lastActivityAt: 200, title: "build" }, newer: { lastActivityAt: 300, title: "build" } },
  );
  const p = planMerge(real, build);
  assert.deepEqual(p.buildWins.map((c) => c.rel), [rel("older")], "build is newer on `older`");
  assert.deepEqual(p.realWins.map((c) => c.rel), [rel("newer")], "real is newer on `newer`");
});

test("a tie resolves to the real install, deterministically", () => {
  // 9 of the 15 real conflicts had identical lastActivityAt and differed only in incidental
  // fields. Whichever way this goes it must not flap between runs.
  const [real, build] = pair(
    { t: { lastActivityAt: 42, lastFocusedAt: 1 } },
    { t: { lastActivityAt: 42, lastFocusedAt: 2 } },
  );
  const p = planMerge(real, build);
  assert.deepEqual(p.realWins.map((c) => c.rel), [rel("t")]);
  assert.equal(p.buildWins.length, 0);
  assert.deepEqual(planMerge(real, build).realWins.map((c) => c.rel), [rel("t")], "stable across runs");
});

test("the clock falls back through lastFocusedAt, createdAt, then mtime", () => {
  const dir = tree({
    a: { lastActivityAt: 10, lastFocusedAt: 99, createdAt: 98 },
    b: { lastFocusedAt: 20, createdAt: 97 },
    c: { createdAt: 30 },
    d: { title: "no clock at all" },
  });
  cleanup.push(dir);
  assert.deepEqual(stamp(path.join(dir, rel("a"))), { at: 10, from: "lastActivityAt" });
  assert.deepEqual(stamp(path.join(dir, rel("b"))), { at: 20, from: "lastFocusedAt" });
  assert.deepEqual(stamp(path.join(dir, rel("c"))), { at: 30, from: "createdAt" });
  assert.equal(stamp(path.join(dir, rel("d"))).from, "mtime", "a file with no clock still sorts");
});

test("a corrupt session file does not abort the merge", () => {
  // One unparseable file must not take the other 500 with it.
  const dir = tree({ bad: "{ this is not json", good: { lastActivityAt: 1 } });
  cleanup.push(dir);
  const s = stamp(path.join(dir, rel("bad")));
  assert.equal(s.from, "mtime", "falls back to the filesystem clock");
  assert.ok(s.at > 0);
});

test("only local_*.json is considered, at any depth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-"));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, ORG), { recursive: true });
  fs.writeFileSync(path.join(dir, ORG, "local_keep.json"), "{}");
  fs.writeFileSync(path.join(dir, ORG, "notasession.json"), "{}");
  fs.writeFileSync(path.join(dir, ORG, "local_keep.json.bak"), "{}");
  fs.writeFileSync(path.join(dir, "stray.json"), "{}");
  assert.deepEqual(sessionFiles(dir), [rel("keep")]);
});

test("an empty side yields a pure add, and an empty union yields nothing", () => {
  const [real, build] = pair({}, { a: { lastActivityAt: 1 }, b: { lastActivityAt: 2 } });
  const p = planMerge(real, build);
  assert.equal(p.add.length, 2);
  assert.equal(p.keep.length + p.same.length + p.realWins.length + p.buildWins.length, 0);

  const [e1, e2] = pair({}, {});
  const empty = planMerge(e1, e2);
  assert.equal(Object.values(empty).flat().length, 0);
});

test("the script refuses to re-run once the store is shared", () => {
  // Running it against a symlinked store would compare the shared directory with itself.
  const src = fs.readFileSync(new URL("./merge-sessions.mjs", import.meta.url), "utf8");
  assert.match(src, /isSymbolicLink\(\)/);
  assert.match(src, /already a symlink — the merge has been done/);
});

test("it refuses to merge under a running app unless forced", async () => {
  const src = fs.readFileSync(new URL("./merge-sessions.mjs", import.meta.url), "utf8");
  assert.match(src, /refusing to merge while/);

  // The detection itself lives in lib/procs.mjs, so test the behaviour rather than the text.
  // It must name BOTH apps: an earlier version looked only for Claude Desktop, and a later one
  // used pgrep -f, which on macOS cannot see the Claude Desktop process at all and silently
  // reported nothing running. Both failures made this guard a no-op.
  const { liveApps } = await import("./lib/procs.mjs");
  const ps = [
    "26468 /Users/mk/Applications/Claude.app/Contents/MacOS/Claude",
    "31873 /repo/electron/dist/Electron.app/Contents/MacOS/Electron --user-data-dir=/repo/user-data",
  ].join("\n");
  assert.deepEqual(liveApps("/repo", ps), ["Claude Desktop", "this build"]);
  assert.deepEqual(liveApps("/repo", ps.split("\n")[1]), ["this build"], "detects THIS build on its own");
  assert.deepEqual(liveApps("/repo", ps.split("\n")[0]), ["Claude Desktop"]);
});

test("writes are atomic and backed up", () => {
  const src = fs.readFileSync(new URL("./merge-sessions.mjs", import.meta.url), "utf8");
  assert.match(src, /\.merge-tmp-/, "tmp file");
  assert.match(src, /fs\.renameSync\(tmp, dst\)/, "rename, so a crash cannot half-write a session");
  assert.match(src, /backed up both trees/);
});
