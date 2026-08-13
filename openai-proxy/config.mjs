// The one place that decides what the proxy is configured to do.
//
// WHY THIS EXISTS. The settings used to be forty separate expressions at the top of
// proxy.mjs, each spelling out its own precedence inline:
//
//   const VERBOSITY = process.env.OPENAI_VERBOSITY || PROJECT.OPENAI_VERBOSITY || "high";
//
// That works, and it is readable, but nothing outside the process could answer "what is
// this proxy actually running?" — so three things went wrong at once:
//
//   * run.sh reused ANY proxy that answered /health. Change a model, relaunch, and the old
//     process kept serving the old model while the launcher reported success. The config on
//     disk and the config in memory could disagree indefinitely.
//   * /health returned a default model and nothing else, so the settings window showed what
//     was CONFIGURED and called it what was RUNNING.
//   * a proxy found on the port had no identity at all. On 08-13 a crashed proxy left the
//     port free and a hand-started replacement ran as PPID 1, which is indistinguishable
//     from a foreign process to anything trying to decide whether it may restart it.
//
// So: one declarative table, one resolver, and a hash of the result. The hash is what lets
// the launcher tell "already running what I want" from "running something else".
//
// PRECEDENCE IS PRESERVED EXACTLY, NOT TIDIED. This file was extracted from the working
// expressions, quirks included, because a config refactor that also changes behaviour is
// two changes wearing one coat. Two of those quirks are real inconsistencies, marked
// QUIRK below; they are recorded here rather than fixed so that fixing them is a separate,
// visible decision with its own test.
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------- sources ----------

// KEY=VALUE, `#` comments, blank lines ignored. Identical to the parser this replaces and to
// settings/config.js's, deliberately: three parsers for one file format is how a value reads
// differently depending on who asked.
export function loadKV(path) {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* file may be absent — that's fine */ }
  return cfg;
}

export const HOME_FILE = os.homedir() + "/.dbeaver-ai-complete";
export const PROJECT_FILE = fileURLToPath(new URL("../.openai-model", import.meta.url));
export const PROVIDER_FILE = fileURLToPath(new URL("../.provider", import.meta.url));

// ---------- types ----------
//
// Each type reproduces one of the coercion shapes used inline before. `zero` is not
// decoration: `parseInt(x, 10) || 8192` swallows both NaN AND a real 0, and the value it
// swallows to differs per setting. Spelling it out per setting is the only way to move the
// expression without moving its behaviour.
const TYPES = {
  // First non-empty source wins; `default` may itself be "".
  str: (raw, s) => (raw === undefined || raw === "" ? s.default : raw),
  // parseInt over the first non-empty source, then `|| zero`.
  int: (raw, s) => {
    const n = parseInt(raw === undefined || raw === "" ? s.default : raw, 10);
    return "zero" in s ? (n || s.zero) : n;
  },
  // "anything but the string 0 is true" — including "false", "no" and "off". That is what
  // the inline `!== "0"` meant, so that is what this means.
  bool01: (raw, s) => (raw === undefined || raw === "" ? s.default : raw) !== "0",
  // Opt-IN diagnostics: only the exact string "1" enables them.
  flag1: (raw) => raw === "1",
};

// ---------- the table ----------
//
// `env`      environment variable, always highest precedence
// `project`  key(s) in ./.openai-model, in order — a list where an older key name is still
//            honoured (OPENAI_MODEL then the legacy `model`)
// `home`     key in ~/.dbeaver-ai-complete. That file belongs to DBeaver; only the three
//            keys listed here are read from it, and `maxTokens` is deliberately NOT one of
//            them (it carries 512, which starves an agent request that omits max_tokens).
// `secret`   never appears in a snapshot, a log, or the hash input — only its fingerprint
// `derived`  computed from other settings; see resolve()
//
// A setting with no `project` is environment-only. That asymmetry is inherited: these are
// the wire-level and probe-level knobs that were never meant to be persisted per project,
// and the settings window does not offer them.
export const SETTINGS = [
  { name: "OPENAI_API_KEY", env: "OPENAI_API_KEY", project: ["apiKey"], home: "apiKey",
    type: "str", default: "", secret: true },

  { name: "OPENAI_MODEL", env: "OPENAI_MODEL", project: ["OPENAI_MODEL", "model"], home: "model",
    type: "str", default: "gpt-4.1" },
  // Depends on OPENAI_MODEL, so it is resolved after the plain settings. Only 'codex' names
  // auto-select Responses; everything else lands on Chat Completions unless set explicitly.
  { name: "OPENAI_API", env: "OPENAI_API", project: ["OPENAI_API"], derived: true },

  { name: "OPENAI_CLASSIFIER_MODEL", env: "OPENAI_CLASSIFIER_MODEL",
    project: ["OPENAI_CLASSIFIER_MODEL"], type: "str", default: "" },
  // KNOWN DEFECT, preserved here and fixed in the classifier-routing phase. Both the settings
  // help and this setting's own comment history promise that blank means "use the main model
  // and accept the latency". It does not: blank is falsy, so `||` walks past it to the default
  // and you silently get gpt-5.4. Honouring blank needs "defined but empty" to be
  // distinguishable from absent, which is a resolver change with a safety-critical blast
  // radius, so it belongs in the phase that owns classifier routing — not smuggled into a
  // config extraction that is supposed to change nothing.
  { name: "OPENAI_CLASSIFIER_SAFETY_MODEL", env: "OPENAI_CLASSIFIER_SAFETY_MODEL",
    project: ["OPENAI_CLASSIFIER_SAFETY_MODEL"], type: "str", default: "gpt-5.4" },
  // zero: 0 — "0 would be defensible" is the comment on the original, and 0 tools is a
  // coherent setting, so a literal 0 must survive rather than snapping back to 4.
  { name: "OPENAI_CLASSIFIER_MAX_TOOLS", env: "OPENAI_CLASSIFIER_MAX_TOOLS",
    project: ["OPENAI_CLASSIFIER_MAX_TOOLS"], type: "int", default: "4", zero: 0 },
  { name: "OPENAI_CLASSIFIER_SLOW_MS", env: "OPENAI_CLASSIFIER_SLOW_MS",
    project: ["OPENAI_CLASSIFIER_SLOW_MS"], type: "int", default: "20000", zero: 20000 },

  { name: "OPENAI_PICKER_MODELS", env: "OPENAI_PICKER_MODELS", project: ["OPENAI_PICKER_MODELS"],
    type: "str",
    // The answering model must be in this list or the picker cannot offer what is actually
    // running — gpt-5.6-sol was once the default while missing from here, so /v1/models
    // advertised five models, none of them the one answering.
    default: "gpt-5.6-sol:GPT-5.6 Sol,gpt-5.5:GPT-5.5,gpt-5.3-codex:GPT-5.3 Codex," +
             "gpt-5.4:GPT-5.4,gpt-4.1:GPT-4.1,gpt-4.1-mini:GPT-4.1 mini,gpt-4o:GPT-4o" },

  { name: "OPENAI_BASE_URL", env: "OPENAI_BASE_URL", type: "str",
    default: "https://api.openai.com/v1" },
  { name: "PORT", env: "PORT", type: "int", default: "8123" },   // no `zero`: see resolve()

  { name: "OPENAI_DEFAULT_MAX_TOKENS", env: "OPENAI_DEFAULT_MAX_TOKENS",
    project: ["OPENAI_DEFAULT_MAX_TOKENS"], type: "int", default: "8192", zero: 8192 },
  { name: "OPENAI_MAX_OUTPUT_TOKENS", env: "OPENAI_MAX_OUTPUT_TOKENS",
    type: "int", default: "32768", zero: 32768 },
  { name: "OPENAI_MAX_TURN_OUTPUT_TOKENS", env: "OPENAI_MAX_TURN_OUTPUT_TOKENS",
    project: ["OPENAI_MAX_TURN_OUTPUT_TOKENS"], type: "int", default: "56000", zero: 56000 },
  // Chat Completions rejects a 129th tool; Responses showed no cap when probed to 512.
  { name: "OPENAI_MAX_TOOLS", env: "OPENAI_MAX_TOOLS", type: "int", default: "128", zero: 128 },
  { name: "OPENAI_MAX_TOOLS_RESPONSES", env: "OPENAI_MAX_TOOLS_RESPONSES",
    type: "int", default: "0", zero: Infinity },

  { name: "OPENAI_OUTPUT_FIXUPS", env: "OPENAI_OUTPUT_FIXUPS", project: ["OPENAI_OUTPUT_FIXUPS"],
    type: "bool01", default: "1" },
  { name: "OPENAI_PERSISTENCE", env: "OPENAI_PERSISTENCE", project: ["OPENAI_PERSISTENCE"],
    type: "bool01", default: "1" },
  { name: "OPENAI_SHOW_THINKING", env: "OPENAI_SHOW_THINKING", project: ["OPENAI_SHOW_THINKING"],
    type: "bool01", default: "1" },
  { name: "OPENAI_REASONING_EFFORT", env: "OPENAI_REASONING_EFFORT",
    project: ["OPENAI_REASONING_EFFORT"], type: "str", default: "medium" },
  // QUIRK: default is 4000 but an explicit 0 resolves to 2000, not 4000. Preserved from the
  // original expression `parseInt(... || "4000", 10) || 2000`. Either number is defensible
  // as a floor; having two is not. Left alone here so the change is its own decision.
  { name: "OPENAI_THINKING_MIN_BUDGET", env: "OPENAI_THINKING_MIN_BUDGET",
    project: ["OPENAI_THINKING_MIN_BUDGET"], type: "int", default: "4000", zero: 2000 },
  { name: "OPENAI_VERBOSITY", env: "OPENAI_VERBOSITY", project: ["OPENAI_VERBOSITY"],
    type: "str", default: "high" },

  { name: "OPENAI_EMPTY_RETRY", env: "OPENAI_EMPTY_RETRY", project: ["OPENAI_EMPTY_RETRY"],
    type: "bool01", default: "1" },
  { name: "OPENAI_MAX_EMPTY_RETRIES", env: "OPENAI_MAX_EMPTY_RETRIES",
    project: ["OPENAI_MAX_EMPTY_RETRIES"], type: "int", default: "2", zero: 0 },
  { name: "OPENAI_CONTINUE_ON_TRUNCATION", env: "OPENAI_CONTINUE_ON_TRUNCATION",
    project: ["OPENAI_CONTINUE_ON_TRUNCATION"], type: "bool01", default: "1" },
  { name: "OPENAI_MAX_TRANSPORT_RETRIES", env: "OPENAI_MAX_TRANSPORT_RETRIES",
    project: ["OPENAI_MAX_TRANSPORT_RETRIES"], type: "int", default: "2", zero: 0 },
  { name: "OPENAI_AUTO_CONTINUE", env: "OPENAI_AUTO_CONTINUE", project: ["OPENAI_AUTO_CONTINUE"],
    type: "bool01", default: "1" },
  // QUIRK: zero 2, so OPENAI_MAX_CONTINUATIONS=0 does NOT disable auto-continue — it resolves
  // back to 2. OPENAI_AUTO_CONTINUE=0 is the off switch. Preserved from the original.
  { name: "OPENAI_MAX_CONTINUATIONS", env: "OPENAI_MAX_CONTINUATIONS",
    project: ["OPENAI_MAX_CONTINUATIONS"], type: "int", default: "2", zero: 2 },
  { name: "OPENAI_TASK_ECHO", env: "OPENAI_TASK_ECHO", project: ["OPENAI_TASK_ECHO"],
    type: "bool01", default: "1" },

  { name: "OPENAI_MAX_TEXT_CHARS", env: "OPENAI_MAX_TEXT_CHARS", project: ["OPENAI_MAX_TEXT_CHARS"],
    type: "int", default: "400000", zero: 400000 },
  { name: "OPENAI_COMPACT_SUMMARY", env: "OPENAI_COMPACT_SUMMARY",
    project: ["OPENAI_COMPACT_SUMMARY"], type: "bool01", default: "1" },
  // Falls back to the prefix-classifier model before its own default: both want "small and
  // fast", so configuring one used to configure the other. Derived for that reason.
  { name: "OPENAI_COMPACT_MODEL", env: "OPENAI_COMPACT_MODEL", project: ["OPENAI_COMPACT_MODEL"],
    derived: true },

  // Client-side capability identity and context bound. The proxy only reports these; the
  // launcher and the disclaimer helper are what apply them.
  { name: "OPENAI_CLAUDE_CODE_MODEL", env: "OPENAI_CLAUDE_CODE_MODEL",
    project: ["OPENAI_CLAUDE_CODE_MODEL"], type: "str", default: "" },
  { name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", env: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    project: ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], type: "int", default: "0", zero: 0 },

  // Diagnostics. In the hash because they change what the process does, even though nothing
  // user-visible depends on them.
  { name: "PROXY_DUMP_TOOLS", env: "PROXY_DUMP_TOOLS", type: "flag1" },
];

const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));

// ---------- resolution ----------

// Returns { values, sources } where sources[name] is "env" | "project" | "home" | "default",
// so a snapshot can say WHERE a value came from. That distinction is the whole point of item
// 6 of the phase: a one-launch `OPENAI_MODEL=x ./run.sh` override and a persisted setting look
// identical in the resolved value and could not be told apart before.
export function resolve({ env = process.env, project, home } = {}) {
  const P = project ?? loadKV(PROJECT_FILE);
  const H = home ?? loadKV(HOME_FILE);
  const values = {};
  const sources = {};

  // First non-empty wins. Empty string counts as absent, matching `||`.
  const pick = (s) => {
    if (s.env && env[s.env] !== undefined && env[s.env] !== "") return [env[s.env], "env"];
    for (const k of s.project || []) {
      if (P[k] !== undefined && P[k] !== "") return [P[k], "project"];
    }
    if (s.home && H[s.home] !== undefined && H[s.home] !== "") return [H[s.home], "home"];
    return [undefined, "default"];
  };

  for (const s of SETTINGS) {
    if (s.derived) continue;
    const [raw, src] = pick(s);
    values[s.name] = TYPES[s.type](raw, s);
    sources[s.name] = src;
  }

  // PORT has no `zero`, on purpose: the original `parseInt(process.env.PORT || "8123", 10)`
  // had no fallback either, so PORT=abc yields NaN and the listen fails loudly. Silently
  // serving on 8123 when asked for something else is worse — that is how you end up with two
  // proxies and a launcher that trusts the wrong one.
  values.OPENAI_BASE_URL = values.OPENAI_BASE_URL.replace(/\/$/, "");

  // Derived, in dependency order.
  const [apiRaw, apiSrc] = pick(BY_NAME.get("OPENAI_API"));
  values.OPENAI_API = (apiRaw || (/codex/i.test(values.OPENAI_MODEL) ? "responses" : "chat"))
    .toLowerCase();
  sources.OPENAI_API = apiRaw ? apiSrc : "derived";

  const [cmRaw, cmSrc] = pick(BY_NAME.get("OPENAI_COMPACT_MODEL"));
  values.OPENAI_COMPACT_MODEL = cmRaw || values.OPENAI_CLASSIFIER_MODEL || "gpt-4.1-mini";
  sources.OPENAI_COMPACT_MODEL = cmRaw ? cmSrc
    : values.OPENAI_CLASSIFIER_MODEL ? "OPENAI_CLASSIFIER_MODEL" : "default";

  // ~/.dbeaver-ai-complete only. Absent means "send no temperature", which is not the same
  // as sending 0, so undefined has to survive.
  values.DEFAULT_TEMP = H.temperature != null ? parseFloat(H.temperature) : undefined;
  sources.DEFAULT_TEMP = H.temperature != null ? "home" : "default";

  return { values, sources };
}

// One-way fingerprint. Enough to tell "the key changed" from "the key is the same", and not
// enough to be a key. Truncated to 12 hex characters for a log line; the input is a
// high-entropy secret, so this is not a guessable digest.
export function keyFingerprint(key) {
  if (!key) return "none";
  return "sha256:" + crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
}

// Version of the CODE, not the config. A proxy running last week's translation logic with
// this week's settings is stale even though every value matches, so the launcher has to be
// able to see that. Hashing the sources is exact and needs no version bumping by hand —
// which is the point, because a version constant nobody remembers to bump reports stale
// code as current.
let codeVersionMemo = null;
export function codeVersion() {
  if (codeVersionMemo) return codeVersionMemo;
  const h = crypto.createHash("sha256");
  for (const f of ["./proxy.mjs", "./config.mjs"]) {
    try { h.update(fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)))); }
    catch { h.update(f); }   // unreadable source still yields a stable, distinct version
  }
  return (codeVersionMemo = h.digest("hex").slice(0, 12));
}

export function provider(file = PROVIDER_FILE) {
  return loadKV(file).PROVIDER || "openai";
}

// A secret-redacted description of what this process will do. Safe to log, to serve from
// /health, and to show in the settings window.
export function snapshot(opts = {}) {
  const { values, sources } = opts.resolved || resolve(opts);
  const out = { provider: provider(), codeVersion: codeVersion(), settings: {} };
  for (const s of SETTINGS) {
    if (s.secret) continue;
    out.settings[s.name] = { value: values[s.name], source: sources[s.name] };
  }
  out.settings.DEFAULT_TEMP = { value: values.DEFAULT_TEMP, source: sources.DEFAULT_TEMP };
  out.apiKeyFingerprint = keyFingerprint(values.OPENAI_API_KEY);
  return out;
}

// Stable hash over everything that changes behaviour. Two proxies with the same hash are
// interchangeable; a different hash means the one on the port is not the one you asked for.
//
// The KEY ITSELF IS NEVER HASHED IN — its fingerprint is. A rotated key must invalidate the
// hash (otherwise the launcher keeps a proxy holding a revoked key), but the hash is printed
// in logs and served over HTTP, so it must not be a function of the secret. A sha256 of the
// key is not reversible; a sha256 of a structure containing the key would still be safe, but
// only by argument, and "safe by argument" is how secrets leak.
export function configHash(opts = {}) {
  const { values } = opts.resolved || resolve(opts);
  const material = { provider: provider(), codeVersion: codeVersion() };
  for (const s of SETTINGS) {
    material[s.name] = s.secret ? keyFingerprint(values[s.name])
      : values[s.name] === Infinity ? "Infinity"          // JSON.stringify would emit null
      : values[s.name];
  }
  material.DEFAULT_TEMP = values.DEFAULT_TEMP ?? null;
  return crypto.createHash("sha256")
    .update(JSON.stringify(material, Object.keys(material).sort()))
    .digest("hex").slice(0, 16);
}

// ---------- validation ----------
//
// Item 7 of the phase. Range and cross-field checks, returned rather than thrown: the proxy
// logs them and keeps going where it safely can, while the settings window refuses the write.
// A config that cannot work should say so at startup, not as a 400 an hour later.
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const APIS = ["chat", "responses"];
const VERBOSITIES = ["", "low", "medium", "high"];

export function validate(opts = {}) {
  const { values } = opts.resolved || resolve(opts);
  const errors = [];
  const warnings = [];
  const v = values;

  if (!Number.isInteger(v.PORT) || v.PORT < 1 || v.PORT > 65535)
    errors.push(`PORT must be 1-65535, got ${v.PORT}`);
  if (!APIS.includes(v.OPENAI_API))
    errors.push(`OPENAI_API must be one of ${APIS.join("|")}, got '${v.OPENAI_API}'`);
  if (!EFFORTS.includes(v.OPENAI_REASONING_EFFORT))
    errors.push(`OPENAI_REASONING_EFFORT must be one of ${EFFORTS.join("|")}, got '${v.OPENAI_REASONING_EFFORT}'`);
  if (!VERBOSITIES.includes(v.OPENAI_VERBOSITY))
    errors.push(`OPENAI_VERBOSITY must be one of ${VERBOSITIES.filter(Boolean).join("|")} or blank, got '${v.OPENAI_VERBOSITY}'`);
  if (!v.OPENAI_MODEL) errors.push("OPENAI_MODEL is empty");
  try { new URL(v.OPENAI_BASE_URL); } catch { errors.push(`OPENAI_BASE_URL is not a URL: '${v.OPENAI_BASE_URL}'`); }

  for (const k of ["OPENAI_MAX_TRANSPORT_RETRIES", "OPENAI_MAX_EMPTY_RETRIES",
                   "OPENAI_MAX_CONTINUATIONS", "OPENAI_CLASSIFIER_MAX_TOOLS"]) {
    if (v[k] < 0) errors.push(`${k} must be >= 0, got ${v[k]}`);
    if (v[k] > 100) warnings.push(`${k}=${v[k]} is unusually high; each unit can cost a full request`);
  }
  for (const k of ["OPENAI_DEFAULT_MAX_TOKENS", "OPENAI_MAX_OUTPUT_TOKENS",
                   "OPENAI_MAX_TURN_OUTPUT_TOKENS", "OPENAI_MAX_TEXT_CHARS"]) {
    if (!(v[k] > 0)) errors.push(`${k} must be > 0, got ${v[k]}`);
  }

  // Cross-field. Each of these is a configuration that parses fine and then misbehaves in a
  // way that is hard to attribute from the symptom.
  if (v.OPENAI_MAX_TURN_OUTPUT_TOKENS < v.OPENAI_MAX_OUTPUT_TOKENS)
    warnings.push(`OPENAI_MAX_TURN_OUTPUT_TOKENS (${v.OPENAI_MAX_TURN_OUTPUT_TOKENS}) is below the ` +
      `single-call cap OPENAI_MAX_OUTPUT_TOKENS (${v.OPENAI_MAX_OUTPUT_TOKENS}), so one call can exceed the turn budget`);
  if (v.OPENAI_DEFAULT_MAX_TOKENS > v.OPENAI_MAX_OUTPUT_TOKENS)
    warnings.push(`OPENAI_DEFAULT_MAX_TOKENS (${v.OPENAI_DEFAULT_MAX_TOKENS}) exceeds ` +
      `OPENAI_MAX_OUTPUT_TOKENS (${v.OPENAI_MAX_OUTPUT_TOKENS}) and will be clamped`);
  if (v.OPENAI_THINKING_MIN_BUDGET >= v.OPENAI_MAX_OUTPUT_TOKENS && v.OPENAI_SHOW_THINKING)
    warnings.push(`OPENAI_THINKING_MIN_BUDGET (${v.OPENAI_THINKING_MIN_BUDGET}) is at or above ` +
      `OPENAI_MAX_OUTPUT_TOKENS (${v.OPENAI_MAX_OUTPUT_TOKENS}), so thinking will never be requested`);
  // The measured failure this guards: Chat Completions caps tools at 128 while the app sends
  // 236, so 108 tools vanish and the model narrates work it cannot do.
  if (v.OPENAI_API === "chat" && !/codex/i.test(v.OPENAI_MODEL))
    warnings.push(`OPENAI_API=chat drops tools above ${v.OPENAI_MAX_TOOLS}; this app sends over 200. ` +
      `Set OPENAI_API=responses unless you specifically need Chat Completions`);
  if (v.OPENAI_CLASSIFIER_SLOW_MS >= 60000)
    warnings.push(`OPENAI_CLASSIFIER_SLOW_MS=${v.OPENAI_CLASSIFIER_SLOW_MS} is at or past the CLI's ` +
      `60s fail-closed classifier deadline, so the warning can never fire before the denial`);
  if (!v.OPENAI_API_KEY) errors.push(`no OpenAI API key (checked OPENAI_API_KEY, .openai-model, ${HOME_FILE})`);

  return { errors, warnings };
}

// ---------- CLI ----------
//
// run.sh is bash and needs the hash to decide whether a running proxy is the one it wants.
// Keeping that in this module rather than reimplementing the precedence in shell is the
// entire reason this file exists.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const arg = process.argv[2] || "--json";
  if (arg === "--hash") process.stdout.write(configHash() + "\n");
  else if (arg === "--code-version") process.stdout.write(codeVersion() + "\n");
  else if (arg === "--provider") process.stdout.write(provider() + "\n");
  else if (arg === "--validate") {
    const { errors, warnings } = validate();
    for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
    for (const e of errors) process.stdout.write(`error: ${e}\n`);
    process.exitCode = errors.length ? 1 : 0;
  } else process.stdout.write(JSON.stringify(snapshot(), null, 2) + "\n");
}
