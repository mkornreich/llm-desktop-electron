// Is a given app running? Shared by merge-sessions.mjs and sync-grouping.mjs, both of which
// must refuse to touch state underneath a live app.
//
// WHY NOT pgrep -f, WHICH IS THE OBVIOUS ANSWER:
//
// On macOS, `pgrep` does not list Claude Desktop's main process at all. Measured against a
// live pid 26468 whose argv `ps` reports as
//   /Users/mk/Applications/Claude.app/Contents/MacOS/Claude
// every one of these returned an empty set, or a set not containing it:
//   pgrep -f '/Users/mk/Applications/Claude.app/Contents/MacOS/Claude'   0 matches
//   pgrep -f 'Claude.app/Contents/MacOS/Claude'                          0 matches
//   pgrep -f 'MacOS/Claude'                    9 matches, none of them 26468 (all Helpers)
//   pgrep -f 'Claude'                         36 matches, none of them 26468
//   pgrep -x 'Claude'                                                    0 matches
// while `ps -Ao pid=,command= | grep -F` found it immediately. The process is invisible to
// pgrep by argv, by comm, and by exact name.
//
// This mattered: the guard silently reported "nothing running" and the caller went on to open
// a LevelDB that a live app held an exclusive lock on, producing a NotOpenError stack trace
// instead of the friendly refusal that was written for exactly that case. There was a second,
// independent bug in the same line — a pattern beginning with "--user-data-dir=" was parsed by
// pgrep as its own flag, so that lookup errored out and the catch read it as "not running".
// Both disappear with `ps`, which needs no pattern escaping because the match is a plain
// substring test rather than a regex.
import { execFileSync } from "node:child_process";

// One `ps` call, parsed into [pid, argv] pairs. `command=` must come last: it contains spaces,
// so anything after it would be swallowed.
export function processList(ps = null) {
  const raw =
    ps ??
    execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024, // a busy Mac easily exceeds the 1MB default
    });
  const out = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) out.push([Number(m[1]), m[2]]);
  }
  return out;
}

// Plain substring match, skipping our own process so that passing a needle on our command line
// cannot make us report ourselves as the app.
export function isRunning(needle, ps = null, selfPid = process.pid) {
  return processList(ps).some(([pid, argv]) => pid !== selfPid && argv.includes(needle));
}

// The two apps this repo cares about. Claude Desktop is matched on a path fragment rather than
// an absolute path because the install location varies — /Applications for a system install,
// ~/Applications for a per-user one (which is where it actually lives on this machine).
export const CLAUDE_DESKTOP = "Claude.app/Contents/MacOS/Claude";

export function buildApp(repo) {
  return `--user-data-dir=${repo}/user-data`;
}

// Returns the names of whichever apps are live, for a message that says which one to quit.
// Helper processes are excluded: they share the main process's path prefix, so counting them
// would report the app as running from a leftover crashpad handler.
export function liveApps(repo, ps = null) {
  const list = processList(ps);
  const hit = (needle, extra = () => true) =>
    list.some(([pid, argv]) => pid !== process.pid && argv.includes(needle) && extra(argv));
  return [
    ["Claude Desktop", () => hit(CLAUDE_DESKTOP, (a) => !a.includes("Helper"))],
    ["this build", () => hit(buildApp(repo))],
  ]
    .filter(([, test]) => test())
    .map(([name]) => name);
}
