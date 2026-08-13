// What actually answered each session, recorded where it cannot be lost.
//
// THE PROBLEM. A session's stored `model` is the identity the CLIENT selected — `claude-opus-4-8`,
// or whatever the picker last showed. In OpenAI mode that is not what answered. Six different
// things were collapsed into that one field, and the log line was the only place any of them
// appeared:
//
//   session-selected model   claude-opus-4-8        what the user picked
//   capability identity      claude-opus-4-8[1m]    what set the context window
//   wire model               claude-opus-4-8        what arrived on /v1/messages
//   resolved upstream model  gpt-5.6-sol            what actually answered
//   API surface              responses              which translation ran
//   route                    main | safety:block    which policy applied
//
// So "which model wrote this?" could not be answered after the fact, and neither could "was this
// session Anthropic or OpenAI?" — which matters because the two produce different work and the
// transcript looks identical either way. Three sessions in this repository's own history were
// misattributed while investigating exactly that.
//
// WHY A SIDECAR, AND NOT THE SESSION FILE. The session store is a SYMLINK to the real Claude
// Desktop install's directory (issue #3), so both applications read and write the same files.
// Adding fields to them means betting that two proprietary apps preserve unknown keys through a
// round trip. That bet is untested here — proving it needs an isolated fixture copy and a run of
// both apps, not an experiment against the live shared store — so the sidecar is AUTHORITATIVE and
// nothing is mirrored into session JSON. If the round trip is ever proven safe, mirroring becomes
// an addition; until then, writing there could silently destroy the other app's data.
//
// KEYED BY THE CLI SESSION ID, which the client hands over on every request:
//   x-claude-code-session-id: 0bfac150-a1d5-4253-86c7-2236cb2f8768
// Captured from the real client against a header-logging server. The proxy had been discarding it,
// which is why it had no session identity to attribute anything to and why the prompt-cache hash
// was the only thing resembling one. A cache hash is not identity — it collides across forks and
// changes within a session — so it must never be used as one.
//
// APPEND-ONLY. Creation provenance is immutable; every later change appends an epoch. Rewriting a
// session's provider to "current" would erase the fact that half of it was answered by something
// else, which is the exact question this file exists to answer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Resolved LAZILY, per call, not once at module load.
//
// PROXY_PROVENANCE_DIR redirects the store so a test writes somewhere that is not the developer's
// own records. As a module-level constant that did not work, and failed in the worst direction: ESM
// evaluates static imports before any statement in the importing file, so a test setting the
// variable and then importing the proxy got the REAL directory — and its assertions failed while it
// quietly wrote into the repository. A function cannot be captured too early.
export const defaultDir = () => process.env.PROXY_PROVENANCE_DIR || path.join(REPO, "provenance");
// Kept for callers that want the path for a message. Do not use it as a default argument.
export const DIR = path.join(REPO, "provenance");
export const SCHEMA_VERSION = 1;

// One file per session. A single shared file would serialise every write and make one corruption
// lose the lot; per-session files also mean a concurrent write touches different inodes.
export const fileFor = (cliSessionId, dir = defaultDir()) =>
  path.join(dir, `${sanitizeId(cliSessionId)}.json`);

// The id comes from a request header, so it is untrusted input that becomes a FILENAME. Anything
// outside the shape of a uuid is rejected rather than escaped — a header saying
// `../../../etc/passwd` must not be able to choose a path.
export function sanitizeId(id) {
  const s = String(id ?? "");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s) || s === "." || s === "..") return null;
  return s;
}

// Bounded. A long-running session makes an epoch per genuine change, not per turn, but a
// pathological loop must not grow a file without limit. The oldest epochs are dropped and the drop
// is recorded, so a truncated history never reads as a complete one.
export const MAX_EPOCHS = 200;

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);            // rename is the commit; a reader sees old or new, never half
}

export function read(cliSessionId, dir = defaultDir()) {
  const id = sanitizeId(cliSessionId);
  if (!id) return null;
  const file = fileFor(id, dir);
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    // Corrupt. Keep the evidence rather than deleting it — a truncated provenance file is itself a
    // fact about a crash — and let the caller start a fresh record beside it.
    try { fs.renameSync(file, `${file}.corrupt`); } catch { /* best effort */ }
    return null;
  }
  if (parsed?.version !== SCHEMA_VERSION) {
    // A future version is not ours to interpret and must not be overwritten with an older shape.
    if (typeof parsed?.version === "number" && parsed.version > SCHEMA_VERSION)
      return { ...parsed, unreadable: `written by schema version ${parsed.version}` };
    return null;                        // older: nothing to migrate from yet
  }
  return parsed;
}

// The dimensions that define "what is answering". Two records with the same fingerprint describe
// the same setup, so nothing is appended — otherwise a busy session would write a file per turn.
export function fingerprint(e = {}) {
  return [
    e.provider, e.wireModel, e.resolvedModel, e.apiSurface, e.route,
    e.capabilityIdentity, e.contextBound, e.configHash, e.codeVersion, e.source,
  ].map((v) => (v === undefined || v === null ? "" : String(v))).join("|");
}

// Record an epoch, if it says something new.
//
// Returns { written, reason, record }. `written: false` with reason "unchanged" is the common case
// and is not a failure.
export function record(cliSessionId, epoch, { dir = defaultDir(), now = null } = {}) {
  const id = sanitizeId(cliSessionId);
  if (!id) return { written: false, reason: "unusable session id", record: null };
  const at = now || new Date().toISOString();

  const existing = read(id, dir);
  if (existing?.unreadable)
    return { written: false, reason: existing.unreadable, record: existing };

  const entry = { at, ...epoch };
  if (!existing) {
    const rec = {
      version: SCHEMA_VERSION,
      cliSessionId: id,
      // Filled in by the launcher when it knows the Desktop's own id; the proxy never learns it,
      // and guessing would attach one session's history to another.
      sessionId: epoch.sessionId ?? null,
      // IMMUTABLE. What was true when the session was first seen.
      created: { ...entry, kind: "created" },
      epochs: [{ ...entry, kind: epoch.kind || "created" }],
      droppedEpochs: 0,
    };
    atomicWrite(fileFor(id, dir), rec);
    return { written: true, reason: "new session", record: rec };
  }

  const last = existing.epochs?.[existing.epochs.length - 1];
  if (last && fingerprint(last) === fingerprint(entry))
    return { written: false, reason: "unchanged", record: existing };

  // A cross-provider resume: the same session answered by Anthropic and then by OpenAI, or the
  // reverse. Worth surfacing rather than just recording, because the two produce different work and
  // the transcript looks identical either way — and because a model id persisted under one provider
  // is meaningless under the other.
  const providerSwitch = last?.provider && epoch.provider && last.provider !== epoch.provider
    ? { from: last.provider, to: epoch.provider }
    : null;
  const epochs = [...(existing.epochs || []), {
    ...entry, kind: epoch.kind || (providerSwitch ? "provider-switch" : "changed"),
  }];
  let dropped = existing.droppedEpochs || 0;
  while (epochs.length > MAX_EPOCHS) { epochs.shift(); dropped++; }
  const rec = {
    ...existing,
    // `created` is never touched, and a later launcher pass may fill in a sessionId that was
    // unknown at creation — but it may not CHANGE one that is already set.
    sessionId: existing.sessionId ?? epoch.sessionId ?? null,
    epochs,
    droppedEpochs: dropped,
  };
  atomicWrite(fileFor(id, dir), rec);
  return {
    written: true,
    reason: providerSwitch ? `provider switched ${providerSwitch.from} -> ${providerSwitch.to}`
                           : last ? "changed" : "first epoch",
    providerSwitch, record: rec,
  };
}

// Every session on disk, newest activity first. For the settings window and the CLI below.
export function list({ dir = defaultDir(), limit = 50 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const n of names) {
    const rec = read(n.replace(/\.json$/, ""), dir);
    if (!rec) continue;
    const last = rec.epochs?.[rec.epochs.length - 1] || rec.created || {};
    out.push({
      cliSessionId: rec.cliSessionId,
      sessionId: rec.sessionId ?? null,
      createdAt: rec.created?.at ?? null,
      lastAt: last.at ?? null,
      provider: last.provider ?? null,
      resolvedModel: last.resolvedModel ?? null,
      wireModel: last.wireModel ?? null,
      capabilityIdentity: last.capabilityIdentity ?? null,
      apiSurface: last.apiSurface ?? null,
      epochs: rec.epochs?.length ?? 0,
      droppedEpochs: rec.droppedEpochs ?? 0,
      // A session whose provider changed part-way is the case a single "current provider" field
      // would have erased, so it is surfaced rather than reduced.
      // Every provider this session has been answered by, so a mid-session switch cannot be
      // flattened into "current". A "current provider" field would erase exactly this.
      providersSeen: [...new Set((rec.epochs || []).map((e) => e.provider).filter(Boolean))],
      switches: (rec.epochs || []).filter((e) => e.kind === "provider-switch").length,
      modelsSeen: [...new Set((rec.epochs || []).map((e) => e.resolvedModel).filter(Boolean))],
    });
  }
  out.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return out.slice(0, limit);
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const arg = process.argv[2];
  if (arg && arg !== "--list") {
    const rec = read(arg);
    process.stdout.write(rec ? JSON.stringify(rec, null, 2) + "\n" : `no provenance for ${arg}\n`);
    process.exitCode = rec ? 0 : 1;
  } else {
    const rows = list({ limit: 200 });
    if (!rows.length) process.stdout.write("no provenance recorded yet\n");
    for (const r of rows) {
      const mixed = r.providersSeen.length > 1 ? `  MIXED PROVIDERS: ${r.providersSeen.join(",")}` : "";
      process.stdout.write(
        `${r.lastAt || "?"}  ${r.cliSessionId}  ${r.provider || "?"}  ` +
        `${r.wireModel || "?"} -> ${r.resolvedModel || "?"}  ` +
        `[${r.capabilityIdentity || "?"}]  ${r.apiSurface || "?"}  ` +
        `epochs=${r.epochs}${r.droppedEpochs ? `(+${r.droppedEpochs} dropped)` : ""}${mixed}\n`);
    }
  }
}
