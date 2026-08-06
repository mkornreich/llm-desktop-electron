#!/usr/bin/env node
// One-time union merge of the two Claude Code session registries, run once before the
// launcher starts SHARING that directory (github issue #3).
//
// Why this has to exist at all: the two trees have diverged in BOTH directions. At the time
// of writing the real install had 440 session files and this build had 493 — 11 only in the
// real install, 61 only in the build, and 15 present in both with different contents. A
// symlink adopts one directory and abandons the other, so pointing the build at the real
// install without merging first would silently drop those 61 sessions.
//
// The merge target is the REAL install, because that is what the symlink will point at.
//
//   node scripts/merge-sessions.mjs --dry-run     # decide, print, change nothing
//   node scripts/merge-sessions.mjs               # do it, after taking a backup
//
// Deliberately additive: a file missing from one side is never deleted from the other. There
// is no deletion timestamp to reason with, so "absent" cannot be distinguished from "deleted"
// and guessing wrong destroys a session.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REAL = path.join(os.homedir(), "Library/Application Support/Claude/claude-code-sessions");
const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const BUILD = path.join(REPO, "user-data/claude-code-sessions");
const BACKUP = path.join(REPO, "user-data/claude-code-sessions.premerge");

const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// Every `<user>/<org>/local_*.json` under a root, as paths relative to that root.
export function sessionFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && e.name.startsWith("local_") && e.name.endsWith(".json")) out.push(r);
    }
  };
  walk(root, "");
  return out;
}

// The merge clock. lastActivityAt is what the sidebar sorts by; lastFocusedAt and createdAt
// are the fallbacks, and mtime is the last resort for a file that carries none of them.
export function stamp(file) {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fall through to mtime */ }
  for (const k of ["lastActivityAt", "lastFocusedAt", "createdAt"]) {
    const v = doc?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return { at: v, from: k };
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return { at: Date.parse(v), from: k };
  }
  try { return { at: fs.statSync(file).mtimeMs, from: "mtime" }; } catch { return { at: 0, from: "none" }; }
}

const running = (pattern) => {
  try { execFileSync("pgrep", ["-f", pattern], { stdio: "pipe" }); return true; } catch { return false; }
};

// Decide, for every file in the union, what happens to it. Pure apart from reading the two
// trees, so the resolution rules can be tested without touching a real profile.
//
// A tie on the clock resolves to the REAL install. That matters: 9 of the 15 conflicts seen
// in practice had identical lastActivityAt and differed only in incidental fields, and a
// deterministic tie-break avoids flapping between the two on repeated runs.
export function planMerge(realRoot, buildRoot) {
  const realFiles = new Set(sessionFiles(realRoot));
  const buildFiles = new Set(sessionFiles(buildRoot));
  const all = [...new Set([...realFiles, ...buildFiles])].sort();
  const plan = { keep: [], add: [], same: [], realWins: [], buildWins: [] };
  for (const rel of all) {
    const inReal = realFiles.has(rel), inBuild = buildFiles.has(rel);
    if (inReal && !inBuild) { plan.keep.push(rel); continue; }
    if (!inReal && inBuild) { plan.add.push(rel); continue; }
    const a = path.join(realRoot, rel), b = path.join(buildRoot, rel);
    if (fs.readFileSync(a).equals(fs.readFileSync(b))) { plan.same.push(rel); continue; }
    const sa = stamp(a), sb = stamp(b);
    (sb.at > sa.at ? plan.buildWins : plan.realWins).push({ rel, real: sa, build: sb });
  }
  return plan;
}

function main() {
  if (!fs.existsSync(REAL)) { console.error(`no session store at ${REAL}`); process.exit(1); }
  if (!fs.existsSync(BUILD)) { console.error(`no session store at ${BUILD}`); process.exit(1); }
  if (fs.lstatSync(BUILD).isSymbolicLink()) {
    console.log("user-data/claude-code-sessions is already a symlink — the merge has been done. Nothing to do.");
    return;
  }

  // Both apps hold these files open and rewrite them as sessions change. Merging underneath a
  // running app can lose whichever write lands after we read.
  const live = [
    ["Claude Desktop", "/Claude.app/Contents/MacOS/Claude"],
    ["this build", `--user-data-dir=${path.join(REPO, "user-data")}`],
  ].filter(([, pat]) => running(pat)).map(([name]) => name);
  if (live.length && !DRY && !FORCE) {
    console.error(`refusing to merge while ${live.join(" and ")} ${live.length > 1 ? "are" : "is"} running.`);
    console.error("quit them first, or pass --force if you know the sessions are idle.");
    process.exit(1);
  }
  if (live.length) console.log(`! ${live.join(" and ")} running — ${DRY ? "dry run, fine" : "forced"}\n`);

  const realFiles = new Set(sessionFiles(REAL));
  const buildFiles = new Set(sessionFiles(BUILD));
  const all = [...new Set([...realFiles, ...buildFiles])].sort();
  const plan = planMerge(REAL, BUILD);

  const short = (rel) => rel.split("/").pop().replace(/^local_/, "").slice(0, 8);
  const when = (s) => `${new Date(s.at).toISOString().slice(0, 19).replace("T", " ")} (${s.from})`;

  console.log(`real  : ${realFiles.size} files   ${REAL}`);
  console.log(`build : ${buildFiles.size} files   ${BUILD}`);
  console.log(`union : ${all.length} files\n`);
  console.log(`  ${plan.same.length.toString().padStart(4)}  identical, nothing to do`);
  console.log(`  ${plan.keep.length.toString().padStart(4)}  only in the real install — kept as is`);
  console.log(`  ${plan.add.length.toString().padStart(4)}  only in this build — will be ADDED to the real install`);
  console.log(`  ${plan.realWins.length.toString().padStart(4)}  differ, real install is newer — kept as is`);
  console.log(`  ${plan.buildWins.length.toString().padStart(4)}  differ, this build is newer — will OVERWRITE the real install\n`);

  if (plan.add.length) {
    console.log("ADD (build -> real):");
    for (const rel of plan.add) console.log(`   + ${short(rel)}  ${when(stamp(path.join(BUILD, rel)))}`);
    console.log();
  }
  if (plan.realWins.length || plan.buildWins.length) {
    console.log("CONFLICTS (present on both, contents differ):");
    for (const c of [...plan.realWins, ...plan.buildWins].sort((x, y) => x.rel.localeCompare(y.rel))) {
      const winner = c.build.at > c.real.at ? "build" : "real ";
      console.log(`   ${winner === "build" ? "<-" : "  "} ${short(c.rel)}  real ${when(c.real)}  build ${when(c.build)}  -> ${winner.trim()} wins`);
    }
    console.log();
  }

  const writes = plan.add.length + plan.buildWins.length;
  if (DRY) { console.log(`dry run — ${writes} file(s) would be written into the real install.`); return; }
  if (writes === 0) { console.log("nothing to write; the real install is already a superset."); return; }

  // Back up BOTH trees before touching either. clonefile on APFS makes this near-free; the
  // plain copy is the fallback on other filesystems.
  fs.rmSync(BACKUP, { recursive: true, force: true });
  fs.mkdirSync(BACKUP, { recursive: true });
  for (const [name, src] of [["real", REAL], ["build", BUILD]]) {
    const dst = path.join(BACKUP, name);
    try { execFileSync("cp", ["-Rc", src, dst]); }
    catch { execFileSync("cp", ["-R", src, dst]); }
  }
  console.log(`backed up both trees to ${BACKUP}`);

  let written = 0;
  for (const rel of [...plan.add, ...plan.buildWins.map((c) => c.rel)]) {
    const src = path.join(BUILD, rel), dst = path.join(REAL, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // tmp + rename: a crash mid-write must never leave a half-written session file behind.
    const tmp = `${dst}.merge-tmp-${process.pid}`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
    written++;
  }
  const after = sessionFiles(REAL).length;
  console.log(`wrote ${written} file(s); the real install now has ${after} session files.`);
  if (after !== all.length) console.log(`! expected ${all.length} — check the backup at ${BACKUP}`);
}

// Only run when invoked as a script, so the test file can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
