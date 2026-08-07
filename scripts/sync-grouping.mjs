#!/usr/bin/env node
// Keep the claude.ai sidebar GROUPING state in step between Claude Desktop and this build,
// merging both directions rather than letting one overwrite the other (github issue #3).
//
//   node scripts/sync-grouping.mjs --dry-run    # show the merge, change nothing
//   node scripts/sync-grouping.mjs              # apply to whichever profiles are closed
//   node scripts/sync-grouping.mjs --launch     # as above, but never fail the caller
//
// WHY NOT THE WHOLE-DIRECTORY COPY run.sh COULD ALREADY DO:
//
// Two reasons, both measured on the live profiles.
//
// 1. It is far too wide. It replaces the destination's ENTIRE claude.ai Local Storage — every
//    composer draft, sidebar preference, unread marker and the account bootstrap cache. 371
//    keys replaced to fix 3. That is why its knob, SYNC_CLAUDE_UI_STATE, had to default to 0.
//
// 2. It is lossy, because the divergence runs BOTH ways. Measured on the authoritative key, the
//    real install had 8 groups / 69 assignments and this build 8 / 61 — with 10 assignments only
//    in the real install AND 2 only in the build. A copy in either direction silently drops the
//    other side's work. The union is 8 groups / 71 assignments, and the two assignment sets were
//    disjoint, so nothing has to be arbitrated away at all.
//
// This writes 3 keys, merged, and leaves the other ~368 alone.
//
// MEMBERSHIP IS LOCAL, CONTRARY TO WHAT THE ISSUE #3 PLAN SAID:
//
// That plan recorded group membership as server-side only, at
//   GET /api/claude_code/organizations/{org}/user_settings -> customGroupAssignments
// which is empty for this account. That was wrong, and an empty server field alongside a fully
// grouped sidebar is the proof: the sidebar is not reading it. Membership lives in the
// `assignments` map of the local store named below — which is also why the two apps could
// disagree with each other about it, something a shared server store cannot produce.
//
// DELETIONS DO NOT PROPAGATE. "Absent on one side" cannot be told apart from "not yet added
// there", and there is no per-entry deletion clock, so this is additive: delete a group in one
// app and the next merge restores it from the other.
//
// READING NEEDS NO LOCK; WRITING DOES:
//
// LevelDB permits one process at a time — each app holds an exclusive whole-file fcntl(F_WRLCK)
// on its LOCK file for as long as it runs, verified with F_GETLK. So a profile can only be
// WRITTEN while its app is closed. Reading is done from a directory snapshot, which touches no
// lock, so the merge can always be computed even with both apps open; each profile is then
// written only if its app is closed, and skipped with a note if not. That is what makes this
// usable from run.sh: at launch this build is by definition closed so it always gets the merge,
// and Claude Desktop gets it too whenever it happens to be shut.
//
// WHAT IS MERGED, AND WHAT IS DELIBERATELY NOT:
//
//   merged   dframe-store -> state.customGroupsByScope   THE authority. Per account scope:
//                                                  groups (id+name), assignments (session ->
//                                                  group) and order (per-group session order).
//   merged   dframe-store -> state.groupByByMode   If it is not "custom" the groups exist but the
//                                                  sidebar does not group by them, so syncing the
//                                                  data without it can look like nothing happened.
//   written  LSS-persisted.dframe-group-scopes     the legacy mirror of the same model. Kept
//                                                  consistent, never read into the merge — see
//                                                  planMerge for what happens if you trust it.
//   merged   LSS-persisted.starred-session-groups  starred groups
//
//   left alone  the rest of dframe-store   sidebarWidth was 389 here and 280 there, and
//                                          collapsedGroups is which groups you have folded up:
//                                          genuine per-window preferences, not to be unified.
//   left alone  dframe-local-slice, LSS-sidebar-selected-mode
//                                          pinned-session order and which pane is open: local
//                                          layout, unrelated to groups.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { liveApps, CLAUDE_DESKTOP, buildApp, isRunning } from "./lib/procs.mjs";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const REAL = path.join(os.homedir(), "Library/Application Support/Claude/Local Storage/leveldb");
const BUILD = path.join(REPO, "user-data/Local Storage/leveldb");

const DRY = process.argv.includes("--dry-run");
// From run.sh. The report is still printed — it is the launch's only visibility into this —
// but nothing here is worth aborting a launch for, so failures become notes and exit 0.
const LAUNCH = process.argv.includes("--launch");

// Chromium Local Storage key layout: "_" + origin + NUL + <encoding byte> + key name.
const ORIGIN = Buffer.concat([Buffer.from("_https://claude.ai", "latin1"), Buffer.from([0x00])]);

export const SCOPES_KEY = "LSS-persisted.dframe-group-scopes";
export const STARRED_KEY = "LSS-persisted.starred-session-groups";
export const STORE_KEY = "dframe-store";
export const GROUPING_KEYS = [SCOPES_KEY, STARRED_KEY, STORE_KEY];

export function keyName(k) {
  if (k.length <= ORIGIN.length + 1) return null;
  if (!k.subarray(0, ORIGIN.length).equals(ORIGIN)) return null;
  return k.subarray(ORIGIN.length + 1).toString("utf8"); // skip the encoding byte
}

export function encodeKey(name) {
  return Buffer.concat([ORIGIN, Buffer.from([0x01]), Buffer.from(name, "utf8")]);
}

// A value's first byte is its encoding tag. Chromium's own rule: Latin-1 when every code unit
// fits in a byte, UTF-16LE otherwise. Following it matters — writing UTF-16 text under the
// Latin-1 tag is how a group named with an emoji comes back as mojibake.
export function encodeValue(text) {
  const latin1 = ![...text].some((c) => c.codePointAt(0) > 0xff);
  return latin1
    ? Buffer.concat([Buffer.from([0x01]), Buffer.from(text, "latin1")])
    : Buffer.concat([Buffer.from([0x00]), Buffer.from(text, "utf16le")]);
}

export function decodeValue(buf) {
  if (!buf?.length) return "";
  return buf[0] === 0x00 ? buf.subarray(1).toString("utf16le") : buf.subarray(1).toString("latin1");
}

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// The merge. Pure functions over parsed JSON, so the interesting logic is testable with no
// LevelDB anywhere near it.
// ---------------------------------------------------------------------------------------------

// The LSS- wrapper is {value, tabId, timestamp}. tabId is profile-local and stays with its own
// profile; timestamp is the only clock available, and arbitrates genuine conflicts.
export const clock = (w) => (typeof w?.timestamp === "number" ? w.timestamp : 0);

// Union arrays of {id, name}, first-seen order. Same id with different names: the newer side's
// name wins, so a rename travels instead of producing a duplicate group.
export function mergeGroups(aGroups = [], bGroups = [], aNewer = true) {
  const [first, second] = aNewer ? [aGroups, bGroups] : [bGroups, aGroups];
  const byId = new Map();
  for (const g of first || []) if (g?.id) byId.set(g.id, { ...g });
  for (const g of second || []) if (g?.id && !byId.has(g.id)) byId.set(g.id, { ...g });
  return [...byId.values()];
}

// session -> group id. Additions from both sides; the newer side wins a real disagreement.
export function mergeAssignments(a = {}, b = {}, aNewer = true) {
  return aNewer ? { ...b, ...a } : { ...a, ...b };
}

// { groupId: [sessionId, ...] }. Within a group the newer side's ordering leads and the other
// side's extra sessions are appended, so neither side loses a session it had placed.
export function mergeOrder(a = {}, b = {}, aNewer = true) {
  const out = {};
  for (const gid of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const [lead, rest] = aNewer ? [a?.[gid] || [], b?.[gid] || []] : [b?.[gid] || [], a?.[gid] || []];
    const seen = new Set(lead);
    out[gid] = [...lead, ...rest.filter((s) => !seen.has(s))];
  }
  return out;
}

// The whole grouping key: accountScope -> {groups, assignments, order}. Scopes are unioned too,
// so an account only ever used in one app still shows up in the other.
export function mergeScopes(aWrap, bWrap) {
  if (!aWrap?.value) return bWrap?.value ? { ...bWrap.value } : null;
  if (!bWrap?.value) return { ...aWrap.value };
  const aNewer = clock(aWrap) >= clock(bWrap);
  const a = aWrap.value;
  const b = bWrap.value;
  const out = {};
  for (const scope of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const sa = a[scope] || {};
    const sb = b[scope] || {};
    out[scope] = {
      groups: mergeGroups(sa.groups, sb.groups, aNewer),
      assignments: mergeAssignments(sa.assignments, sb.assignments, aNewer),
      order: mergeOrder(sa.order, sb.order, aNewer),
    };
  }
  return out;
}

export function mergeStarred(aWrap, bWrap) {
  const a = Array.isArray(aWrap?.value) ? aWrap.value : [];
  const b = Array.isArray(bWrap?.value) ? bWrap.value : [];
  return [...new Set([...a, ...b])];
}

// dframe-store is {state, version} with no timestamp of its own. Two of its fields are
// grouping-related; everything else in state is left exactly as each target had it.
export function mergeGroupBy(aStore, bStore, aNewer = true) {
  const a = aStore?.state?.groupByByMode || {};
  const b = bStore?.state?.groupByByMode || {};
  return aNewer ? { ...b, ...a } : { ...a, ...b };
}

// The scope map as the CURRENT store holds it, in dframe-store.state.customGroupsByScope. Same
// {groups, assignments, order} shape as the legacy key, so the same primitives apply.
export function mergeScopeMaps(a, b, aNewer = true) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out = {};
  for (const scope of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const sa = a[scope] || {};
    const sb = b[scope] || {};
    out[scope] = {
      groups: mergeGroups(sa.groups, sb.groups, aNewer),
      assignments: mergeAssignments(sa.assignments, sb.assignments, aNewer),
      order: mergeOrder(sa.order, sb.order, aNewer),
    };
  }
  return out;
}

// Given both profiles' raw key text, produce the text to write to each. A key is omitted when
// that profile already holds the merged payload, so a settled pair of profiles writes nothing.
//
// WHICH KEY IS AUTHORITATIVE, learned by watching the app undo a write:
//
// The first version of this merged only LSS-persisted.dframe-group-scopes. Writing it while the
// app was closed verified fine, then the app launched and put its own value straight back —
// same key, a fresh timestamp and a new tabId, with the merge gone. That key is a LEGACY MIRROR
// the app regenerates from its store; dframe-store.state.customGroupsByScope is what the sidebar
// actually reads (dframe-store also carries pendingLegacyGroupMigration, the migration that
// moved it). Measured at the same moment, the two disagreed inside one profile: the mirror held
// 7 groups while the store held 8.
//
// So the merge is computed from the STORE on both sides, and the result is written to the store
// AND to the mirror. The mirror is written for consistency only — the app would rewrite it
// anyway — but it is never read into the merge, because it can be a lossy subset of the store
// and unioning it back in would resurrect whatever the store had legitimately dropped.
//
// That also corrected the size of the problem. On the mirror the profiles looked like 8 groups
// vs 7; on the store both already had all 8 and the real divergence was in membership — 69
// assignments against 61.
export function planMerge(realText, buildText) {
  const rScopes = parse(realText[SCOPES_KEY]);
  const bScopes = parse(buildText[SCOPES_KEY]);
  const rStar = parse(realText[STARRED_KEY]);
  const bStar = parse(buildText[STARRED_KEY]);
  const rStore = parse(realText[STORE_KEY]);
  const bStore = parse(buildText[STORE_KEY]);

  // The only clock either side has is the mirror's LSS- timestamp. It is a weak one — the app
  // rewrites the mirror at launch, so it advances without the grouping having changed — but it
  // only decides genuine conflicts, of which there were none: the two profiles' assignment sets
  // were disjoint. Additions from both sides survive regardless of which way this points.
  const realNewer = clock(rScopes) >= clock(bScopes);
  const scopes = mergeScopeMaps(rStore?.state?.customGroupsByScope, bStore?.state?.customGroupsByScope, realNewer);
  const starred = mergeStarred(rStar, bStar);
  const groupBy = mergeGroupBy(rStore, bStore, realNewer);
  const stamp = Math.max(clock(rScopes), clock(bScopes), clock(rStar), clock(bStar));

  const wrapped = (wrap, value) => JSON.stringify({ value, tabId: wrap?.tabId ?? null, timestamp: stamp });

  // A key absent from a profile is only created when the merge actually has something to put in
  // it. Otherwise a pair of profiles that never starred a group would each gain an empty starred
  // key on the first run — a write that changes nothing and invents state neither app wrote.
  const changed = (own, mergedValue, empty) =>
    own ? JSON.stringify(mergedValue) !== JSON.stringify(own.value) : !empty;

  const forSide = (ownScopes, ownStar, ownStore) => {
    const out = {};
    const mirrorDiffers = ownScopes ? canonicalScopes(ownScopes.value) !== canonicalScopes(scopes) : !!scopes;
    if (scopes && mirrorDiffers) out[SCOPES_KEY] = wrapped(ownScopes, scopes);
    if (changed(ownStar, starred, starred.length === 0)) out[STARRED_KEY] = wrapped(ownStar, starred);
    // The store is the one that matters, so it is rewritten whenever either grouping field in it
    // differs — and only those two fields change. sidebarWidth, collapsedGroups, the pinned order
    // and everything else are carried through from this profile untouched.
    if (ownStore?.state) {
      const sameScopes = canonicalScopes(ownStore.state.customGroupsByScope) === canonicalScopes(scopes);
      const sameGroupBy = JSON.stringify(ownStore.state.groupByByMode || {}) === JSON.stringify(groupBy);
      if (!sameScopes || !sameGroupBy) {
        out[STORE_KEY] = JSON.stringify({
          ...ownStore,
          state: { ...ownStore.state, customGroupsByScope: scopes ?? ownStore.state.customGroupsByScope, groupByByMode: groupBy },
        });
      }
    }
    return out;
  };

  return {
    merged: { scopes, starred, groupBy },
    real: forSide(rScopes, rStar, rStore),
    build: forSide(bScopes, bStar, bStore),
  };
}

// Compare two scope maps by MEANING, not by byte layout. JSON.stringify is key-order sensitive
// and the merge necessarily reorders: mergeAssignments spreads one side over the other, so the
// keys come out in a different sequence from the one the app wrote even when every entry is
// identical. Comparing raw text therefore reported "differs" forever and rewrote both profiles on
// every single run. Group ORDER is display state and stays significant; assignment and order-map
// KEY order is not, so it is normalised away.
export function canonicalScopes(value) {
  if (!value) return "null";
  const sortKeys = (o) =>
    Object.fromEntries(
      Object.entries(o || {})
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, v]),
    );
  const scopes = {};
  for (const scope of Object.keys(value).sort()) {
    const s = value[scope] || {};
    scopes[scope] = {
      groups: (s.groups || []).map((g) => [g.id, g.name]), // array order is meaningful
      assignments: sortKeys(s.assignments),
      order: sortKeys(s.order),
    };
  }
  return JSON.stringify(scopes);
}

// For the report: how many groups / assignments a parsed scopes value describes.
export function countScopes(value) {
  let groups = 0;
  let assignments = 0;
  for (const s of Object.values(value || {})) {
    groups += (s.groups || []).length;
    assignments += Object.keys(s.assignments || {}).length;
  }
  return { groups, assignments };
}

// ---------------------------------------------------------------------------------------------
// LevelDB access
// ---------------------------------------------------------------------------------------------

async function openDb(dir) {
  const { ClassicLevel } = await import("classic-level");
  const db = new ClassicLevel(dir, { keyEncoding: "buffer", valueEncoding: "buffer" });
  try {
    await db.open();
  } catch (e) {
    // LevelDB reports a held lock as a generic "Database failed to open" several frames deep.
    // Turn it into something that says what is wrong and can be handled by the caller.
    const locked = e?.cause?.code === "LEVEL_LOCKED" || /lock/i.test(String(e?.cause || ""));
    if (!locked) throw e;
    const err = new Error(`another process holds the LevelDB lock on ${dir}`);
    err.locked = true;
    throw err;
  }
  return db;
}

// Read from a COPY, so a running app is no obstacle: nothing here touches the LOCK file. The
// copy also absorbs the recovery writes that opening a mid-write database performs.
async function readSnapshot(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grouping-snap-"));
  try {
    fs.cpSync(dir, path.join(tmp, "leveldb"), { recursive: true });
    const db = await openDb(path.join(tmp, "leveldb"));
    const out = {};
    try {
      for await (const [k, v] of db.iterator()) {
        const name = keyName(k);
        if (name && GROUPING_KEYS.includes(name)) out[name] = decodeValue(v);
      }
    } finally {
      await db.close();
    }
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function writeKeys(dir, entries) {
  const db = await openDb(dir);
  try {
    const batch = db.batch();
    for (const [name, text] of Object.entries(entries)) batch.put(encodeKey(name), encodeValue(text));
    await batch.write();
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------------------------

const say = (...a) => console.log(...a);
const bail = (msg) => {
  (LAUNCH ? console.log : console.error)(msg);
  process.exit(LAUNCH ? 0 : 1);
};

async function main() {
  for (const [label, dir] of [["Claude Desktop", REAL], ["this build", BUILD]]) {
    if (!fs.existsSync(dir)) bail(`no Local Storage for ${label} at ${dir}`);
  }

  let realText, buildText;
  try {
    realText = await readSnapshot(REAL);
    buildText = await readSnapshot(BUILD);
  } catch (e) {
    if (String(e).includes("classic-level")) bail("this needs the classic-level package:  npm install classic-level");
    if (e.locked) bail(`grouping sync: ${e.message}`);
    throw e;
  }

  const plan = planMerge(realText, buildText);
  // Counted from the store, which is the side the sidebar reads — the mirror can disagree.
  const r = countScopes(parse(realText[STORE_KEY])?.state?.customGroupsByScope);
  const b = countScopes(parse(buildText[STORE_KEY])?.state?.customGroupsByScope);
  const m = countScopes(plan.merged.scopes);
  say(
    `grouping: Claude Desktop ${r.groups}g/${r.assignments}a · this build ${b.groups}g/${b.assignments}a` +
      ` -> merged ${m.groups}g/${m.assignments}a`,
  );

  const targets = [
    ["Claude Desktop", REAL, plan.real, () => isRunning(CLAUDE_DESKTOP)],
    ["this build", BUILD, plan.build, () => isRunning(buildApp(REPO))],
  ];

  let wrote = 0;
  for (const [label, dir, changes, live] of targets) {
    const names = Object.keys(changes);
    if (!names.length) {
      say(`  ${label}: already up to date`);
      continue;
    }
    if (DRY) {
      say(`  ${label}: would write ${names.join(", ")}`);
      continue;
    }
    if (live()) {
      say(`  ${label}: ${names.length} key(s) pending — skipped, it is running. Quit it and re-run.`);
      continue;
    }
    // Back up the whole directory first: a partial LevelDB write is not something to be brave
    // about, and .sync records an incident where a bad Local Storage left the app hanging.
    const backup = `${path.dirname(dir)}.grouping-bak`;
    fs.rmSync(backup, { recursive: true, force: true });
    fs.cpSync(path.dirname(dir), backup, { recursive: true });
    try {
      await writeKeys(dir, changes);
    } catch (e) {
      if (e.locked) {
        say(`  ${label}: locked by a running app — skipped.`);
        continue;
      }
      throw e;
    }
    // Read back, so success is verified rather than assumed.
    const after = await readSnapshot(dir);
    const bad = names.filter((n) => after[n] !== changes[n]);
    if (bad.length) {
      console.error(`  ${label}: ${bad.join(", ")} did not verify. Restore with:`);
      console.error(`    rm -rf "${path.dirname(dir)}" && mv "${backup}" "${path.dirname(dir)}"`);
      process.exit(1);
    }
    say(`  ${label}: wrote ${names.join(", ")}  (backup: ${path.basename(backup)})`);
    wrote += names.length;
  }

  const stillLive = liveApps(REPO);
  if (!DRY && wrote && stillLive.length) {
    say(`  note: ${stillLive.join(" and ")} still running — relaunch to pick the merge up.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
