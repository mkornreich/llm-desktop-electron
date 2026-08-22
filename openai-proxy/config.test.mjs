// Tests for the canonical config resolver.
//   node --test openai-proxy/config.test.mjs
//
// The resolver was EXTRACTED from working expressions, so the only test that matters is
// whether it still resolves to the same values. Every case below was derived by hand from the
// expression it replaces, including the two quirks — a test that just restates the new code
// proves nothing, so these are written as "what should this input produce", not "what does the
// table say".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SETTINGS, resolve, snapshot, configHash, keyFingerprint, codeVersion, validate, loadKV,
  PROVIDERS, providerForBase, activeProviders, isNonToolModel,
} from "./config.mjs";

// Resolve against explicit sources so the developer's own dotfiles cannot change a result.
const R = (env = {}, project = {}, home = {}, keyfile = {}) => resolve({ env, project, home, keyfile }).values;
const S = (env = {}, project = {}, home = {}, keyfile = {}) => resolve({ env, project, home, keyfile }).sources;

test("with nothing configured, every setting resolves to its documented default", () => {
  const v = R();
  assert.equal(v.OPENAI_MODEL, "gpt-4.1");
  assert.equal(v.OPENAI_API, "chat");                 // gpt-4.1 has no 'codex' in it
  assert.equal(v.OPENAI_BASE_URL, "https://api.openai.com/v1");
  assert.equal(v.PORT, 8123);
  assert.equal(v.OPENAI_CLASSIFIER_MODEL, "");
  assert.equal(v.OPENAI_CLASSIFIER_SAFETY_MODEL, "gpt-5.4-2026-03-05");   // a pinned snapshot
  assert.equal(v.OPENAI_CLASSIFIER_MAX_TOOLS, 4);
  assert.equal(v.OPENAI_DEFAULT_MAX_TOKENS, 8192);
  assert.equal(v.OPENAI_MAX_OUTPUT_TOKENS, 32768);
  assert.equal(v.OPENAI_MAX_TURN_OUTPUT_TOKENS, 56000);
  assert.equal(v.OPENAI_MAX_TOOLS, 128);
  assert.equal(v.OPENAI_MAX_TOOLS_RESPONSES, Infinity);
  assert.equal(v.OPENAI_REASONING_EFFORT, "medium");
  assert.equal(v.OPENAI_VERBOSITY, "high");
  assert.equal(v.OPENAI_THINKING_MIN_BUDGET, 4000);
  assert.equal(v.OPENAI_MAX_TEXT_CHARS, 400000);
  assert.equal(v.OPENAI_COMPACT_MODEL, "gpt-4.1-mini");
  assert.equal(v.OPENAI_MAX_TRANSPORT_RETRIES, 2);
  assert.equal(v.OPENAI_MAX_EMPTY_RETRIES, 2);
  assert.equal(v.OPENAI_MAX_CONTINUATIONS, 2);
  assert.equal(v.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 0);
  assert.equal(v.OPENAI_CLAUDE_CODE_MODEL, "");
  assert.equal(v.DEFAULT_TEMP, undefined);            // absent, not 0
  assert.equal(v.PROXY_DUMP_TOOLS, false);
  for (const k of ["OPENAI_OUTPUT_FIXUPS", "OPENAI_PERSISTENCE", "OPENAI_SHOW_THINKING",
                   "OPENAI_EMPTY_RETRY", "OPENAI_CONTINUE_ON_TRUNCATION", "OPENAI_AUTO_CONTINUE",
                   "OPENAI_TASK_ECHO", "OPENAI_COMPACT_SUMMARY"])
    assert.equal(v[k], true, `${k} defaults on`);
});

test("environment beats the project file, which beats the home file", () => {
  const project = { OPENAI_MODEL: "from-project", apiKey: "project-key" };
  const home = { model: "from-home", apiKey: "home-key" };
  assert.equal(R({ OPENAI_MODEL: "from-env" }, project, home).OPENAI_MODEL, "from-env");
  assert.equal(R({}, project, home).OPENAI_MODEL, "from-project");
  assert.equal(R({}, {}, home).OPENAI_MODEL, "from-home");
  assert.equal(R({}, {}, {}).OPENAI_MODEL, "gpt-4.1");
});

test("the API key resolves env > project > its own .openai-key file, not the home file", () => {
  const project = { apiKey: "project-key" };
  const keyfile = { apiKey: "keyfile-key" };
  assert.equal(R({ OPENAI_API_KEY: "e" }, project, {}, keyfile).OPENAI_API_KEY, "e");
  assert.equal(R({}, project, {}, keyfile).OPENAI_API_KEY, "project-key");
  assert.equal(R({}, {}, {}, keyfile).OPENAI_API_KEY, "keyfile-key");
  assert.equal(S({}, {}, {}, keyfile).OPENAI_API_KEY, "keyfile");
  // The home file (~/.dbeaver-ai-complete) no longer supplies the key: apiKey there is ignored.
  assert.equal(R({}, {}, { apiKey: "home-key" }, {}).OPENAI_API_KEY, "");
});

test("the legacy project key `model` is still honoured, below the current name", () => {
  assert.equal(R({}, { model: "legacy" }).OPENAI_MODEL, "legacy");
  assert.equal(R({}, { OPENAI_MODEL: "current", model: "legacy" }).OPENAI_MODEL, "current");
});

test("an empty value is treated as absent, exactly as `||` did", () => {
  assert.equal(R({ OPENAI_MODEL: "" }, { OPENAI_MODEL: "project" }).OPENAI_MODEL, "project");
  assert.equal(R({ OPENAI_VERBOSITY: "" }).OPENAI_VERBOSITY, "high");
});

test("a setting that opts into blankOk keeps an explicitly empty value", () => {
  // The one exception, and the reason the exception exists. Blank
  // OPENAI_CLASSIFIER_SAFETY_MODEL means "use the main model and accept the latency", which the
  // settings help has always promised — and which `||` could never express, because blank is
  // falsy and fell through to the default. ABSENT still takes the default; only a defined,
  // empty value survives, so the two cannot be confused.
  assert.equal(R().OPENAI_CLASSIFIER_SAFETY_MODEL, "gpt-5.4-2026-03-05", "absent -> default");
  assert.equal(R({}, { OPENAI_CLASSIFIER_SAFETY_MODEL: "" }).OPENAI_CLASSIFIER_SAFETY_MODEL, "",
    "defined-but-empty -> blank, meaning the main model");
  assert.equal(R({ OPENAI_CLASSIFIER_SAFETY_MODEL: "" }).OPENAI_CLASSIFIER_SAFETY_MODEL, "",
    "including from the environment");
  assert.equal(S({}, { OPENAI_CLASSIFIER_SAFETY_MODEL: "" }).OPENAI_CLASSIFIER_SAFETY_MODEL,
    "project", "and the source says where the blank came from");
  // Nothing else opts in: an empty value everywhere else still means "absent".
  const optedIn = SETTINGS.filter((s) => s.blankOk).map((s) => s.name);
  assert.deepEqual(optedIn, ["OPENAI_CLASSIFIER_SAFETY_MODEL"],
    "blankOk changes what an empty value means, so it must stay deliberate and rare");
});

test("a blank safety model is legal, and warned about", () => {
  // It is the configuration measured to miss the CLI's deadline, so it must be a visible choice
  // rather than an accident: median 12.2s, p90 54s, 2 of 27 past the 60s fail-closed cliff.
  const r = validate({ resolved: resolve({
    env: { OPENAI_API_KEY: "k", OPENAI_API: "responses" },
    project: { OPENAI_CLASSIFIER_SAFETY_MODEL: "" }, home: {} }) });
  assert.deepEqual(r.errors, [], "blank is legal");
  assert.match(r.warnings.join(" "), /safety verdicts run on the main model/);
  assert.match(r.warnings.join(" "), /DENIES the action/);
  // The warning must state the MEASURED reason. It used to blame latency, from figures taken on a
  // different model; re-measuring showed latency is fine (p50 2.4s) and 8 of 14 verdicts come back
  // unparseable. Someone reading the old text would have chosen blank expecting a slow answer rather
  // than no answer.
  assert.match(r.warnings.join(" "), /UNPARSEABLE/);
  assert.match(r.warnings.join(" "), /eval\/reports\/safety-classifier\.md/,
    "a default's justification must point at the report that measured it");
  assert.ok(!/median 12\.2s/.test(r.warnings.join(" ")),
    "the superseded latency figures must not remain as the stated reason");
});

test("the API surface is auto-selected from the model name, and overridable", () => {
  assert.equal(R({ OPENAI_MODEL: "gpt-5.3-codex" }).OPENAI_API, "responses");
  assert.equal(R({ OPENAI_MODEL: "GPT-5.3-CODEX" }).OPENAI_API, "responses");  // case-insensitive
  assert.equal(R({ OPENAI_MODEL: "gpt-5.6-sol" }).OPENAI_API, "chat");
  assert.equal(R({ OPENAI_MODEL: "gpt-5.6-sol", OPENAI_API: "RESPONSES" }).OPENAI_API, "responses");
  assert.equal(R({}, { OPENAI_API: "responses" }).OPENAI_API, "responses");
  assert.equal(S({ OPENAI_MODEL: "gpt-5.6-sol" }).OPENAI_API, "derived");
  assert.equal(S({}, { OPENAI_API: "responses" }).OPENAI_API, "project");
});

test("the compaction model inherits the prefix classifier before its own default", () => {
  assert.equal(R({}, { OPENAI_CLASSIFIER_MODEL: "gpt-4.1-nano" }).OPENAI_COMPACT_MODEL,
    "gpt-4.1-nano");
  assert.equal(R({}, { OPENAI_CLASSIFIER_MODEL: "gpt-4.1-nano",
                       OPENAI_COMPACT_MODEL: "explicit" }).OPENAI_COMPACT_MODEL, "explicit");
  assert.equal(S({}, { OPENAI_CLASSIFIER_MODEL: "x" }).OPENAI_COMPACT_MODEL,
    "OPENAI_CLASSIFIER_MODEL");
});

test("local mode defaults the classifier, safety, and compact models to the model in use", () => {
  const env = { OPENAI_BASE_URL: "http://127.0.0.1:11435/v1", OPENAI_MODEL: "gemma4:latest" };
  // A remote classifier carried over from .openai-model (project) must not stick in local mode.
  const project = { OPENAI_CLASSIFIER_MODEL: "gpt-5.4-nano", OPENAI_COMPACT_MODEL: "gpt-4.1-mini" };
  const v = R(env, project), s = S(env, project);
  assert.equal(v.OPENAI_CLASSIFIER_MODEL, "gemma4:latest");
  assert.equal(v.OPENAI_CLASSIFIER_SAFETY_MODEL, "gemma4:latest");   // was the remote gpt-5.4 default
  assert.equal(v.OPENAI_COMPACT_MODEL, "gemma4:latest");
  assert.equal(s.OPENAI_CLASSIFIER_SAFETY_MODEL, "non-openai upstream -> model in use");
});

test("a non-OpenAI remote upstream (e.g. Cohere) also defaults the aux models to the model in use", () => {
  const env = { OPENAI_BASE_URL: "https://api.cohere.ai/compatibility/v1", OPENAI_MODEL: "command-a-03-2025",
                OPENAI_API_KEY: "x" };
  const project = { OPENAI_CLASSIFIER_MODEL: "gpt-5.4-nano" };   // bled over from .openai-model
  const v = R(env, project);
  assert.equal(v.OPENAI_CLASSIFIER_MODEL, "command-a-03-2025");
  assert.equal(v.OPENAI_CLASSIFIER_SAFETY_MODEL, "command-a-03-2025");
  assert.equal(v.OPENAI_COMPACT_MODEL, "command-a-03-2025");
});

test("an explicit env classifier model still wins on a non-OpenAI upstream", () => {
  const env = { OPENAI_BASE_URL: "http://127.0.0.1:11435/v1", OPENAI_MODEL: "gemma4:latest",
                OPENAI_CLASSIFIER_MODEL: "qwen3:8b" };
  const v = R(env);
  assert.equal(v.OPENAI_CLASSIFIER_MODEL, "qwen3:8b");               // env override respected
  assert.equal(v.OPENAI_CLASSIFIER_SAFETY_MODEL, "gemma4:latest");   // still defaults to the model in use
});

test("the real OpenAI API keeps the remote classifier/compact defaults", () => {
  const env = { OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_MODEL: "gpt-4.1", OPENAI_API_KEY: "x" };
  const v = R(env), s = S(env);
  assert.equal(v.OPENAI_CLASSIFIER_SAFETY_MODEL, "gpt-5.4-2026-03-05");
  assert.equal(v.OPENAI_COMPACT_MODEL, "gpt-4.1-mini");
  assert.notEqual(s.OPENAI_CLASSIFIER_MODEL, "non-openai upstream -> model in use");
});

test("providerForBase recognizes each provider's host", () => {
  assert.equal(providerForBase("https://generativelanguage.googleapis.com/v1beta/openai")?.id, "gemini");
  assert.equal(providerForBase("https://api.cohere.ai/compatibility/v1")?.id, "cohere");
  assert.equal(providerForBase("https://api.cohere.com/compatibility/v1")?.id, "cohere");
  assert.equal(providerForBase("https://openrouter.ai/api/v1")?.id, "openrouter");
  assert.equal(providerForBase("https://api.mistral.ai/v1")?.id, "mistral");
  assert.equal(providerForBase("https://api.groq.com/openai/v1")?.id, "groq");
  assert.equal(providerForBase("https://ollama.com/v1")?.id, "ollama");
  assert.equal(providerForBase("https://api.openai.com/v1")?.id, "openai");
  assert.equal(providerForBase("http://127.0.0.1:11435/v1")?.id, "local");   // loopback -> the keyless local provider
  assert.equal(providerForBase("http://localhost:11434/v1")?.id, "local");
});

test("activeProviders returns the registry entries whose named key is present", () => {
  assert.deepEqual(activeProviders({ googleApiKey: "a", cohereApiKey: "b" }).map((p) => p.id).sort(),
    ["cohere", "gemini"]);
  assert.deepEqual(activeProviders({ apiKey: "a" }).map((p) => p.id).sort(),
    ["cohere", "gemini", "groq", "mistral", "ollama", "openai", "openrouter"]);   // generic apiKey satisfies every provider's fallback
  assert.deepEqual(activeProviders({}).map((p) => p.id), []);
});

test("a named key resolves the default provider's OPENAI_API_KEY (googleApiKey for gemini)", () => {
  // The keyfile holds googleApiKey/cohereApiKey, not the generic `apiKey`; the default provider is the
  // one whose host matches OPENAI_BASE_URL, and its key comes from that provider's keyName.
  const env = { OPENAI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai", OPENAI_MODEL: "gemini-3-flash-preview" };
  const keyfile = { googleApiKey: "AIzaTESTKEY", cohereApiKey: "cohereTESTKEY" };
  const { values: v, sources: s } = resolve({ env, project: {}, home: {}, keyfile });
  assert.equal(v.OPENAI_API_KEY, "AIzaTESTKEY");
  assert.equal(s.OPENAI_API_KEY, "keyfile:googleApiKey");
});

test("local mode does not warn about a blank safety model (main-model verdicts are the intent there)", () => {
  const r = validate({ resolved: resolve({ env: {
    OPENAI_BASE_URL: "http://127.0.0.1:11435/v1", OPENAI_MODEL: "gemma4:latest",
    OPENAI_CLASSIFIER_SAFETY_MODEL: "",
  } }) });
  assert.ok(!r.warnings.some((w) => /safety verdicts run on/.test(w)));
});

test("isNonToolModel flags the groq compound family (bare and prefixed), nothing else", () => {
  for (const id of ["groq:groq/compound", "groq:groq/compound-mini", "groq/compound", "compound", "compound-mini"])
    assert.equal(isNonToolModel(id), true, `${id} cannot tool-call`);
  for (const id of ["groq:openai/gpt-oss-120b", "mistral:codestral-latest", "local:gemma4:latest",
                    "gemini:gemini-3-flash-preview", "cohere:command-a-plus-05-2026", "some-bare-model"])
    assert.equal(isNonToolModel(id), false, `${id} can tool-call`);
});

test("validate warns that a non-tool-calling chain member will be skipped, on both chains", () => {
  const r = validate({ resolved: resolve({ env: {
    OPENAI_API_KEY: "k",
    OPENAI_COMPOSITE_MODELS: "groq:openai/gpt-oss-120b,groq:groq/compound",
    OPENAI_COMPACT_MODELS: "groq:openai/gpt-oss-120b,groq:groq/compound-mini",
  }, project: {}, home: {} }) });
  assert.ok(r.warnings.some((w) => /composite member 'groq:groq\/compound' cannot do tool calling/.test(w)));
  assert.ok(r.warnings.some((w) => /compaction member 'groq:groq\/compound-mini' cannot do tool calling/.test(w)));
});

test("`0` means off where the original allowed it, and snaps back where it did not", () => {
  // These are the `|| zero` tails, one per setting. Getting one wrong silently re-enables a
  // retry loop the operator turned off, or disables a floor they never touched.
  assert.equal(R({ OPENAI_MAX_TRANSPORT_RETRIES: "0" }).OPENAI_MAX_TRANSPORT_RETRIES, 0);
  assert.equal(R({ OPENAI_MAX_EMPTY_RETRIES: "0" }).OPENAI_MAX_EMPTY_RETRIES, 0);
  assert.equal(R({ OPENAI_CLASSIFIER_MAX_TOOLS: "0" }).OPENAI_CLASSIFIER_MAX_TOOLS, 0);
  // QUIRK, pinned deliberately: 0 does NOT disable auto-continue — it resolves back to 2.
  // OPENAI_AUTO_CONTINUE=0 is the off switch.
  assert.equal(R({ OPENAI_MAX_CONTINUATIONS: "0" }).OPENAI_MAX_CONTINUATIONS, 2);
  // QUIRK, pinned deliberately: the default floor is 4000 but an explicit 0 gives 2000.
  assert.equal(R({ OPENAI_THINKING_MIN_BUDGET: "0" }).OPENAI_THINKING_MIN_BUDGET, 2000);
  assert.equal(R({ OPENAI_DEFAULT_MAX_TOKENS: "0" }).OPENAI_DEFAULT_MAX_TOKENS, 8192);
  assert.equal(R({ OPENAI_MAX_OUTPUT_TOKENS: "0" }).OPENAI_MAX_OUTPUT_TOKENS, 32768);
  assert.equal(R({ OPENAI_MAX_TOOLS: "0" }).OPENAI_MAX_TOOLS, 128);
  assert.equal(R({ OPENAI_MAX_TEXT_CHARS: "0" }).OPENAI_MAX_TEXT_CHARS, 400000);
  assert.equal(R({ OPENAI_CLASSIFIER_SLOW_MS: "0" }).OPENAI_CLASSIFIER_SLOW_MS, 20000);
  assert.equal(R({ OPENAI_MAX_TURN_OUTPUT_TOKENS: "0" }).OPENAI_MAX_TURN_OUTPUT_TOKENS, 56000);
  // 0 is the documented "no cap" value here, and Infinity is how the proxy spells that.
  assert.equal(R({ OPENAI_MAX_TOOLS_RESPONSES: "0" }).OPENAI_MAX_TOOLS_RESPONSES, Infinity);
});

test("a booleanish setting is off only for the exact string 0", () => {
  assert.equal(R({ OPENAI_PERSISTENCE: "0" }).OPENAI_PERSISTENCE, false);
  // Inherited and surprising, so pinned: these all read as ON.
  for (const s of ["false", "no", "off", "1", "yes"])
    assert.equal(R({ OPENAI_PERSISTENCE: s }).OPENAI_PERSISTENCE, true, `'${s}' is truthy`);
});

test("a diagnostic flag needs the exact string 1", () => {
  assert.equal(R({ PROXY_DUMP_TOOLS: "1" }).PROXY_DUMP_TOOLS, true);
  for (const s of ["0", "true", "yes", ""])
    assert.equal(R({ PROXY_DUMP_TOOLS: s }).PROXY_DUMP_TOOLS, false, `'${s}' does not enable it`);
});

test("a bad PORT stays NaN rather than silently becoming 8123", () => {
  // Listening on a port nobody asked for is how you get two proxies and a launcher trusting
  // the wrong one, so this must fail loudly at listen() instead of defaulting.
  assert.ok(Number.isNaN(R({ PORT: "abc" }).PORT));
  assert.equal(R({ PORT: "9000" }).PORT, 9000);
});

test("a trailing slash on the upstream base is removed", () => {
  assert.equal(R({ OPENAI_BASE_URL: "http://x/v1/" }).OPENAI_BASE_URL, "http://x/v1");
  assert.equal(R({ OPENAI_BASE_URL: "http://x/v1" }).OPENAI_BASE_URL, "http://x/v1");
});

test("temperature comes only from the home file, and absent is not zero", () => {
  assert.equal(R({}, {}, {}).DEFAULT_TEMP, undefined);
  assert.equal(R({}, {}, { temperature: "0" }).DEFAULT_TEMP, 0);
  assert.equal(R({}, {}, { temperature: "0.7" }).DEFAULT_TEMP, 0.7);
  // maxTokens is deliberately NOT read from the home file: it is a DBeaver setting carrying
  // 512, which starves any request that omits max_tokens.
  assert.equal(R({}, {}, { maxTokens: "512" }).OPENAI_DEFAULT_MAX_TOKENS, 8192);
});

test("sources say where each value came from, so a launch override is distinguishable", () => {
  const s = S({ OPENAI_MODEL: "x" }, { OPENAI_VERBOSITY: "low" }, { temperature: "0.5" });
  assert.equal(s.OPENAI_MODEL, "env");
  assert.equal(s.OPENAI_VERBOSITY, "project");
  assert.equal(s.DEFAULT_TEMP, "home");
  assert.equal(s.OPENAI_REASONING_EFFORT, "default");
});

// ---------- redaction ----------

test("the API key never appears in a snapshot, and its fingerprint is not the key", () => {
  const key = "sk-test-not-a-real-key-0123456789";
  const snap = snapshot({ resolved: resolve({ env: { OPENAI_API_KEY: key }, project: {}, home: {} }) });
  const text = JSON.stringify(snap);
  assert.ok(!text.includes(key), "the key must not be in the snapshot");
  assert.ok(!text.includes("sk-test"), "not even a prefix of it");
  assert.ok(!("OPENAI_API_KEY" in snap.settings), "the key is not a reportable setting");
  assert.match(snap.apiKeyFingerprint, /^sha256:[0-9a-f]{12}$/);
  assert.ok(!snap.apiKeyFingerprint.includes(key));
  assert.equal(keyFingerprint(""), "none");
  assert.equal(keyFingerprint(null), "none");
});

test("the config hash reveals nothing about the key but still changes with it", () => {
  const base = { env: {}, project: {}, home: {} };
  const a = configHash({ resolved: resolve({ ...base, env: { OPENAI_API_KEY: "key-aaa" } }) });
  const b = configHash({ resolved: resolve({ ...base, env: { OPENAI_API_KEY: "key-bbb" } }) });
  assert.notEqual(a, b, "a rotated key must invalidate the hash — otherwise the launcher " +
    "keeps a proxy that is still holding a revoked key");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes("key-aaa"));
});

// ---------- the hash ----------

test("the same configuration always hashes the same, whatever order it arrived in", () => {
  const one = resolve({ env: { OPENAI_MODEL: "m", OPENAI_VERBOSITY: "low" }, project: {}, home: {} });
  const two = resolve({ env: { OPENAI_VERBOSITY: "low", OPENAI_MODEL: "m" }, project: {}, home: {} });
  assert.equal(configHash({ resolved: one }), configHash({ resolved: two }));
});

test("a value reached from a different source hashes the same — identity, not provenance", () => {
  // Moving a setting from the file to the environment does not change what the proxy does, so
  // it must not trigger a restart. The hash answers "is this the same behaviour", and `source`
  // answers "where did it come from"; conflating them makes every launch look stale.
  const viaEnv = resolve({ env: { OPENAI_MODEL: "same" }, project: {}, home: {} });
  const viaFile = resolve({ env: {}, project: { OPENAI_MODEL: "same" }, home: {} });
  assert.equal(configHash({ resolved: viaEnv }), configHash({ resolved: viaFile }));
});

test("every behaviour-affecting setting is part of the hash", () => {
  // The failure this prevents: add a setting, forget the hash, and the launcher happily reuses
  // a proxy that ignores it. Each setting is perturbed and the hash must move.
  const alt = {
    OPENAI_MODEL: "other-model", OPENAI_API: "responses", OPENAI_CLASSIFIER_MODEL: "c",
    OPENAI_CLASSIFIER_SAFETY_MODEL: "s", OPENAI_CLASSIFIER_MAX_TOOLS: "9",
    OPENAI_CLASSIFIER_SLOW_MS: "999", OPENAI_PICKER_MODELS: "a:A",
    OPENAI_BASE_URL: "http://other/v1", PORT: "9999", OPENAI_DEFAULT_MAX_TOKENS: "99",
    OPENAI_MAX_OUTPUT_TOKENS: "99", OPENAI_MAX_TURN_OUTPUT_TOKENS: "99", OPENAI_MAX_TOOLS: "99",
    OPENAI_MAX_TOOLS_RESPONSES: "99", OPENAI_OUTPUT_FIXUPS: "0", OPENAI_PERSISTENCE: "0",
    OPENAI_SHOW_THINKING: "0", OPENAI_REASONING_EFFORT: "low", OPENAI_THINKING_MIN_BUDGET: "99",
    OPENAI_VERBOSITY: "low", OPENAI_EMPTY_RETRY: "0", OPENAI_MAX_EMPTY_RETRIES: "9",
    OPENAI_CONTINUE_ON_TRUNCATION: "0", OPENAI_MAX_TRANSPORT_RETRIES: "9",
    OPENAI_AUTO_CONTINUE: "0", OPENAI_MAX_CONTINUATIONS: "9", OPENAI_TASK_ECHO: "0",
    OPENAI_MAX_TEXT_CHARS: "99", OPENAI_COMPACT_SUMMARY: "0", OPENAI_COMPACT_MODEL: "cm",
    OPENAI_CLAUDE_CODE_MODEL: "claude-x", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "99",
    PROXY_DUMP_TOOLS: "1", OPENAI_API_KEY: "k2", OPENAI_EXTRA_HEADERS: "X-Test:1",
    PROXY_SEND_CHROME_TOOLS: "0", PROXY_SEND_IOS_TOOLS: "0", PROXY_WEB_SEARCH: "0",
    PROXY_WEB_SEARCH_PROXY: "http://p:1",
    OPENAI_COMPOSITE_MODELS: "openai:gpt-5.6-sol,local:qwen3:8b", OPENAI_COMPOSITE_MAX_WAIT_MS: "9999",
    OPENAI_COMPACT_MODELS: "groq:openai/gpt-oss-20b,local:qwen3:8b",
  };
  const baseline = configHash({ resolved: resolve({ env: {}, project: {}, home: {} }) });
  const missing = [];
  for (const s of SETTINGS) {
    const h = configHash({ resolved: resolve({ env: { [s.env]: alt[s.name] }, project: {}, home: {} }) });
    if (h === baseline) missing.push(s.name);
  }
  // DEFAULT_TEMP has no env var, so it is checked through its own source.
  const temp = configHash({ resolved: resolve({ env: {}, project: {}, home: { temperature: "0.9" } }) });
  if (temp === baseline) missing.push("DEFAULT_TEMP");
  assert.deepEqual(missing, [], `settings absent from the hash: ${missing.join(", ")}`);
});

test("the code version tracks the source, so stale logic is visible with identical settings", () => {
  assert.match(codeVersion(), /^[0-9a-f]{12}$/);
  assert.equal(codeVersion(), codeVersion(), "memoized and stable within a process");
  // And it is genuinely derived from the files rather than being a constant someone must
  // remember to bump.
  const src = fs.readFileSync(fileURLToPath(new URL("./config.mjs", import.meta.url)), "utf8");
  assert.ok(src.includes("createHash"), "the version must be computed from the sources");
});

// ---------- coverage against the real proxy ----------

test("every setting the proxy reads is declared here", () => {
  // The drift this catches: a new `process.env.OPENAI_*` added straight into proxy.mjs would
  // be invisible to /health, to the hash, and to the settings window — so a change to it
  // would never restart a stale proxy.
  const src = fs.readFileSync(fileURLToPath(new URL("./proxy.mjs", import.meta.url)), "utf8");
  const declared = new Set(SETTINGS.map((s) => s.env).filter(Boolean));
  // Runtime plumbing, not configuration: these select a test mode or are read for their own
  // sake and deliberately stay out of the identity of the process.
  const exempt = new Set(["PROXY_NO_LISTEN", "PROXY_FORCE_IPV4", "LLMD_LOCAL_BASE"]);
  const found = new Set();
  for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) found.add(m[1]);
  const undeclared = [...found].filter((k) => !declared.has(k) && !exempt.has(k));
  assert.deepEqual(undeclared, [],
    `proxy.mjs reads settings this table does not declare: ${undeclared.join(", ")}`);
});

test("the project dotfile on disk parses, and holds only declared keys", () => {
  // A typo'd key in .openai-model is silent: the file is a KEY=VALUE bag with no schema, so
  // OPENAI_VERBOSTY=low simply does nothing forever.
  const onDisk = loadKV(fileURLToPath(new URL("../.openai-model", import.meta.url)));
  const declared = new Set();
  for (const s of SETTINGS) for (const k of s.project || []) declared.add(k);
  // Keys the LAUNCHER forwards to the agent. The proxy never reads them, but they live in the
  // same file, so they are legitimate residents rather than typos.
  const launcherKeys = /^CLAUDE_CODE_/;
  const unknown = Object.keys(onDisk).filter((k) => !declared.has(k) && !launcherKeys.test(k));
  assert.deepEqual(unknown, [], `unrecognised keys in .openai-model: ${unknown.join(", ")}`);
});

// ---------- validation ----------

test("validation accepts the configuration this repository actually ships", () => {
  const project = loadKV(fileURLToPath(new URL("../.openai-model", import.meta.url)));
  // A key is supplied so the check under test is the shipped settings, not the developer's
  // keyring. Everything else comes from the file as committed.
  const { errors } = validate({ resolved: resolve({ env: { OPENAI_API_KEY: "k" }, project, home: {} }) });
  assert.deepEqual(errors, [], `shipped .openai-model fails validation: ${errors.join("; ")}`);
});

test("validation rejects values that parse but cannot work", () => {
  const bad = (env) => validate({ resolved: resolve({ env: { OPENAI_API_KEY: "k", ...env }, project: {}, home: {} }) }).errors;
  assert.match(bad({ PORT: "abc" }).join(), /PORT/);
  assert.match(bad({ PORT: "70000" }).join(), /PORT/);
  assert.match(bad({ PORT: "0" }).join(), /PORT/);
  assert.match(bad({ OPENAI_API: "grpc" }).join(), /OPENAI_API/);
  assert.match(bad({ OPENAI_REASONING_EFFORT: "extreme" }).join(), /REASONING_EFFORT/);
  assert.match(bad({ OPENAI_VERBOSITY: "shouty" }).join(), /VERBOSITY/);
  assert.match(bad({ OPENAI_BASE_URL: "not a url" }).join(), /BASE_URL/);
  // A missing key is an error, and it names every place it looked rather than just failing.
  const noKey = validate({ resolved: resolve({ env: {}, project: {}, home: {}, keyfile: {} }) }).errors.join();
  assert.match(noKey, /API key/);
  assert.match(noKey, /\.openai-model/);
  assert.match(noKey, /\.openai-key/);
});

test("a loopback OPENAI_BASE_URL makes the API key optional (on-device server)", () => {
  // `local` provider points the proxy at Ollama/llama.cpp on localhost, which serve the OpenAI
  // API without a key — so a missing key must NOT be an error there.
  for (const base of ["http://127.0.0.1:11434/v1", "http://localhost:8080/v1", "http://[::1]:1234/v1"]) {
    const errs = validate({ resolved: resolve({ env: { OPENAI_BASE_URL: base }, project: {}, home: {}, keyfile: {} }) }).errors.join();
    assert.doesNotMatch(errs, /API key/, `loopback ${base} must not require a key`);
  }
  // But a remote endpoint with no key is still an error.
  const remote = validate({ resolved: resolve({ env: { OPENAI_BASE_URL: "https://api.openai.com/v1" }, project: {}, home: {}, keyfile: {} }) }).errors.join();
  assert.match(remote, /API key/);
});

test("validation warns about the tool-dropping configuration, without blocking it", () => {
  const r = validate({ resolved: resolve({
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.6-sol", OPENAI_API: "chat" }, project: {}, home: {} }) });
  assert.deepEqual(r.errors, [], "it is legal, just usually wrong");
  assert.match(r.warnings.join(), /responses/);
});

test("validation catches the cross-field mistakes that are hard to attribute later", () => {
  const warn = (env) => validate({ resolved: resolve({
    env: { OPENAI_API_KEY: "k", OPENAI_API: "responses", ...env }, project: {}, home: {} }) }).warnings.join(" | ");
  assert.match(warn({ OPENAI_MAX_TURN_OUTPUT_TOKENS: "1000" }), /below the single-call cap/);
  assert.match(warn({ OPENAI_DEFAULT_MAX_TOKENS: "999999" }), /clamped/);
  assert.match(warn({ OPENAI_THINKING_MIN_BUDGET: "99999" }), /thinking will never be requested/);
  assert.match(warn({ OPENAI_CLASSIFIER_SLOW_MS: "60000" }), /fail-closed/);
});

test("every table entry is well formed", () => {
  const names = new Set();
  for (const s of SETTINGS) {
    assert.ok(s.name, "a setting needs a name");
    assert.ok(!names.has(s.name), `duplicate setting ${s.name}`);
    names.add(s.name);
    if (s.derived) continue;
    assert.ok(["str", "strBlankOk", "int", "bool01", "flag1"].includes(s.type),
      `${s.name} has type '${s.type}'`);
    if (s.type === "int" || s.type === "str" || s.type === "strBlankOk" || s.type === "bool01")
      assert.equal(typeof s.default, "string", `${s.name} default must be the raw string form`);
    if (s.type === "int" && "zero" in s)
      assert.ok(typeof s.zero === "number", `${s.name} zero must be numeric`);
  }
});
