#!/usr/bin/env node
// Anthropic <-> OpenAI translation proxy.
//
// Speaks the Anthropic Messages API on the front (so an Anthropic SDK client can
// point ANTHROPIC_BASE_URL at it), and calls OpenAI's Chat Completions API on the
// back. Handles non-streaming and SSE streaming, plus best-effort tool-calls.
//
// Config is read at runtime (KEY=VALUE files):
//   apiKey=sk-...        (OpenAI key; never logged) from .openai-key, its own gitignored file
//   model=gpt-4.1        (target OpenAI model) from .openai-model, or ~/.dbeaver-ai-complete
//   maxTokens, temperature  (fallback defaults) from ~/.dbeaver-ai-complete
// Env overrides: OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, PORT.
//
// Usage:  node proxy.mjs        (listens on http://127.0.0.1:8123)

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  resolve as resolveConfig, snapshot, configHash, codeVersion, validate, provider,
} from "./config.mjs";
import {
  newInstanceId, writeManifest, readManifest, clearManifest, REPO,
} from "../scripts/lib/proxy-runtime.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { parseRequestBody, validateMessagesRequest, hoistInlineSystemMessages, parseToolArguments } from "./request-policy.mjs";
// `anthropicError` is deliberately NOT imported: this file already has a function of that name
// that writes to a response. Importing the body-builder under the same name is how you end up
// sending a plain object where a response was expected.
import {
  RequestError, TranslationError, errorResponse, isDroppableParam, SEMANTIC_CONTRACTS,
} from "./errors.mjs";
import {
  ROUTE, routeFor, policyFor, modelForRoute, routeLabel, isClassifier, isSafety,
  PREFIX_RE, SAFETY_RE, CLASSIFIER_RE, SEVERITY_RE, BLOCK_RE, OPENAI_MODEL_RE,
  effortForRoute, outputCeilingForRoute,
} from "./routes.mjs";
import * as provenance from "../scripts/lib/provenance.mjs";
import {
  exposureFor, resolveToolChoice, exposureFingerprint, partition, VISIBILITY,
} from "./tool-policy.mjs";
import {
  decodeBlocks, decodeToolResult, partsToResponses, partsToChat, countImages, countFiles, countNotes,
} from "./content.mjs";
import { localizePdfsInBody, makePdfExtractor } from "./pdf.mjs";
import { handleWebSearch } from "./websearch.mjs";
import {
  makeAttempt, Turn, KIND, emptyLedger, applyAttempt, loadLedger, saveLedger, ledgerPath,
  newId as newTurnId,
} from "./attempts.mjs";
import { formatMicros, unpricedAmong, RATE_TABLE_VERSION, RATES_SOURCE } from "./model-registry.mjs";

// ---------- config ----------
// Every setting, its precedence and its coercion now live in config.mjs, which also produces
// the redacted snapshot and the hash that /health reports. The declarations below keep their
// names and their comments — the comments ARE the documentation for why each exists — and take
// their values from that one resolver instead of each re-deriving its own precedence.
const { values: CFG, sources: CFG_SOURCES } = resolveConfig();
const OPENAI_API_KEY = CFG.OPENAI_API_KEY;

// ---------- identity of this process ----------
//
// A nonce generated once per start. Nothing else can produce it, so a caller that finds this
// value on /health and in the manifest knows it is talking to the process it started — not to a
// recycled PID, not to a foreign server that happens to hold the port, and not to a stale
// manifest. That distinction is what the crash on 08-13 had no way to make: the replacement
// proxy came back with PPID 1, indistinguishable from an unrelated program.
const INSTANCE = newInstanceId();
const STARTED_AT = new Date().toISOString();
// Computed once. The hash covers every behaviour-affecting setting plus a fingerprint of the
// key and a hash of the source files, so "same hash" means "would behave the same".
const CONFIG_HASH = configHash({ resolved: { values: CFG, sources: CFG_SOURCES } });
const CONFIG_SNAPSHOT = snapshot({ resolved: { values: CFG, sources: CFG_SOURCES } });
const CONFIG_ISSUES = validate({ resolved: { values: CFG, sources: CFG_SOURCES } });
// Precedence: env var > project dot file > global dbeaver file > default.
const OPENAI_MODEL = CFG.OPENAI_MODEL;
// API surface: OpenAI's codex models are served only via the Responses API;
// everything else uses Chat Completions. Override with OPENAI_API=responses|chat.
const OPENAI_API = CFG.OPENAI_API;
// A faster/cheaper model for the auto-mode safety classifier (a separate LLM call
// Claude Code makes before each risky action). The main coding model can be slow
// for these latency-sensitive checks, so route them to a small fast model here.
const OPENAI_CLASSIFIER_MODEL = CFG.OPENAI_CLASSIFIER_MODEL;
// The auto-mode SAFETY verdict. This defaulted to the main model, on the reasoning that a
// security decision should use the strongest model available. Live measurement killed that:
// gpt-5.3-codex takes 25-38s on real classifier prompts, and the CLI aborts its classifier at
// 60s and then DENIES the action — median 12.2s, p90 54s, max 287s over 27 measured verdicts,
// with 2 of 27 past the cliff. That is what the user sees as "temporarily unavailable".
//
// gpt-5.4 is ~10x faster and no more permissive. Replaying the four largest real prompts:
//   dump      codex            gpt-5.4                     gpt-4.1
//   612d01f5  no  / 26804ms    YES / 3499ms (Irreversible)  no  / 2659ms
//   87f6bc08  no  / 25100ms    no  / 2705ms                 no  / 7726ms
//   b6e29189  YES / 37667ms    YES / 2510ms (Prod Reads)    no  / 1760ms   <- 4.1 too permissive
//   b0f45511  no  / 31035ms    no  / 1376ms                 no  / 1041ms
// gpt-5.4 matched codex on the one block codex made and blocked one MORE that codex allowed,
// which is the right direction for a prompt that says to err on the side of blocking. gpt-4.1
// allowed the one codex blocked — the same failure gpt-4.1-mini showed.
//
// Set to "" to go back to the main model, accepting the latency.
const OPENAI_CLASSIFIER_SAFETY_MODEL = CFG.OPENAI_CLASSIFIER_SAFETY_MODEL;
// A classifier call is a verdict, so it carries no tools. This is the ceiling above which a
// prompt that LOOKS like a classifier is treated as a normal agent turn instead — see
// isClassifierRequest. 0 would be defensible; a few allows for a call that passes one or two.
const CLASSIFIER_MAX_TOOLS = CFG.OPENAI_CLASSIFIER_MAX_TOOLS;
// Models advertised on GET /v1/models — what the app's gateway model-discovery
// (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) lists in the picker. Selecting one
// makes the agent request that id, which the proxy passes straight through.
// Comma-separated "id:Display Name" pairs; override via OPENAI_PICKER_MODELS.
// The default list lives in config.mjs. The answering model must appear in it or the picker
// cannot offer what the proxy is actually running — gpt-5.6-sol was once the default while
// missing from the list, so /v1/models advertised five models, none of them the one answering.
const PICKER_MODELS = CFG.OPENAI_PICKER_MODELS
  .split(",").map((s) => { const [id, ...n] = s.split(":"); return { id: (id || "").trim(), name: (n.join(":").trim() || (id || "").trim()) }; })
  .filter((m) => m.id);
const OPENAI_BASE = CFG.OPENAI_BASE_URL;
// A loopback OPENAI_BASE_URL means an on-device server (Ollama, llama.cpp, LM Studio, vLLM):
// those serve the OpenAI API without authenticating, so the key is OPTIONAL there. An off-box
// endpoint still requires a key — that is the difference the FATAL check below turns on.
const IS_LOCAL_ENDPOINT = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(OPENAI_BASE);
// The bearer token actually put on the wire: the real key wherever it exists, and a harmless
// placeholder for a keyless local server (which ignores Authorization entirely). Never empty,
// so a local endpoint that DOES want a token still gets a well-formed header.
const OPENAI_AUTH = OPENAI_API_KEY || (IS_LOCAL_ENDPOINT ? "local" : "");
// Optional extra headers for the upstream, parsed from OPENAI_EXTRA_HEADERS as comma-separated
// `Key:Value` pairs. Used for OpenRouter's attribution headers (HTTP-Referer / X-Title); empty for
// every other backend, so the outbound headers are unchanged there.
const EXTRA_HEADERS = Object.fromEntries(
  (CFG.OPENAI_EXTRA_HEADERS || "").split(",")
    .map((p) => p.trim()).filter(Boolean)
    .map((p) => { const i = p.indexOf(":"); return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : null; })
    .filter(Boolean));
const upstreamHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_AUTH}`, ...EXTRA_HEADERS });
// Budget used only when the client omits max_tokens. It deliberately does NOT read
// FILE.maxTokens any more: ~/.dbeaver-ai-complete is a DBeaver config and carries
// maxTokens=512, which is fine for a SQL assistant and far too small for an agent — a request
// that omitted max_tokens got 512 tokens, and with reasoning attached could return nothing at
// all. Override with OPENAI_DEFAULT_MAX_TOKENS.
const DEFAULT_MAX_TOKENS = CFG.OPENAI_DEFAULT_MAX_TOKENS;
// OpenAI models cap completion tokens (e.g. gpt-4.1 = 32768) far below Claude's
// 64k; clamp so agents that request Claude-sized budgets don't 400.
const MAX_OUTPUT_TOKENS = CFG.OPENAI_MAX_OUTPUT_TOKENS;
// Tool-array caps are PER API SURFACE, not global — probed directly against the API:
//   Chat Completions: hard cap 128 (129 -> 400 "array too long").
//   Responses:        no cap observed (128/129/214/256/512 all accepted).
// The desktop agent sends ~214 tools, so on the Responses path we now send ALL of
// them and the model never loses a tool it needs. Only the chat path must clamp.
// Names must still match ^[a-zA-Z0-9_-]{1,64}$, so they are always sanitized.
const MAX_TOOLS_CHAT = CFG.OPENAI_MAX_TOOLS;
const MAX_TOOLS_RESPONSES = CFG.OPENAI_MAX_TOOLS_RESPONSES;
// MCP tool groups the config says NOT to forward. When a toggle is off, tools whose name starts
// with the group's prefix are stripped from every request before translation — they never reach
// the model and do not count against the tool budget or context. Default is to send both.
const DISABLED_TOOL_PREFIXES = [
  ...(CFG.PROXY_SEND_CHROME_TOOLS ? [] : ["mcp__claude-in-chrome"]),
  ...(CFG.PROXY_SEND_IOS_TOOLS ? [] : ["mcp__Claude_Code_iOS"]),
];
// Execute Claude Code's server-side WebSearch locally (proxy runs the search) — see websearch.mjs.
const WEB_SEARCH_ENABLED = CFG.PROXY_WEB_SEARCH;
const WEB_SEARCH_PROXY = CFG.PROXY_WEB_SEARCH_PROXY;   // optional curl -x proxy for the search fetch
function dropDisabledMcpTools(body) {
  if (!DISABLED_TOOL_PREFIXES.length || !Array.isArray(body?.tools)) return body;
  body.tools = body.tools.filter((t) => !DISABLED_TOOL_PREFIXES.some((p) => String(t?.name || "").startsWith(p)));
  return body;
}
// When the chat path MUST drop tools, drop the least essential ones rather than
// whichever happened to be last in the array. These are the tools an agent needs to
// actually finish work (read/write/run/search/plan) plus the ones that make output
// render (artifacts/widgets/diagrams) — losing those is what makes a model narrate a
// task instead of doing it, or dump raw markup instead of a rendered artifact.
const ESSENTIAL_TOOL_RE = new RegExp(
  "^(read|write|edit|multiedit|notebookedit|create_file|str_replace|" +
  "bash|bashoutput|killbash|killshell|run_command|shell|" +
  "glob|grep|ls|list_dir|search|find|" +
  "task|todowrite|exitplanmode|enterplanmode|plan|" +
  "webfetch|websearch|fetch|" +
  "skill|toolsearch|senduserfile|sendmessage|" +
  "artifact|.*widget.*|.*visuali[sz]e.*|.*diagram.*|.*mermaid.*|.*chart.*|canvas)",
  "i");
const isEssentialTool = (n) => ESSENTIAL_TOOL_RE.test(String(n || ""));
// PROXY_DUMP_TOOLS=1 writes the exact tool list a request carried to tools-dump.txt.
// The agent's real tool set is otherwise invisible from outside the app.
const DUMP_TOOLS = CFG.PROXY_DUMP_TOOLS;
function dumpTools(tools) {
  if (!DUMP_TOOLS || !Array.isArray(tools)) return;
  try {
    fs.writeFileSync(fileURLToPath(new URL("./tools-dump.txt", import.meta.url)),
      `${tools.length} tools\n` + tools.map((t) => t.name).join("\n") + "\n");
  } catch { /* diagnostic only */ }
}
// Output shaping. The app's chat surface is the REMOTE claude.ai web app — there is no
// math or markdown renderer in the local bundle to patch — so the only lever is what
// the model emits. GPT models default to \( \) / \[ \] for math, which that renderer
// shows literally; it wants $ / $$. And .svg FILES render as images (the bundle maps
// IMAGE_EXT_TO_MIME ".svg" -> "image/svg+xml"), while inline <svg> markup in chat text
// does not. Set OPENAI_OUTPUT_FIXUPS=0 to disable both.
const OUTPUT_FIXUPS = CFG.OPENAI_OUTPUT_FIXUPS;
// Agentic persistence. Claude Code's auto mode grants PERMISSION to run tools; it cannot
// make a model decide to keep going. Claude is trained to run a task to completion, while
// GPT models routinely end the turn to check in ("If you want, I'll run that now") — which
// in an agent loop reads as the task stalling and forces the user to say "yes, continue"
// every step. This adds an explicit persistence directive. Set OPENAI_PERSISTENCE=0 to
// disable it independently of the output fixups.
const PERSISTENCE = CFG.OPENAI_PERSISTENCE;
// Auto-continue. Prompting alone does NOT fix the stall: measured over 4 trials per arm on
// the prompt that stalled, the model called a tool 3/4 times with the persistence
// directive and 3/4 without — a ~25% stall rate either way, unmoved by wording. When a
// turn ends with text that merely ANNOUNCES or OFFERS an action and no tool call, the
// agent loop hands control back and the user has to say "yes, go on". So the proxy
// continues that turn itself: it feeds the model its own announcement plus a nudge and
// splices the result into the SAME assistant message, so the client sees one turn that
// actually contains the tool call. Bounded, logged, and skipped for the classifier.
// Show the model's thinking. The Responses API emits reasoning SUMMARIES (section
// headers and short rationales, not raw chain-of-thought) — but only when `summary` AND an
// explicit `effort` are both set. Probed: {summary:"detailed"} alone yields nothing, while
// effort low/medium/high with summary:"detailed" all produce
// response.reasoning_summary_text.delta events. These are mapped to Anthropic `thinking`
// content blocks, which the client renders as thinking. Responses path only — Chat
// Completions has no reasoning parameter.
const SHOW_THINKING = CFG.OPENAI_SHOW_THINKING;
const REASONING_EFFORT = CFG.OPENAI_REASONING_EFFORT;
// The reasoning-effort enum is API-wide but each model supports a SUBSET, and the API only
// tells you by rejecting the request: gpt-5.3-codex and gpt-5.4 both answer
//   "Unsupported value: 'max' is not supported with the '<model>' model.
//    Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."
// even though the enum itself is none|minimal|low|medium|high|xhigh|max. So asking for the
// true maximum and stepping down on rejection gets the highest each model actually allows,
// and keeps working when a model that does support 'max' is selected. The resolved value is
// cached per model so this costs at most one extra round-trip per model per proxy start.
const EFFORT_LADDER = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];
// Per-model memo of parameters the API has rejected, so the 400 is paid ONCE per process
// instead of on every request. This is not just tidiness: the recovery costs a full extra
// round trip, and the auto-mode safety classifier has a 60s deadline after which the CLI
// DENIES the action. Observed in the live log — request at 21:29:56, `stop` rejected at
// 21:30:10, retry, classifier aborted at 21:30:26 — the doubled latency was itself the
// cause of the denial the user saw.
// Keyed by SURFACE and model, not model alone.
//
// A capability belongs to a (surface, model) pair. gpt-5.6-sol on Chat Completions answers "Function
// tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions" — while the
// same model on the Responses API supports reasoning fully. With a model-only key, one Chat rejection
// taught the process that the model rejects reasoning, and every later Responses call silently went
// out without it: reasoning off, effort quietly lowered, and nothing in the log tying it to a
// rejection on a different surface.
//
// Latent today, because OPENAI_API pins every call to one surface — but a blank OPENAI_API routes
// `codex` names to Responses and everything else to Chat, so one process can genuinely use both.
// Being latent is not a reason to leave a wrong key in place.
const capKey = (surface, model) => `${surface || "?"}|${model || "?"}`;
const unsupportedByModel = new Map();
function rememberUnsupported(model, param, surface = "?") {
  const key = capKey(surface, model);
  if (!unsupportedByModel.has(key)) unsupportedByModel.set(key, new Set());
  const set = unsupportedByModel.get(key);
  // `param` is a FIELD PATH, not just a name: a nested rejection must not suppress a top-level field
  // that happens to share its last segment.
  if (!set.has(param)) {
    set.add(param);
    log(`  ! remembering that ${model} on ${surface} rejects '${param}' — it will not be sent again on that surface`);
  }
}
function stripUnsupported(payload, surface = "?") {
  const bad = unsupportedByModel.get(capKey(surface, payload?.model));
  if (!bad || bad.size === 0) return payload;
  const out = { ...payload };
  for (const p of bad) delete out[p];
  return out;
}

// Same reasoning for the effort ladder: a step taken because CHAT rejected `max` must not lower
// effort on Responses, where the model accepts it.
const effortByModel = new Map();
const effortFor = (model, surface = "?", route = ROUTE.MAIN) => {
  // The route's TARGET effort and the model's CEILING are separate facts. The target says what this
  // kind of call wants; the memo says what this (surface, model) pair has been observed to accept.
  const target = effortForRoute(route, REASONING_EFFORT);
  if (target === null) return null;
  return effortByModel.get(capKey(surface, model)) || target;
};
function lowerEffort(model, rejected, surface = "?") {
  const i = EFFORT_LADDER.indexOf(rejected);
  const next = i === -1 ? "high" : EFFORT_LADDER[i + 1];
  if (!next) return null;
  effortByModel.set(capKey(surface, model), next);
  log(`  ! reasoning effort '${rejected}' unsupported by ${model} on ${surface} — falling back to '${next}'`);
  return next;
}
// Reasoning tokens are drawn from the SAME max_output_tokens budget as the answer, so
// asking for thinking on a small-budget call can consume the whole allowance and return
// nothing. Observed in the app: background title calls (max_tokens=64, no tools) came back
// status=incomplete/max_output_tokens with 0 characters of text, four times in a row. The
// same call needs ~10 output tokens with no reasoning and ~26-64 with it. Utility calls
// gain nothing from thinking, so only request it when there is room to spare. The threshold
// is 4000 rather than 2000 because effort is now `max`: on one measured prompt the hidden
// reasoning went 98 tokens at medium -> 476 at xhigh, so the room needed grew with it.
const THINKING_MIN_BUDGET = CFG.OPENAI_THINKING_MIN_BUDGET;
// github issue #1 — "sometimes I see output with no text". Two causes, two fixes.
// (a) gpt-5.3-codex is terse to the point of silence: every tool-calling turn in the proxy
//     log came back text=0ch, so the UI showed a tool chip and no prose. OpenAI has a native
//     knob for this — text.verbosity, values low|medium|high (probed; 'ultra' 400s with the
//     list). It measurably changes output: "4" at low vs "2 + 2 = **4**." at high.
// (b) a turn can come back genuinely empty — no text AND no tool call — which must never be
//     forwarded as a blank turn. See emptyTurnNotice().
const VERBOSITY = CFG.OPENAI_VERBOSITY;
// Compaction can either discard old tool output or SUMMARISE it. Summarising costs one extra
// model call but keeps the substance, which is what Claude Code's native compaction does.
// Falls back to plain truncation whenever the summary call fails, so it can only add value.
// github issue #8. When a turn is cut off by the output cap, continue it automatically instead
// of handing back a truncated answer.
// The CLI gives its auto-mode safety classifier a wall-clock budget (60s for the fast stage,
// 120s for the thinking stage) and fails CLOSED when it expires — the user sees "<model> is
// temporarily unavailable, so auto mode cannot determine the safety of X" and the action is
// denied. A classifier verdict is ~11 output tokens, so anything near that budget means the
// proxy is the problem. Warn well before the cliff.
const CLASSIFIER_SLOW_MS = CFG.OPENAI_CLASSIFIER_SLOW_MS;

// An empty turn stalls the session: the user waits ~40s and gets a diagnostic instead of work.
// Retry instead. Bounded, and skipped for refusals, truncation and hard upstream errors — see
// the loop in streamResponses for why each of those must not be retried.
const EMPTY_RETRY = CFG.OPENAI_EMPTY_RETRY;
const MAX_EMPTY_RETRIES = CFG.OPENAI_MAX_EMPTY_RETRIES;
const CONTINUE_ON_TRUNCATION = CFG.OPENAI_CONTINUE_ON_TRUNCATION;
// A dropped upstream socket is not an answer, and until this existed it was not retried anywhere
// in the stack: the proxy logged "stream error: terminated" and ended the turn, and the CLI could
// not retry either because it had already been handed HTTP 200 and a partial stream. 97 turns in
// this log died that way. Small bound — a genuinely unreachable upstream should fail fast rather
// than sit through a long ladder, and the CLI still has its own retries above this one.
const MAX_TRANSPORT_RETRIES = CFG.OPENAI_MAX_TRANSPORT_RETRIES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Restricted on purpose to errors that mean "the connection broke", never "the API said no".
// undici reports a socket that dies mid-body as TypeError("terminated") with cause
// UND_ERR_SOCKET; the cause code is the reliable half, since the message is version-dependent.
// Verified against a local server: destroying the socket mid-SSE throws this, while a body that
// merely ends early yields a clean EOF, so retrying on this signal cannot mask a real refusal.
const TRANSPORT_ERROR_CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
]);
function isTransportError(e) {
  if (!e) return false;
  if (e.name === "AbortError") return false;       // a deliberate cancel is not a transport fault
  for (let cur = e, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    if (TRANSPORT_ERROR_CODES.has(cur.code)) return true;
    if (typeof cur.message === "string" && /^terminated$/i.test(cur.message.trim())) return true;
  }
  return false;
}
// Ceiling on the TOTAL output tokens spliced into one assistant message. This matters because
// every continuation appends to the same message, and the client enforces its own per-response
// maximum — "Claude's response exceeded the 64000 output token maximum". Splicing without a
// budget is a plausible way to produce exactly that error, so continuations stop below it.
const MAX_TURN_OUTPUT_TOKENS = CFG.OPENAI_MAX_TURN_OUTPUT_TOKENS;
const COMPACT_SUMMARY = CFG.OPENAI_COMPACT_SUMMARY;
const COMPACT_MODEL = CFG.OPENAI_COMPACT_MODEL;
const AUTO_CONTINUE = CFG.OPENAI_AUTO_CONTINUE;
const MAX_CONTINUATIONS = CFG.OPENAI_MAX_CONTINUATIONS;
// Text that promises or proposes an action rather than reporting one. Deliberately narrow:
// a genuine question the user alone can answer ("which of these three do you want?") should
// still end the turn, so this matches announcements, offers, and "I need X to proceed".
// Three distinct shapes, because they need opposite treatment.
// 1. INTENT — the model says it is about to act, and then doesn't. Always continue.
const INTENT_RE = new RegExp([
  "\\b(i['’]?ll|i will|let me|i['’]?m going to|i am going to|going to)\\b[^.!?]{0,80}\\b(run|query|check|look|search|fetch|pull|list|inspect|read|grep|find|start|do|gather|collect)\\b",
  "\\b(starting|i['’]?ve started|kicking off)\\b[^.!?]{0,60}\\b(now|in the background)\\b",
].join("|"), "i");
// 2. OFFER — "if you want, I can …". Ambiguous alone: it means "shall I do what you asked?"
//    BEFORE the work, and "shall I do something extra?" AFTER it. Only the first continues.
const OFFER_RE = new RegExp([
  "\\b(if you want|shall i|would you like me|let me know|want me to|say the word|i can (also|additionally))\\b",
  "\\bi can (run|query|check|pull|list|do) that\\b",
].join("|"), "i");
// 3. MISSING DETAIL — asking for a value it could have discovered itself.
const MISSING_RE = new RegExp([
  "\\b(i need|need one|need a|need the)\\b[^.!?]{0,60}\\b(detail|value|host|url|path|name|account|project|credential|info|information)\\b",
  "\\bwhich\\b[^.!?]{0,40}\\b(host|project|repo|repository|account|branch|url)\\b[^.!?]{0,40}\\?",
].join("|"), "i");
// Completion signals. When the model reports finished work, a trailing offer is a suggested
// follow-up the user never asked for — continuing it would invent new work.
const DONE_RE = new RegExp([
  "\\b(done|all set|finished|complete[d]?)\\b",
  "\\bi['’]?ve\\b|\\bi have (fixed|added|created|updated|committed|removed|written|run)\\b",
  "\\b(fixed|added|created|updated|committed|removed|wrote|ran|verified|renamed|deleted|rendered|saved)\\b",
  "\\b(here['’]?s|here is|here are|results?:)\\b",
  "\\b(tests? pass|passing|no changes needed|nothing to do|already (correct|done))\\b",
].join("|"), "i");
// Claims that background work is ALREADY underway. github issue #5: the agent answered
// "Got it — I started a deep Slack analysis workflow ... It's running now in the background,
// and I'll report back ... as soon as it finishes" having called no tool at all, so nothing
// was running and no report was ever coming. This is the inverse of INTENT_RE: not a promise
// to act, but a false statement that action has been taken — which is worse, because the user
// waits. Only meaningful when no background-capable tool actually ran this turn.
const FALSE_BACKGROUND_RE = new RegExp([
  "\\b(i|i['’]ve|i have)\\s+(just\\s+)?(started|kicked[- ]off|launched|spawned|queued|triggered|dispatched|set (it |them )?(off|running))\\b",
  "\\b(it|that|these|those|they|the (workflow|audit|job|analysis|run|task|tasks|agents?|scan|sweep))\\b[^.!?]{0,30}\\b(is|are|'s|’s)?\\s*(now\\s+)?running\\b",
  "\\brunning\\b[^.!?]{0,20}\\bin the background\\b",
  "\\bin the background\\b[^.!?]{0,40}\\b(now|already|as we speak)\\b",
  "\\bi'?’?ll report back\\b[^.!?]{0,50}\\b(finishes|completes|done|results?)\\b",
].join("|"), "i");
// Tools that can genuinely leave something running after the turn ends. If one of these was
// called this turn, "it's running in the background" may well be true — leave it alone.
const BG_CAPABLE_RE = /^(workflow|agent|task|taskcreate|bash|bashoutput|croncreate|schedulewakeup|remotetrigger|mcp__ccd_session__spawn_task)$/i;
function backgroundToolUsedThisTurn(input) {
  if (!Array.isArray(input)) return false;
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it?.type === "function_call" && BG_CAPABLE_RE.test(String(it.name || ""))) return true;
    if (it?.role === "user" && Array.isArray(it.content) && it.content.some((c) => c?.type === "input_text")) return false;
  }
  return false;
}

// Overrides everything: a turn that ends asking to confirm something destructive MUST stay
// ended. Continuing it would answer the user's question for them and then act.
//
// The permission-seeking half matches the CONSTRUCTION, not the bare verb. It used to match a
// bare `confirm` or `destructive` anywhere in the text, which quietly disabled the whole
// auto-continue rescue as soon as the model narrated its work — "I'll run the suite to confirm
// nothing regressed" and "nothing destructive here, moving on" both returned null. That got
// far more likely once the narration directive asked for exactly this kind of sentence.
// The genuinely dangerous markers stay bare: they are almost never incidental.
const NEEDS_USER_RE = new RegExp([
  "please confirm",
  "confirm (?:and|before|first|whether|that you)",
  "(?:if|once|when|unless) you confirm",
  "you to confirm",
  "your confirmation",
  "awaiting (?:your )?confirmation",
  "confirm (?:this|these|that|the) (?:action|change|deletion|command|step|operation)",
  "are you sure",
  "\\bbefore i (?:proceed|continue)\\b",
  "your (?:approval|permission)",
  "need your ok",
  "\\bpermanently\\b",
  "irreversibl",
  "cannot be undone",
  "can['’]?t be undone",
  "(?:is|are|would be) destructive",
  "destructive (?:action|operation|command|change|step)",
  "force[- ]?push",
  "rm -rf",
  "drop (?:table|database)",
].join("|"), "i");

// Why this turn should continue, or null to leave it ended. Returning the reason (rather
// than a boolean) lets the caller pick a matching nudge and log something meaningful.
//   workDone = any tool ran this turn; bgUsed = a background-capable tool ran this turn.
function continueReason(text, workDone = false, bgUsed = false) {
  const t = String(text || "");
  if (!t.trim()) return null;
  if (NEEDS_USER_RE.test(t)) return null;                     // destructive confirmation
  // Checked BEFORE the done/workDone stop, because a false "I started it" reads as completed
  // work and would otherwise be treated as a finished turn.
  if (!bgUsed && FALSE_BACKGROUND_RE.test(t)) return "false-background";
  if (INTENT_RE.test(t)) return "intent";                     // promised to act, then didn't
  // Reported finished work, or already used tools this turn, and promised nothing further:
  // anything it offers now is optional follow-up the user did not ask for. Stop here.
  if (DONE_RE.test(t) || workDone) return null;
  if (OFFER_RE.test(t)) return "offer";
  if (MISSING_RE.test(t)) return "missing-detail";
  return null;
}
const shouldAutoContinue = (text, workDone = false, bgUsed = false) =>
  continueReason(text, workDone, bgUsed) !== null;

// Did this turn already run tools? Walk back to the last real user message (an input_text
// item, not a tool result) and look for function calls after it.
function workDoneThisTurn(input) {
  if (!Array.isArray(input)) return false;
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it?.type === "function_call" || it?.type === "function_call_output") return true;
    if (it?.role === "user" && Array.isArray(it.content) && it.content.some((c) => c?.type === "input_text")) return false;
  }
  return false;
}

const NUDGE_FALSE_BACKGROUND =
  "Your reply states that work is running in the background, but you called no tool this turn, " +
  "so nothing was started and no result will ever arrive. Do one of two things now: actually " +
  "start the work with the appropriate tool (and if it is asynchronous, say which tool you " +
  "used), or correct the statement and tell the user plainly that you have not started it yet. " +
  "Never describe background work as underway unless a tool call actually started it.";

const NUDGE = "You ended your turn without calling any tool, but the user's request is not finished — " +
  "the text above only says what you intend to do. Do it now with the tools you have. If you were " +
  "missing a detail, discover it yourself first (git remotes and config, dotfiles, the environment, " +
  "CLAUDE.md and memory files, earlier sessions) and proceed. Do not reply with text alone again unless " +
  "the task is genuinely complete or you are blocked on something only the user can provide.";
const DEFAULT_TEMP = CFG.DEFAULT_TEMP;
const PORT = CFG.PORT;

// A remote endpoint (openai or openrouter) needs a key; a loopback one (local) does not. Only
// enforce this when the proxy will actually SERVE — PROXY_NO_LISTEN=1 is the unit-test import mode
// (proxy.test.mjs), which never serves and must not exit the test runner over a missing key.
if (!OPENAI_API_KEY && !IS_LOCAL_ENDPOINT && !process.env.PROXY_NO_LISTEN) {
  console.error("[proxy] FATAL: no API key for a remote endpoint (put `apiKey=sk-...` in .openai-key, or set OPENAI_API_KEY)");
  process.exit(1);
}

// ---------- usage accounting ----------
// OpenAI has no token quota to report and this project key cannot read the org usage API
// (403, missing scope api.usage.read), so the only way to answer "how many tokens have I
// used" for this app is to count them here. Persisted, because the proxy restarts on every
// app launch. GET /usage returns the totals.
// PROXY_NO_LISTEN is the unit-test import mode. Point the ledger somewhere disposable there:
// recordUsage() is exported and exercised directly, and it debounce-writes to disk, so tests
// would otherwise inject fake models into the real accounting file — which they did, until
// this was added.
// The ledger is v2: per-attempt, tier-aware, integer money. See attempts.mjs for why one
// reassigned `usage` variable meant a retried turn recorded only its final attempt, and
// model-registry.mjs for why an aggregate cannot be priced at all.
let ledger = loadLedger();
let usageDirty = false, usageTimer = null;
function persistLedger() {
  usageDirty = true;
  // Debounced: a busy agent turn would otherwise rewrite this file dozens of times.
  if (!usageTimer) usageTimer = setTimeout(() => {
    usageTimer = null;
    if (!usageDirty) return;
    usageDirty = false;
    try { saveLedger(ledger); } catch { /* non-fatal: accounting must never fail a turn */ }
  }, 3000);
}

// Record one upstream request. THE unit of accounting — every call to the API goes through here,
// including the retries that used to be invisible.
function recordAttempt(fields) {
  try {
    const a = makeAttempt(fields);
    applyAttempt(ledger, a);
    persistLedger();
    return a;
  } catch (e) {
    log(`  ! could not record an attempt (${e.message})`);
    return null;
  }
}

// The original signature, kept so existing call sites and tests keep working. `inTok` follows
// OpenAI's convention with cache reads INCLUDED; `cachedTok` is the subset served from cache.
//
// Attributed as `initial` unless the caller says otherwise, which is why the streaming path passes
// its own kind: a continuation recorded as `initial` would be counted but not explained.
function recordUsage(model, inTok, outTok, reasoningTok = 0, cachedTok = 0, extra = {}) {
  if (!model) return;
  recordAttempt({
    turnId: extra.turnId || "unknown",
    kind: extra.kind || KIND.INITIAL,
    route: extra.route || null,
    sessionId: extra.sessionId || null,
    surface: extra.surface || null,
    requestedModel: extra.requestedModel || null,
    resolvedModel: model,
    status: extra.status || "completed",
    usage: {
      grossInput: inTok ?? null,
      cached: cachedTok || 0,
      output: outTok ?? null,
      reasoning: reasoningTok || 0,
    },
  });
}

function usageSummary() {
  // v1-shaped fields are kept alongside the new ones: the settings window and several tests read
  // them, and a reporting change is not a reason to lose the old vocabulary.
  const totals = { requests: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0 };
  const by_model = {};
  let micros = 0, unpricedModels = 0;
  for (const [model, m] of Object.entries(ledger.byModel)) {
    const b = { requests: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0 };
    for (const tier of ["short", "long"]) {
      b.requests += m[tier].requests;
      b.input_tokens += m[tier].grossInput;
      b.output_tokens += m[tier].output;
      b.reasoning_tokens += m[tier].reasoning;
      b.cached_input_tokens += m[tier].cached;
      micros += m[tier].micros;
    }
    if (m.unpriced) unpricedModels++;
    by_model[model] = { ...b, short: m.short, long: m.long, unpriced: !!m.unpriced };
    for (const k of Object.keys(totals)) totals[k] += b[k];
  }
  const fresh = Math.max(0, totals.input_tokens - totals.cached_input_tokens);
  const hitRate = totals.input_tokens ? Math.round((totals.cached_input_tokens / totals.input_tokens) * 1000) / 10 : 0;
  const exact = unpricedModels === 0 && ledger.attempts.unknownUsage === 0;
  return {
    since: ledger.since,
    total: { ...totals, tokens: totals.input_tokens + totals.output_tokens,
             uncached_input_tokens: fresh, cache_hit_rate_pct: hitRate },
    by_model,
    // The new reporting. Attempts and turns are separate meters; a cost that rests on unknown or
    // unpriced data says so instead of presenting itself as exact.
    accounting: {
      attempts: ledger.attempts,
      turns: ledger.turns.total,
      by_route: ledger.byRoute,
      cost: {
        micros: exact ? micros : null,
        formatted: exact ? formatMicros(micros) : `at least ${formatMicros(micros)}`,
        exact,
        rateTableVersion: ledger.rateTableVersion || RATE_TABLE_VERSION,
        source: RATES_SOURCE,
        longContextAttempts: ledger.attempts.longContext,
        note: "Long-context pricing (>272,000 input tokens: 2x input, 1.5x output for the whole " +
          "request) is applied PER REQUEST, which is the only place it can be applied correctly.",
      },
    },
    legacy: ledger.legacy,
    note: "Counted by this proxy only. input_tokens follows OpenAI's convention and INCLUDES cache reads (the opposite of the Anthropic-facing input_tokens this proxy returns to the client, which excludes them); uncached_input_tokens is the part billed at the full rate. OpenAI has no token allowance to report; the account limit is per-minute (see x-ratelimit-* headers) plus dollar billing. This key cannot read the org usage API.",
  };
}


// ---------- helpers ----------
const rid = (p) => p + crypto.randomBytes(16).toString("hex");
// safeParse is GONE, deliberately. It was `try { JSON.parse(s) } catch { return {} }`, used for
// both the client's request body and the model's tool arguments, and `{}` is the wrong answer for
// both: an unreadable request became an empty conversation, and unreadable tool arguments became
// an executable call with no input. Parsing now goes through request-policy.mjs, which throws.
// Nothing here should reacquire a JSON parser that cannot fail.
// Date included on purpose. With time-of-day alone, any measurement across the log's day
// boundary silently wraps — which produced two wrong latency figures while diagnosing the
// classifier aborts (a "median 34s" and then a "median 483s", both artefacts) before the
// ambiguity was noticed. UTC, matching the ISO timestamps the rest of the pipeline uses.
const log = (...a) => console.log(`[proxy ${new Date().toISOString().slice(5, 19).replace("T", " ")}]`, ...a);

// One process-wide PDF text extractor (content-hashed cache), used only for local backends — see
// pdf.mjs. A cloud OpenAI endpoint ingests `input_file` itself, so its PDFs are left untouched.
const extractPdf = makePdfExtractor({ log });
// Logged here, after `log` is defined — DISABLED_TOOL_PREFIXES is computed far above, but logging it
// up there references `log` before its initialization (a TDZ crash when a tool group is disabled).
if (DISABLED_TOOL_PREFIXES.length) log(`not forwarding tool group(s): ${DISABLED_TOOL_PREFIXES.join(", ")}`);

// ---- connection pooling (the real cause of classifier timeouts) ----
//
// Measured: an identical tiny request took 1,322ms straight to OpenAI and 33,093ms through this
// proxy while the app was busy, with 26 requests in flight. It is not CPU — parsing and
// re-serialising a 0.64 MB, 236-tool payload costs 0.6ms. It is socket queueing: agent turns
// hold connections for 15-60s each, and a small request waits behind them.
//
// That is what makes the auto-mode classifier fail. Its verdict is ~11 output tokens and the
// model answers a tiny prompt in ~1.1s, but queued behind live turns it measured a median of
// 78s against the CLI's 60s deadline — after which the CLI DENIES the action, which is the
// "temporarily unavailable" the user sees.
//
// So: a generous shared pool, plus a SEPARATE pool reserved for classifier calls, so a verdict
// can never be starved by agent traffic. Guarded — if undici is unavailable the proxy keeps
// working on the global fetch, just without the isolation.
let classifierFetch = fetch;
try {
  const { Agent, setGlobalDispatcher, fetch: undiciFetch } = await import("undici");
  setGlobalDispatcher(new Agent({ connections: 64, pipelining: 0, keepAliveTimeout: 30_000 }));
  const classifierAgent = new Agent({ connections: 8, pipelining: 0, keepAliveTimeout: 30_000 });
  classifierFetch = (url, opts) => undiciFetch(url, { ...opts, dispatcher: classifierAgent });
  log("connection pools: 64 shared, 8 reserved for classifier verdicts");
} catch (e) {
  log(`! undici unavailable (${e.code || e.message}) — using the default pool for everything`);
}

const sanitizeToolName = (n) => String(n || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
// Flatten an Anthropic tool_result's content to text. Neither OpenAI surface has an
// error flag on tool output, so is_error is marked inline — without it a failed command
// is indistinguishable from a successful one and the model reports success.
function toolResultText(blk) {
  const c = blk.content;
  const body = typeof c === "string" ? c
    : Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text : p?.text ?? `[${p?.type || "content"} omitted by proxy]`)).join("\n")
    : c == null ? "" : JSON.stringify(c);
  return blk.is_error ? `[tool error] ${body}` : body;
}

// A turn with no text and no tool call is useless to the user and indistinguishable from a
// hang. Rather than forward the blank, say what actually happened — the real status and the
// likely cause. This reports a failure; it never invents an answer.
// Should an empty turn be retried? Split out so the carve-outs are testable, because each one
// is a case where retrying is actively wrong:
//   refusal - the refusal IS the answer; asking again just refuses again
//   error   - a hard upstream failure; the message is the useful output
//   incomplete for any reason OTHER than the output cap (content_filter, …) - not a retry's job
//
// An `incomplete` turn caused by the output cap that produced NOTHING is deliberately still
// retried: that is reasoning starvation, and the retry drops reasoning, which is the cure.
// Classifying the 21 empty turns in the log showed why this distinction matters — 10 of them
// were exactly that case, and vetoing on `incomplete` wholesale would have left the largest
// group unfixed. Truncation of a turn that DID produce content is different, and belongs to the
// continue-on-truncation loop, which resumes instead of restarting.
function shouldRetryEmpty(s) {
  if (!s.enabled || !s.allowContinue) return false;
  if (s.hasTool || s.textLen > 0) return false;
  if (s.refusalText || s.streamError) return false;
  if (s.incomplete && s.incompleteReason !== "max_output_tokens") return false;
  return s.retries < s.maxRetries;
}

// Responses events that are normal bookkeeping and safely ignored. Naming them keeps the
// empty-turn notice's `unhandled_events` field meaningful: without this it reported
// `response.created` on every failure, which tells nobody anything.
const BENIGN_EVENTS = new Set([
  "response.created", "response.in_progress", "response.queued",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.done", "response.function_call_arguments.done",
  "response.reasoning_summary_text.done", "response.reasoning_text.delta",
  "response.reasoning_text.done", "rate_limits.updated",
]);

const nowMs = () => Date.now();

function emptyTurnNotice(resp) {
  const status = resp?.status || "completed";
  const reason = resp?.incomplete_details?.reason;
  const out = resp?.usage?.output_tokens;
  const reasoning = resp?.usage?.output_tokens_details?.reasoning_tokens;
  const bits = [`status=${status}`];
  if (reason) bits.push(`reason=${reason}`);
  if (out != null) bits.push(`output_tokens=${out}`);
  if (reasoning) bits.push(`reasoning_tokens=${reasoning}`);
  if (resp?.retries) bits.push(`retries=${resp.retries}`);
  if (resp?.unhandled?.length) bits.push(`unhandled_events=${resp.unhandled.join(",")}`);
  let hint = "";
  if (resp?.error) {
    hint = ` The upstream reported: ${resp.error}.`;
  } else if (reason === "max_output_tokens") {
    hint = reasoning
      ? " The token budget was consumed by reasoning before any answer was produced — raise max_tokens, or lower OPENAI_REASONING_EFFORT / raise OPENAI_THINKING_MIN_BUDGET."
      : " The output token budget was exhausted — raise max_tokens.";
  } else if (status === "no terminal event") {
    // The fingerprint of every empty turn in the log: no content, no usage, and neither
    // response.completed nor response.incomplete ever arrived. Say that, rather than claiming
    // the model completed normally and simply chose to say nothing.
    hint = " The upstream stream ended without reporting a result, so this is a transport" +
           " failure rather than the model declining to answer. Sending the message again" +
           " usually works.";
  }
  return `[proxy] The model returned no content for this turn (${bits.join(", ")}). ` +
         `No tool was called, so nothing ran.${hint}`;
}

// ---- automatic compaction (github issue #4) ----
// The app showed "Your context window is full ... Prompt is too long". Claude Code has its
// own auto-compaction, but it sizes the window from the model it THINKS it is talking to
// (claude-opus-4-8) while the proxy actually calls gpt-5.3-codex, so its threshold never
// trips and OpenAI rejects the request outright with:
//   400 "Your input exceeds the context window of this model. Please adjust your input and
//        try again."
// The models endpoint reports no context_window, so the limit cannot be read ahead of time —
// compaction is therefore reactive: catch that error, shrink the conversation, retry.
const CONTEXT_ERROR_RE = /exceeds the context window|context[_ ]length[_ ]exceeded|maximum context length|too many tokens|reduce the length/i;

// What gets shrunk, and why only this. Tool OUTPUT is where an agent conversation's tokens
// actually live — file contents and command output, measured at ~110k input tokens per
// request. Their *content* is truncated rather than the items removed, because a
// function_call and its function_call_output are separate top-level items joined by call_id:
// dropping one side breaks the pairing and OpenAI rejects the request. Truncating content
// keeps the structure exactly intact.
const TRIMMED = "[earlier tool output trimmed by the proxy to fit the model's context window]";

// Last resort, when the ladder above finds nothing to trim.
//
// Both compactors only touch TOOL RESULTS, so a single oversized message — a pasted log, a
// 300k-token document — is untouchable and the whole ladder reports
//   ! context exceeded mid-stream and nothing left to compact (keep=96)
// leaving the turn to fail with no content. Found while A/B testing the compact window.
//
// So: cut the single largest oversized text payload down to OPENAI_MAX_TEXT_CHARS, oldest
// first, leaving the most recent item alone. One per call, so successive ladder steps shrink
// successively smaller offenders instead of mangling everything at once.
const MAX_TEXT_CHARS = CFG.OPENAI_MAX_TEXT_CHARS;
const textCut = (n) => `\n\n[… ${n} characters trimmed by the proxy to fit the context window …]`;

function truncateLargestText(items, getText, setText) {
  let best = -1, bestLen = 0;
  for (let i = 0; i < items.length - 1; i++) {           // never the most recent item
    const t = getText(items[i]);
    if (typeof t === "string" && t.length > MAX_TEXT_CHARS && t.length > bestLen) {
      best = i; bestLen = t.length;
    }
  }
  if (best < 0) return { items, trimmed: 0, reclaimed: 0 };
  const cut = bestLen - MAX_TEXT_CHARS;
  const out = items.slice();
  out[best] = setText(out[best], getText(out[best]).slice(0, MAX_TEXT_CHARS) + textCut(cut));
  return { items: out, trimmed: 1, reclaimed: cut };
}

// Responses items carry text in content[].text; chat messages in .content (string or parts).
function compactOversizedResponsesText(input) {
  if (!Array.isArray(input)) return { input, trimmed: 0, reclaimed: 0 };
  const get = (it) => (Array.isArray(it?.content)
    ? it.content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("")
    : undefined);
  const set = (it, text) => ({ ...it, content: [{ type: it.role === "assistant" ? "output_text" : "input_text", text }] });
  const r = truncateLargestText(input, get, set);
  return { input: r.items, trimmed: r.trimmed, reclaimed: r.reclaimed };
}
function compactOversizedChatText(messages) {
  if (!Array.isArray(messages)) return { messages, trimmed: 0, reclaimed: 0 };
  const get = (m) => (typeof m?.content === "string" ? m.content : undefined);
  const set = (m, content) => ({ ...m, content });
  const r = truncateLargestText(messages, get, set);
  return { messages: r.items, trimmed: r.trimmed, reclaimed: r.reclaimed };
}

function compactResponsesInput(input, keepRecent) {
  if (!Array.isArray(input)) return { input, trimmed: 0, reclaimed: 0 };
  const cutoff = Math.max(0, input.length - keepRecent);
  let trimmed = 0, reclaimed = 0;
  const out = input.map((item, i) => {
    if (i >= cutoff) return item;                                  // recent turns stay whole
    if (item?.type === "function_call_output" && typeof item.output === "string"
        && item.output.length > TRIMMED.length && item.output !== TRIMMED) {
      reclaimed += item.output.length - TRIMMED.length;
      trimmed++;
      return { ...item, output: TRIMMED };
    }
    return item;
  });
  return { input: out, trimmed, reclaimed };
}

// Same idea on the chat surface, where tool results are role:"tool" messages.
function compactChatMessages(messages, keepRecent) {
  if (!Array.isArray(messages)) return { messages, trimmed: 0, reclaimed: 0 };
  const cutoff = Math.max(0, messages.length - keepRecent);
  let trimmed = 0, reclaimed = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m?.role === "tool" && typeof m.content === "string"
        && m.content.length > TRIMMED.length && m.content !== TRIMMED) {
      reclaimed += m.content.length - TRIMMED.length;
      trimmed++;
      return { ...m, content: TRIMMED };
    }
    return m;
  });
  return { messages: out, trimmed, reclaimed };
}

// Escalation ladder: keep 12 recent items, then 6, then 2. Each pass reclaims more.
// The compaction ladder: how many recent tool results to keep when the context overflows.
//
// This used to be [12, 6, 2], which threw away far more than necessary. The log settles it:
// across 168 compactions the FIRST step succeeded every single time and steps 6 and 2 were
// never reached — so every overflow was resolved by cutting to 12 tool results, whether it
// needed to be or not. One logged example reclaimed ~112k tokens to fix an overflow that a
// much gentler trim would have cleared, and that lost history is exactly what shows up as
// the model having forgotten what it was doing (issue #14).
//
// Starting gentle costs an extra round trip when a big cut really is needed, so the index of
// whatever last worked is remembered and reused (compactStartIndex below) — the same shape as
// the per-model effort and unsupported-parameter memos.
//
// Measured limits behind this, by bisection against the live API with max_output_tokens=16:
//   gpt-5.3-codex  253,339 accepted / ~284k rejected  -> a 272k window
//   gpt-4.1        618k accepted                      -> ~1M
// The app believes it is talking to a 1M-context Claude and packs accordingly, so on codex
// the overflow is routine rather than exceptional.
const COMPACT_STEPS = [96, 48, 24, 12, 6, 2];
// KEYED, not process-global.
//
// This was one `let compactStartIndex = 0` for the whole process, and the comment even called it
// "for this session" — which it was not. The proxy serves several sessions and more than one model at
// once, so whatever ONE conversation last needed became the starting point for every other:
//
//   session A has enormous tool results, overflows, and learns keep=6
//   session B would have fitted comfortably at keep=96 — and now starts at 6,
//   discarding ninety items of its transcript that it never needed to lose
//
// Four agents were running against this proxy concurrently while this was being investigated, so it
// is a live effect rather than a hypothetical one. Keyed by surface, model and session: a transcript's
// shape is a property of that conversation, and a model's context window is a property of the model.
const compactLearned = new Map();
const compactKey = (surface, model, sessionId) =>
  `${surface || "?"}|${model || "?"}|${sessionId || "unknown"}`;
const compactStartFor = (surface, model, sessionId) =>
  compactLearned.get(compactKey(surface, model, sessionId)) || 0;
const rememberCompact = (keep, surface, model, sessionId) => {
  const i = COMPACT_STEPS.indexOf(keep);
  const key = compactKey(surface, model, sessionId);
  if (i > -1 && i !== (compactLearned.get(key) || 0)) {
    compactLearned.set(key, i);
    log(`  ! remembering keep=${keep} as the working compaction level for ${key}`);
  }
  // Bounded: one entry per (surface, model, session) would otherwise grow for the life of the
  // process. Sessions are long-lived and few, so a generous cap that is still a cap.
  if (compactLearned.size > 500) {
    const oldest = compactLearned.keys().next().value;
    compactLearned.delete(oldest);
  }
};

// Caps on what the summariser itself is fed, so the compaction call cannot blow its own
// context: at most this much of each result, and this much in total.
const SUMMARY_PER_ITEM = 4000;
const SUMMARY_TOTAL = 120000;
const SUMMARY_MAX_TOKENS = 1500;

// Ask a cheap model to condense the region being dropped. Returns null on any failure, which
// makes the caller fall back to plain truncation — summarising must never be able to break a
// request that truncation alone would have fixed.
async function summariseDropped(pieces) {
  if (!pieces.length) return null;
  // Split the budget EVENLY rather than first-come-first-served. With a greedy budget, 36
  // results at 4000 chars each blew the 120k total and the last items were fed nothing —
  // observed live: a marker planted in result 31 of 36 was absent from the digest while ones
  // in results 7 and 19 survived. An even share means every dropped result is represented.
  const perItem = Math.max(400, Math.min(SUMMARY_PER_ITEM, Math.floor(SUMMARY_TOTAL / pieces.length)));
  const parts = pieces.map(({ label, text }) => `### ${label}\n${text.slice(0, perItem)}`);
  const prompt =
    "You are compacting an AI coding agent's conversation to fit a context window. Below are " +
    "tool results that are about to be dropped. Write a dense factual digest that preserves " +
    "what a coding agent would still need: file paths, symbol and function names, key values, " +
    "errors, counts, and conclusions reached. Omit boilerplate and repetition. Use terse " +
    "bullets. Do not invent anything not present below.\n\n" + parts.join("\n\n");
  try {
    const r = await fetch(`${OPENAI_BASE}/responses`, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify({
        model: COMPACT_MODEL, max_output_tokens: SUMMARY_MAX_TOKENS,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) { log(`  ! compaction summary failed (${r.status}); falling back to truncation`); return null; }
    const j = await r.json();
    // This is a real upstream call on the account's key, and it was the one request the
    // ledger never saw — /usage claimed to cover every path while silently omitting it.
    recordUsage(COMPACT_MODEL, j?.usage?.input_tokens, j?.usage?.output_tokens,
                j?.usage?.output_tokens_details?.reasoning_tokens,
                j?.usage?.input_tokens_details?.cached_tokens, { kind: KIND.COMPACTION_SUMMARY, route: "compaction", surface: "responses" });
    let text = "";
    for (const it of j.output || [])
      if (it.type === "message") for (const c of it.content || []) if (c.type === "output_text") text += c.text || "";
    text = text.trim();
    if (!text) { log("  ! compaction summary came back empty; falling back to truncation"); return null; }
    return text;
  } catch (e) {
    log(`  ! compaction summary error (${e.message}); falling back to truncation`);
    return null;
  }
}

// Compact, and if summarisation is enabled put a digest of what was dropped into the OLDEST
// trimmed slot. No items are added or removed, so call_id pairing is untouched — the digest
// simply occupies the place the information used to be.
async function compactResponsesInputSummarised(input, keepRecent, summarise = summariseDropped) {
  const plain = compactResponsesInput(input, keepRecent);
  if (!COMPACT_SUMMARY || !plain.trimmed) return plain;

  // Collect what this pass is discarding, oldest first, with a label the digest can reference.
  const pieces = [];
  let firstTrimmedIdx = -1;
  const cutoff = Math.max(0, input.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    const before = input[i], after = plain.input[i];
    if (before?.type === "function_call_output" && after?.output === TRIMMED && before.output !== TRIMMED) {
      if (firstTrimmedIdx === -1) firstTrimmedIdx = i;
      // find the matching call so the digest can name the tool and its arguments
      const call = input.find((x) => x?.type === "function_call" && x.call_id === before.call_id);
      const label = call ? `${call.name || "tool"} ${String(call.arguments || "").slice(0, 120)}` : `result ${before.call_id}`;
      pieces.push({ label, text: String(before.output || "") });
    }
  }
  const digest = await summarise(pieces);
  if (!digest || firstTrimmedIdx === -1) return plain;

  const out = plain.input.slice();
  out[firstTrimmedIdx] = {
    ...out[firstTrimmedIdx],
    output: `[proxy] ${pieces.length} earlier tool result(s) were compacted to fit the context ` +
            `window. Digest of what they contained:\n\n${digest}`,
  };
  log(`  ! summarised ${pieces.length} dropped tool result(s) into a ${digest.length}-char digest (model ${COMPACT_MODEL})`);
  return { input: out, trimmed: plain.trimmed, reclaimed: plain.reclaimed - digest.length, summarised: true };
}

// ---- tool-argument pruning ----
// The model sometimes invents a parameter that belongs to a DIFFERENT tool: it called
// Workflow with run_in_background (which Agent and Bash have, Workflow does not) and the
// harness rejected the whole call with InputValidationError. The proxy declared each
// tool's schema, so it can drop arguments that schema does not allow instead of letting a
// good call fail. Anything dropped would have been rejected downstream anyway.
function pruneToolArgs(schema, args) {
  if (!schema || typeof args !== "object" || args === null || Array.isArray(args)) return { args, dropped: [] };
  const props = schema.properties;
  // Only prune when the schema actually enumerates its properties and does not opt into
  // extras. A schema with additionalProperties:true accepts anything by design.
  if (!props || typeof props !== "object" || schema.additionalProperties === true) return { args, dropped: [] };
  const allowed = new Set(Object.keys(props));
  const out = {}, dropped = [];
  for (const k of Object.keys(args)) (allowed.has(k) ? (out[k] = args[k]) : dropped.push(k));
  // Never strip a required key even if the schema is malformed — surface it and let the
  // harness complain, rather than silently sending an incomplete call.
  for (const r of schema.required || []) if (r in args && !(r in out)) { out[r] = args[r]; }
  return { args: out, dropped };
}
// Prune by tool name, logging what was removed so it is never silent.
function pruneByName(registry, name, args) {
  const { args: pruned, dropped } = pruneToolArgs(registry?.schema?.(name), args);
  if (dropped.length) log(`  ! ${name}: dropped ${dropped.length} argument(s) not in its schema: ${dropped.join(", ")}`);
  return pruned;
}

// The model's argument bytes -> arguments, strictly. Throws TranslationError rather than
// returning a value, because there is no safe value to return: `{}` is not "no arguments", it is
// a complete executable call whose arguments were lost. `Bash({})` and `Write({})` are
// indistinguishable to the agent from calls the model meant to make.
//
// Callers must therefore be prepared to fail the turn. That is the point — the previous behaviour
// could not fail, so it always produced something runnable.
function toolArgs(registry, name, raw) {
  const args = parseToolArguments(raw, { toolName: name, schema: registry?.schema?.(name) });
  return pruneByName(registry, name, args);
}

// ---- tool selection ----
// Keep essential tools first, then fill the remaining slots in the agent's original
// order. Returns what was dropped so it can be logged: a silently truncated tool list
// looks exactly like a model that "chose" not to use a tool.
function selectTools(tools, limit) {
  if (!Array.isArray(tools)) return { tools: [], dropped: [] };
  if (tools.length <= limit) return { tools, dropped: [] };
  const keep = [], rest = [];
  for (const t of tools) (isEssentialTool(t.name) ? keep : rest).push(t);
  const out = keep.slice(0, limit);
  for (const t of rest) { if (out.length >= limit) break; out.push(t); }
  const kept = new Set(out);
  return { tools: out, dropped: tools.filter((t) => !kept.has(t)).map((t) => t.name) };
}

// ---- output shaping ----
//
// Every selector below is ORDER-INVARIANT, deliberately. The hint they build is spliced
// into `instructions` (withFormatHint), which sits in the cached prompt prefix — so if the
// hint text changes, the cache entry for that prefix is gone. Picking "whichever match came
// first in the array" made the hint depend on the agent's tool ORDER, which is not
// something the hint has any reason to care about: swapping two equally-matching tools
// rewrote the instructions and could invalidate a prefix worth ~114k tokens of tool
// schemas. Sorting the candidates costs nothing and removes the whole class.
const pickStable = (tools, re) =>
  (Array.isArray(tools) ? tools : [])
    .map((t) => String(t?.name || ""))
    .filter((n) => re.test(n))
    .sort()[0] || null;

// Names a request's file-writing tool, so the hint can order the model to CALL it by
// name. A generic "write it to a .svg file" reads as advice, and the model answers with
// raw markup plus "save this as pelican.svg" — narrating the action instead of doing it.
const WRITE_TOOL_RE = /^(write|write_file|create_file|fs_write|edit_file|str_replace(_based)?_editor)$/i;
const findWriteTool = (tools) => pickStable(tools, WRITE_TOOL_RE);
// Writing a .svg to disk does NOT display it — that only yields a path the user has to
// open. The harness surfaces a file inline when it is SENT with display:"render", so the
// hint has to name that tool too or the model stops at "here is the file".
const SEND_FILE_TOOL_RE = /^(senduserfile|send_user_file|send_file)$/i;
const findSendFileTool = (tools) => pickStable(tools, SEND_FILE_TOOL_RE);

// The tool that actually paints something into the transcript. In this app that is
// mcp__visualize__show_widget ("Show visual content — SVG graphics, diagrams, charts …
// renders inline alongside your text response") — and it is the LAST of the 214 tools,
// so the old blind slice(0,128) dropped it outright.
//
// Matched against the tool's OWN name, after any mcp__server__ prefix is stripped. The
// pattern used to be a bare substring test, so anything containing "canvas" or "artifact"
// qualified — slack_create_canvas among them — and a session that merely had Slack
// connected took a different hint branch than the same session without it. Note a leading
// `(^|_)` anchor does not fix that: "_canvas" still matches. The tool has to BE a renderer,
// not merely mention one.
const RENDER_TOOL_RE = /^(show_widget|visuali[sz]e[a-z_]*|artifact|canvas|render_(svg|chart|diagram))$/i;
// mcp__visualize__show_widget -> show_widget; Artifact -> Artifact.
const bareToolName = (n) => String(n || "").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
const findRenderTool = (tools) =>
  (Array.isArray(tools) ? tools : [])
    .map((t) => String(t?.name || ""))
    .filter((n) => RENDER_TOOL_RE.test(bareToolName(n)))
    .sort()[0] || null;

// Tools for inspecting work that runs asynchronously. Without knowing these exist, the
// model answers "I can't show output from a background task" — which is wrong, it just
// has to go and fetch it. Sorted for the same reason as the single-tool selectors: the
// names are interpolated into the hint, so array order would leak into the prefix.
const BG_TOOL_RE = /^(taskoutput|tasklist|taskget|bashoutput)$/i;
const findBgTools = (tools) =>
  (Array.isArray(tools) ? tools : []).map((t) => String(t?.name || "")).filter((n) => BG_TOOL_RE.test(n)).sort();

// Tell the model the things it cannot infer about this client's renderer.
function buildFormatHint(tools) {
  const w = findWriteTool(tools);
  const s = findSendFileTool(tools);
  const r = findRenderTool(tools);
  const bg = findBgTools(tools);
  let picture;
  if (r && w) {
    // Both, always: the render tool draws in the transcript but is a transient, size-capped
    // surface, so the file is the durable artifact. Neither substitutes for the other.
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or chart, ALWAYS do both in the same turn: (1) call \`${r}\` with the SVG/markup so it renders inline in your reply, and (2) call \`${w}\` to save the same SVG to a path ending in .svg so it persists as a file. Then state the saved path in one short line. Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to open, save or download anything — displaying and saving it are your job, not theirs.`;
  } else if (r) {
    // Draws in the transcript. A written file is only a path, so rendering comes first.
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or chart, call \`${r}\` with the SVG/markup so it renders inline in your reply. Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to open, save or download anything — displaying it is your job, not theirs.`;
  } else if (w && s) {
    // The full path to something the user actually SEES: create the file, then display it.
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or SVG, do BOTH of these in the same turn: (1) call \`${w}\` to save it to a path ending in .svg, then (2) call \`${s}\` with that path and display:"render" so it is displayed inline. Step 2 is what the user actually sees — a written file alone only gives them a path to open, which does not satisfy "render". Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to open, save or download the file — displaying it is your job, not theirs.`;
  } else if (s) {
    picture = `- Pictures, diagrams and SVG: produce the .svg file and then call \`${s}\` with display:"render" so it is displayed inline. Do NOT tell the user to open or download it.`;
  } else if (w) {
    picture = `- Pictures, diagrams and SVG: when asked to draw, render, show or produce an image, diagram or SVG, you MUST call the \`${w}\` tool to save it to a path ending in .svg, and then reference that path. Do NOT paste raw <svg> markup as the deliverable, and do NOT tell the user to save, copy, or open it themselves — creating the file is your job, not theirs.`;
  } else {
    picture = "- Pictures, diagrams and SVG: you have no file tool in this turn, so return the SVG inside a ```svg fenced code block. Do NOT instruct the user to save, copy, or open a file.";
  }
  // Async tools hand back a run summary, not each internal step's stdout. That is a real
  // constraint, but "I can't show you the output" is the wrong conclusion: the output is
  // retrievable, and an unannounced background task looks like a hang.
  const background = bg.length
    ? `- Long-running and background work: state clearly when you start something in the background and what it is doing, so the session never looks stalled. Asynchronous tools (Agent/Workflow/background shell) return a run summary rather than each step's raw output — when the user wants the actual output, fetch it with ${bg.map((n) => `\`${n}\``).join(" / ")} and paste the relevant part into your reply, or run the steps directly in the foreground instead. Never tell the user that output is unavailable or that you cannot show it: retrieve it, or say plainly which foreground command you will run to produce it.`
    : "- Long-running work: state clearly when you start something that will take a while, and report progress as you go, so the session never looks stalled. If output for a step is not available to you, say which command you will run in the foreground to produce it rather than saying it cannot be shown.";
  return [
    "",
    "## Output formatting for this client",
    "- Math: use $...$ for inline math and $$...$$ for display math. Do NOT use \\( \\) or \\[ \\] — this client renders those literally.",
    picture,
    background,
    "- Carry out requests with the tools available to you instead of describing what the user should do.",
    "- Always say something in words. Every turn must contain text, including turns whose main content is a tool call: write one short line naming what you are about to do and why before calling it. A turn that is only a tool call shows the user a bare chip with no explanation.",
    "- Be verbose in your final answer: state what you did, what you found, the evidence for it, and anything you could not verify. Prefer a complete explanation over a terse one.",
  ].join("\n");
}

// Run the task to completion instead of stopping to ask whether to continue. The carve-out
// matters as much as the directive: this must not talk the model out of pausing for things
// that genuinely need a human — destructive or outward-facing actions, real ambiguity.
function buildPersistenceHint() {
  return [
    "",
    "## Working autonomously",
    "- Keep working until the user's request is fully resolved, and only then end your turn. Do not end a turn to ask whether you may take a step you are already able to take.",
    "- Once the request IS fully answered, stop. You may briefly suggest an optional next step, but do not carry it out unless the user asks — finishing is also part of doing the job well.",
    "- Never reply with an offer to act — \"If you want, I can…\", \"Shall I…\", \"Let me know and I'll…\" — when you have the tools to do it. Do it now, then report what you found. Investigation and read-only steps never need permission.",
    "- When the work has several steps, carry out all of them in order, reporting as you go. Do not stop after the first step to ask for confirmation to continue.",
    "- If something fails, try the alternatives available to you before handing the problem back to the user.",
    "- Never say that work is running, started, queued or happening in the background unless a tool call in this turn actually started it. If you have not started it, say so plainly or start it now — a user told that something is running will wait for a result that never comes.",
    // The observed stall: asked for the most recently abandoned Gerrit CLs, the model
    // replied "which Gerrit host/project should I query?" and ended the turn. That detail
    // was discoverable from git remotes, dotfiles and the project's own memory files.
    "- Missing details are something to go and find, not a reason to stop. Before asking the user for a value you could discover yourself — a host, URL, path, account, project or branch name — look for it with the tools you have: git remotes and config, dotfiles and config files in the repo, the environment, CLAUDE.md and memory files, and earlier sessions. Only ask if that search actually fails, and then say what you already tried.",
    "- Do stop and ask when the next action is destructive, irreversible, or sends something outward; when you need a credential or a decision only the user can make; or when the request is genuinely ambiguous in a way that changes what you would build. In those cases state exactly what you need and why.",
    "",
    // Issue #7. Working autonomously for many turns is opaque: the session shows tool cards
    // and, for a task change, only a collapsed label. Narration is the only thing that makes
    // a long unattended run followable. The last bullet is the guard — "be verbose" invites
    // padding, which is what issue #1 complained about.
    "## Narrating your work",
    "- Say what you are doing as you go. Before starting a new step, write one short line naming what you are about to do and why. One line per step, not per tool call.",
    "- When a step finishes, say what actually came back — the number, the filename, the error, the verdict. Do not just move on to the next tool call in silence.",
    "- When you add, start or finish a task, restate the list in your text: what you just finished, what you are starting, and what is left. The task tools do not show this to the user, so if you do not write it down nobody sees it.",
    "- Narration is information, never padding. No restating the request back, no announcing what you are about to summarise, no \"great question\", no filler adjectives. If a line would not tell the user something new, leave it out.",
  ].join("\n");
}

// enable=false for the safety-classifier call: it is a separate LLM with its own
// expected output shape, and appending these rules to its prompt is off-task.
const withFormatHint = (sys, enable = true, tools = null) => {
  if (!enable) return sys;
  const parts = [];
  if (OUTPUT_FIXUPS) parts.push(buildFormatHint(tools));
  if (PERSISTENCE) parts.push(buildPersistenceHint());
  return parts.length ? `${sys || ""}\n${parts.join("\n")}` : sys;
};

// Rewrite TeX delimiters the renderer doesn't understand into the ones it does.
// Stateful and streaming-safe: text arrives in arbitrary chunks, so a delimiter or a
// ``` fence can straddle a chunk boundary. Never rewrites inside a fenced code block,
// which would corrupt code samples (and LaTeX shown *as* code).
function makeMathFixer() {
  let carry = "";        // trailing bytes that might start a fence/delimiter
  let inFence = false;
  // Replacer FUNCTIONS, not strings: "$$" in a replacement string means a literal
  // single "$", which would silently turn display math into inline math.
  const rewrite = (s) => s
    .replace(/\\[[\]]/g, () => "$$")
    .replace(/\\[()]/g, () => "$");
  function process(text, final) {
    let s = carry + text;
    carry = "";
    let out = "";
    for (;;) {
      const i = s.indexOf("```");
      if (i !== -1) {
        // Consume complete fences FIRST. Holding a tail back before this would split a
        // chunk that ends in exactly ``` (keeping 2 backticks, emitting 1), so the fence
        // would never be recognised and the in/out-of-code state would invert.
        const seg = s.slice(0, i);
        out += (inFence ? seg : rewrite(seg)) + "```";
        inFence = !inFence;
        s = s.slice(i + 3);
        continue;
      }
      // No complete fence remains. Hold back a tail that could still grow into one, or
      // into a \x delimiter, so it is never rewritten or emitted half-formed.
      if (!final) {
        const m = s.match(/(`{1,2}|\\)$/);
        if (m) { carry = m[0]; s = s.slice(0, -m[0].length); }
      }
      out += inFence ? s : rewrite(s);
      break;
    }
    return out;
  }
  return {
    push: (text) => (OUTPUT_FIXUPS ? process(String(text ?? ""), false) : String(text ?? "")),
    flush: () => (OUTPUT_FIXUPS && carry ? process("", true) : ""),
  };
}
// One-shot form for non-streaming responses.
function fixMath(text) {
  if (!OUTPUT_FIXUPS || !text) return text;
  const f = makeMathFixer();
  return f.push(text) + f.flush();
}

// ---- task echo (issue #7) ----
//
// When the agent changes its task list the session shows only a collapsed label. That is not
// something this build can restyle: the chat UI is the remote claude.ai app. What the tools
// hand back carries no list either — verified in CLI 2.1.217:
//   TaskUpdate -> "Updated task #3 status"
//   TodoWrite  -> "Todos have been modified successfully. Ensure that you continue to use…"
//   TodoWrite's renderToolUseMessage() returns null
// The full list appears in exactly one place, a NUDGE that only fires when the task tools have
// been idle ("Here are the existing tasks:\n\n#1. [completed] …"), and it is marked isMeta.
//
// So the proxy renders the list itself, as a text block next to the tool call. It is a
// rendering of what the model actually did — read from its own tool-call arguments and from
// the transcript — never invented.
const TASK_ECHO = CFG.OPENAI_TASK_ECHO;
const taskToolKind = (name) => (
  name === "TaskCreate" ? "create" :
  name === "TaskUpdate" ? "update" :
  name === "TodoWrite" ? "todos" : null);

const STATUS_MARK = { completed: "x", in_progress: "~", pending: " " };
const newTaskState = () => ({ byId: new Map(), todos: null, created: [], changed: [] });

// "#1. [completed] Assemble runnable app tree" — the exact shape the CLI's task_reminder
// builds (`#${o.id}. [${o.status}] ${o.subject}`), which is the only authoritative list the
// proxy ever sees.
const REMINDER_LINE_RE = /^#(\S+)\.\s*\[([a-z_]+)\]\s*(.+)$/gm;
function parseTaskReminder(text) {
  const out = [];
  if (!text || !text.includes("Here are the existing tasks")) return out;
  const after = text.slice(text.indexOf("Here are the existing tasks"));
  for (const m of after.matchAll(REMINDER_LINE_RE)) out.push({ id: m[1], status: m[2], subject: m[3].trim() });
  return out;
}

function applyTaskCall(state, name, input) {
  const kind = taskToolKind(name);
  if (!kind || !input || typeof input !== "object") return false;
  if (kind === "todos") {
    // TodoWrite always carries the WHOLE list, so this echo is exact and complete.
    if (Array.isArray(input.todos)) { state.todos = input.todos; return true; }
    return false;
  }
  if (kind === "create") {
    // Ids are assigned server-side, so a create has no id to show yet — say so rather than
    // inventing one.
    const list = Array.isArray(input.tasks) ? input.tasks : [input];
    let any = false;
    for (const t of list) {
      const subject = t?.subject || t?.content || t?.description;
      if (subject) { state.created.push({ subject: String(subject), status: t?.status || "pending" }); any = true; }
    }
    return any;
  }
  const id = input.taskId ?? input.id;
  if (id == null) return false;
  const key = String(id);
  const prev = state.byId.get(key) || { status: "pending", subject: "" };
  const next = { status: input.status || prev.status, subject: input.subject || prev.subject };
  state.byId.set(key, next);
  const fields = ["status", "subject", "description", "owner", "activeForm"].filter((f) => input[f] !== undefined);
  state.changed.push({ id: key, from: prev.status, to: next.status, fields });
  return true;
}

// Rebuild what the list looked like BEFORE this turn, from the transcript alone: the reminder
// blocks give ids/subjects/statuses, and replaying earlier task tool calls carries forward
// changes made after the last reminder.
function collectPriorTasks(body) {
  const state = newTaskState();
  for (const m of body?.messages || []) {
    const content = m?.content;
    if (typeof content === "string") {
      if (m.role === "user") for (const t of parseTaskReminder(content)) state.byId.set(t.id, { status: t.status, subject: t.subject });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (m.role === "user" && blk?.type === "text") {
        for (const t of parseTaskReminder(blk.text)) state.byId.set(t.id, { status: t.status, subject: t.subject });
      } else if (m.role === "assistant" && blk?.type === "tool_use") {
        applyTaskCall(state, blk.name, blk.input);
      }
    }
  }
  state.created = [];   // only THIS turn's creations are news
  state.changed = [];
  return state;
}

// Renders the list as a markdown checklist. Returns null when there is nothing worth showing,
// so a no-op task call never adds noise.
function renderTaskEcho(state) {
  const line = (mark, label, text) => `- [${mark}] ${label}${text}`;
  const rows = [];
  if (state.todos) {
    for (const t of state.todos) rows.push(line(STATUS_MARK[t?.status] ?? " ", "", String(t?.content ?? t?.subject ?? "").trim()));
  } else {
    for (const [id, t] of state.byId) rows.push(line(STATUS_MARK[t.status] ?? " ", `#${id} `, t.subject || "(no subject)"));
    for (const c of state.created) rows.push(line(STATUS_MARK[c.status] ?? " ", "", `${c.subject}  _(new)_`));
  }
  if (!rows.length) return null;
  const all = state.todos
    ? state.todos.map((t) => t?.status)
    : [...state.byId.values()].map((t) => t.status).concat(state.created.map((c) => c.status));
  const n = (s) => all.filter((x) => x === s).length;
  const counts = [n("completed") && `${n("completed")} done`, n("in_progress") && `${n("in_progress")} in progress`,
                  n("pending") && `${n("pending")} to do`].filter(Boolean).join(", ");
  return `**Tasks**${counts ? ` — ${counts}` : ""}\n${rows.join("\n")}`;
}

// Non-streaming form of the same echo: replay this message's task calls onto the prior state
// and append one text block. Mutates `msg` in place and returns whether it added anything.
function appendTaskEcho(msg, body, isCls) {
  if (!TASK_ECHO || isCls || !Array.isArray(msg?.content)) return false;
  const calls = msg.content.filter((c) => c.type === "tool_use" && taskToolKind(c.name));
  if (!calls.length) return false;
  const state = collectPriorTasks(body);
  let changed = false;
  for (const c of calls) if (applyTaskCall(state, c.name, c.input)) changed = true;
  if (!changed) return false;
  const echo = renderTaskEcho(state);
  if (!echo) return false;
  msg.content.push({ type: "text", text: `\n\n${echo}\n` });
  log(`  -> task echo: ${echo.split("\n").length - 1} item(s)`);
  return true;
}

// ---- per-request model routing ----
// The needles, the route table, the policy table and the model resolution all live in
// routes.mjs. What stays here is the glue: pulling the sniffed text out of a request, and
// supplying the configured models.

// Claude Code makes several LLM calls that are NOT agent turns: classifiers with a rigid
// output contract. Treating one like an agent turn breaks it, so they are detected here and
// then given the fast model, no injected hints, and no out-of-band reasoning.
//
// There are two families, and only the first used to be recognised:
//
//   1. Bash command-prefix detection: "<policy_spec># Claude Code Code Bash command prefix
//      detection". Answers with a command prefix, or `command_injection_detected`.
//
//   2. The AUTO-MODE SAFETY CLASSIFIER — the call behind "auto mode cannot determine the
//      safety of Bash". Two stages: stage 1 answers "<severity>N</severity> ONLY", stage 2
//      answers "<block>yes</block><category>…</category><reason>…</reason>" or
//      "<block>no</block>", under the instruction "Your ENTIRE response MUST begin with
//      <block>. Do NOT output any analysis, reasoning, or commentary before <block>."
//
// Missing family 2 is what caused issue #6. Its calls went to the slow main model with the
// agent format/persistence hints appended to a prompt that forbids preamble, and with
// hidden reasoning eating the output budget. The CLI retries a few times, then fails
// CLOSED: it denies the action and prints "<model> is temporarily unavailable".
// Needles per family, verified against all 14 real classifier prompts recovered from the
// CLI's own error dumps in /private/tmp/claude-501/auto-mode-classifier-errors.
// The contract lines sit at the END of a long prompt and a real transcript runs to
// megabytes, so sniff the head AND the tail instead of scanning everything.
const SNIFF = 4000;
const ends = (s) => (s.length <= SNIFF * 2 ? s : `${s.slice(0, SNIFF)}\n${s.slice(-SNIFF)}`);
// System and last-user text, sniffed separately. They have to stay separate: a prompt's own
// output contract lives in its SYSTEM text, while the user text is a transcript that may quote
// anything — three of the thirteen real stage-2 prompts contain `<severity>N</severity>`
// mid-conversation, which would label them stage 1 if the two were concatenated first.
function classifierTexts(body) {
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : (body.system || "");
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1];
  let tail = "";
  if (last && last.role === "user") {
    const c = last.content;
    tail = typeof c === "string" ? c
      : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text || "").join("\n") : "";
  }
  return { systemText: ends(String(sys)), tailText: ends(tail) };
}
// The concatenation, kept for the family-level checks and for the tests that assert on it.
function classifierPrompt(body) {
  const { systemText, tailText } = classifierTexts(body);
  return `${systemText}\n${tailText}`;
}
let vetoLogged = false;
// The typed route for a request. One decision per request, made once, and everything downstream
// reads it instead of re-deriving a boolean.
function routeForRequest(body) {
  const { systemText, tailText } = classifierTexts(body);
  return routeFor({
    systemText, tailText,
    toolCount: body.tools?.length ?? 0,
    maxTools: CLASSIFIER_MAX_TOOLS,
    isCompaction: !!compactionKind(body),
    onVeto: (family, n) => {
      if (vetoLogged) return;
      vetoLogged = true;
      log(`  ! a prompt matched the ${family} classifier contract but carries ${n} tools — treating it as a normal agent turn (logged once)`);
    },
  });
}
// "prefix" | "safety" | null, for the log lines and tests that speak in families rather than
// routes. Both safety stages collapse to "safety" here because they share a model and a policy.
function classifierFamily(body) {
  const r = routeForRequest(body);
  return r === ROUTE.PREFIX ? "prefix" : isSafety(r) ? "safety" : null;
}
const isClassifierRequest = (body) => isClassifier(routeForRequest(body));

// WHY A SMALL MODEL IS NOT SAFE HERE, measured by replaying six real classifier requests
// recovered from the CLI's own error dumps through both models:
//   - 3 of the 5 <block>-stage requests disagreed, and every disagreement went one way:
//     gpt-5.3-codex blocked (Production Reads / Production Deploy), gpt-4.1-mini allowed.
//   - on a 6th, gpt-4.1-mini emitted no verdict at all — it echoed the action back as
//     {"tool":"Bash","input":"git -C …"} — which is unparseable, so the CLI retries and can end
//     up reporting the model unavailable. The small model can CAUSE issue #6.
//   - gpt-5.3-codex answered every request in the expected shape, including the stage-1
//     <severity>N</severity> form, in ~2s. Latency was never the problem there, so there is
//     nothing to buy by trading judgment away.
// The classifier's own prompt says to err on the side of blocking, so a more permissive model is
// the wrong direction. This is why the resolution below refuses to inherit a requested model.
//
// Resolve the answering model FROM THE ROUTE. The ordering is the whole point: this used to
// return a requested OpenAI model id before it ever looked at the classifier family, so a safety
// verdict could inherit whatever the picker or CLAUDE_CODE_BG_CLASSIFIER_MODEL named — including
// gpt-4.1-mini, which is in the default picker list and was measured to allow an action
// gpt-5.3-codex blocked. Only ordinary agent turns honour a directly requested model now.
function pickModel(body, route = routeForRequest(body)) {
  return modelForRoute(route, {
    main: OPENAI_MODEL,
    prefixModel: OPENAI_CLASSIFIER_MODEL,
    safetyModel: OPENAI_CLASSIFIER_SAFETY_MODEL,
    safetyModelIsBlank: OPENAI_CLASSIFIER_SAFETY_MODEL === "",
    requestedModel: body.model,
  });
}
// Which API surface a model is served on. OPENAI_API overrides it, and that override used to
// be dead config: USE_RESPONSES was computed at startup and never read, so the documented
// "responses|chat" knob did nothing and every non-codex model was forced onto Chat Completions.
//
// That matters far more than it looks. The app sends 236 tools; Chat Completions caps at 128,
// so being stuck there silently drops 108 of them. It is also the only way to use a model like
// gpt-5.6-sol at all — on Chat Completions it answers
//   "Function tools with reasoning_effort are not supported for gpt-5.6-sol in
//    /v1/chat/completions"
// and fails every tool-using turn outright.
const apiForModel = (model) =>
  (OPENAI_API === "responses" || OPENAI_API === "chat")
    ? OPENAI_API
    : (/codex/i.test(model) ? "responses" : "chat");

// Token usage, mapped into the shape the Anthropic client expects. This is what drives the
// "context left" indicator, and it was reporting nothing usable: on a STREAMED turn — which is
// every real turn — message_start carried input_tokens: 0 and message_delta carried only
// output_tokens, so the client was never told how much context the turn actually used. The
// client never calls /v1/messages/count_tokens either (0 hits across the whole proxy log), so
// there was no second source for it to fall back on.
//
// The one subtlety worth getting right is caching, because the two APIs count it oppositely:
//
//   OpenAI     usage.input_tokens INCLUDES input_tokens_details.cached_tokens
//   Anthropic  input_tokens EXCLUDES cache_read_input_tokens; they are meant to be summed
//
// So the cached portion has to be subtracted out rather than reported twice. A client that adds
// the two together — which is what a context meter does — would otherwise count every cached
// token twice and show the context filling at roughly double the true rate.
function mapUsage(u, surface) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const total = (surface === "chat" ? u.prompt_tokens : u.input_tokens) || 0;
  const out = (surface === "chat" ? u.completion_tokens : u.output_tokens) || 0;
  const cached =
    (surface === "chat" ? u.prompt_tokens_details?.cached_tokens : u.input_tokens_details?.cached_tokens) || 0;
  const usage = { input_tokens: Math.max(0, total - cached), output_tokens: out };
  if (cached > 0) usage.cache_read_input_tokens = cached;
  return usage;
}

function mapFinish(reason, hasTools) {
  if (hasTools) return "tool_use";
  switch (reason) {
    case "length": return "max_tokens";
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "content_filter": return "end_turn";
    default: return "end_turn";
  }
}

// If the model cannot accept images, drop them and say so in the text rather than failing the
// whole turn. Losing the picture is bad; losing the user's question with it is worse.
function stripImages(payload) {
  const note = { chat: "[image omitted: this model does not accept images]",
                 resp: "[image omitted: this model does not accept images]" };
  const out = { ...payload };
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      const kept = m.content.filter((c) => c.type !== "image_url");
      if (kept.length === m.content.length) return m;
      return { ...m, content: [...kept, { type: "text", text: note.chat }] };
    });
  }
  if (Array.isArray(out.input)) {
    out.input = out.input.map((it) => {
      if (!Array.isArray(it.content)) return it;
      const kept = it.content.filter((c) => c.type !== "input_image");
      if (kept.length === it.content.length) return it;
      return { ...it, content: [...kept, { type: "input_text", text: note.resp }] };
    });
  }
  return out;
}

// ---- images (issue #13) ----
//
// Both translators used to replace every image with the literal text
// "[image omitted by proxy]", so pasting a screenshot into a session produced a model that
// confidently discussed an image it had never seen. Anthropic carries images as
//   {type:"image", source:{type:"base64", media_type, data}}   or   {..., source:{type:"url", url}}
// and both OpenAI surfaces accept the same content as a data: URL, just under different keys:
//   chat      -> {type:"image_url",   image_url:{url}}
//   responses -> {type:"input_image", image_url:url}
//
// Returns null for a block that carries no usable source, so a malformed image degrades to
// being skipped rather than sending `undefined` upstream.
function imageUrl(blk) {
  const src = blk?.source;
  if (!src) return null;
  if (src.type === "url" && src.url) return String(src.url);
  if (src.data) return `data:${src.media_type || "image/png"};base64,${src.data}`;
  return null;
}
const IMAGE_REJECTED_RE = /image|vision|multimodal|input_image|image_url/i;

// ---------- request translation: Anthropic -> OpenAI ----------
function toOpenAI(body, model, route = routeForRequest(body)) {
  const policy = policyFor(route);
  // Exposure is decided FIRST, because the system message, the tools array and tool_choice all read
  // it. Declaring it lower down put it in a temporal dead zone for the hint call — the encoder threw
  // on every request until the tests said so.
  const registry = ToolRegistry.from(body.tools);
  const exposure = exposureFor(route);
  const exposedTools = exposure.visibility === VISIBILITY.NONE || !body.tools?.length
    ? []
    : (() => {
        const { tools, dropped } = selectTools(body.tools, MAX_TOOLS_CHAT);
        if (dropped.length) log(`chat cap ${body.tools.length}->${tools.length}; dropped ${dropped.length}: ${dropped.slice(0, 12).join(", ")}${dropped.length > 12 ? ", …" : ""}`);
        return tools;
      })();
  const messages = [];
  let imagesSent = 0, filesSent = 0, notesEmitted = 0;
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((b) => b.text || "").join("\n")
      : body.system;
    // Hints are built from the EXPOSED tools, not from the client's full list. Naming a tool the
    // model cannot see is an instruction it cannot follow — latent until a policy hides something,
    // which is exactly what the exposure policy now does.
    if (sys) messages.push({ role: "system", content: withFormatHint(sys, policy.hints, exposedTools) });
  }
  for (const m of body.messages || []) {
    const content = m.content;
    if (typeof content === "string") { messages.push({ role: m.role, content }); continue; }
    if (!Array.isArray(content)) continue;
    // Same ordered model as the Responses path — see content.mjs. The buckets this replaces lost the
    // interleaving of text and images and dropped anything they had no bucket for.
    const toolCalls = [], toolResults = [], companions = [];
    const parts = decodeBlocks(content);
    for (const blk of content) {
      if (blk.type === "tool_use")
        toolCalls.push({ id: blk.id, type: "function", function: { name: sanitizeToolName(blk.name), arguments: JSON.stringify(blk.input || {}) } });
      else if (blk.type === "tool_result") {
        const { text: resultText, media } = decodeToolResult(blk);
        toolResults.push({ tool_call_id: blk.tool_use_id,
                           content: blk.is_error ? `[tool error] ${resultText}` : resultText });
        // A tool-role message cannot carry media on this surface either, so it follows as a companion
        // user message while the text stays paired with its call.
        if (media.length) companions.push(media);
      }
    }
    if (m.role === "assistant") {
      // Only user turns may carry images on this surface.
      const textOnly = parts.filter((p) => p.kind === "text" || p.kind === "note");
      const msg = { role: "assistant", content: textOnly.map((p) => p.text).join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      for (const tr of toolResults) messages.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
      if (parts.length) {
        imagesSent += countImages(parts);
        filesSent += countFiles(parts);
        notesEmitted += countNotes(parts);
        const serialised = partsToChat(parts);
        // A single text part stays a plain string: that is the shape this surface has always received
        // for an ordinary message, and changing it for every turn would be a gratuitous diff.
        messages.push({ role: "user", content: serialised.length === 1 && serialised[0].type === "text"
          ? serialised[0].text : serialised });
      }
      for (const media of companions) {
        imagesSent += countImages(media);
        messages.push({ role: "user", content: partsToChat(media) });
      }
    }
  }
  const outTokens = Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS);
  // gpt-5.x and o-series require `max_completion_tokens` instead of `max_tokens`;
  // send the right one up front so every call doesn't 400-then-retry.
  const usesCompletionTokens = /^(gpt-5|o[1-9])/.test(model);
  const out = {
    model, messages, stream: !!body.stream,
    ...(usesCompletionTokens ? { max_completion_tokens: outTokens } : { max_tokens: outTokens }),
  };
  const temp = body.temperature ?? DEFAULT_TEMP;
  if (temp != null) out.temperature = temp;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  // The registry validated the WHOLE catalog above, before any cap dropped anything, so a name
  // collision cannot depend on which tools happened to survive.
  if (exposedTools.length) {
    out.tools = exposedTools.map((t) => ({
      type: "function",
      function: { name: registry.wireName(t.name), description: t.description, parameters: t.input_schema },
    }));
  }
  // Resolved against what is ACTUALLY being sent. A tool_choice naming a tool the cap dropped is a
  // 400 whose message points at the parameter rather than at the cause, so it is cleared instead.
  {
    const exposedNames = exposedTools.map((t) => t.name);
    const { choice, cleared, reason } = resolveToolChoice(body.tool_choice, exposedNames, exposure);
    if (cleared && reason) log(`  ! ${reason}`);
    if (choice === "none") out.tool_choice = "none";
    else if (choice === "auto") out.tool_choice = "auto";
    else if (choice === "required") out.tool_choice = "required";
    else if (choice && choice.type === "tool")
      out.tool_choice = { type: "function", function: { name: registry.wireName(choice.name) } };
  }
  if (out.stream) out.stream_options = { include_usage: true };
  // Same cache routing as the Responses path; both surfaces accept the field.
  const cacheKey = cacheKeyFor(body);
  if (cacheKey) out.prompt_cache_key = cacheKey;
  if (notesEmitted) log(`  ! ${notesEmitted} content part(s) could not be translated and were replaced ` +
    `with a labelled note rather than dropped`);
  return { payload: out, registry, imagesSent, filesSent, notesEmitted };
}

// ---------- response translation: OpenAI -> Anthropic (non-streaming) ----------
function toAnthropic(oai, reqModel, registry) {
  const choice = oai.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: fixMath(msg.content) });
  for (const tc of msg.tool_calls || [])
  {
    const nm = registry.originalName(tc.function?.name);
    // Throws on unparseable arguments; the route handler turns that into an error response rather
    // than handing the agent a call it cannot trust.
    content.push({ type: "tool_use", id: tc.id || rid("toolu_"), name: nm,
                   input: toolArgs(registry, nm, tc.function?.arguments) });
  }
  return {
    id: rid("msg_"), type: "message", role: "assistant", model: reqModel,
    content,
    stop_reason: mapFinish(choice.finish_reason, (msg.tool_calls || []).length > 0),
    stop_sequence: null,
    usage: mapUsage(oai.usage, "chat"),
  };
}

// ---------- OpenAI call with a max_tokens/param fallback ----------
async function callOpenAI(payload, isClassifier = false, sessionId = null) {
  const f = isClassifier ? classifierFetch : fetch;
  const doFetch = (body) => f(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify(stripUnsupported(body, "chat")),
  });
  let res = await doFetch(payload);
  if (res.status === 400) {
    const txt = await res.clone().text();
    let retry = null;
    const cap = txt.match(/at most (\d+)/); // "supports at most N completion tokens"
    if (cap) {
      retry = { ...payload };
      const lim = parseInt(cap[1], 10);
      if (retry.max_tokens != null) retry.max_tokens = Math.min(retry.max_tokens, lim);
      if (retry.max_completion_tokens != null) retry.max_completion_tokens = Math.min(retry.max_completion_tokens, lim);
    }
    if (/max_completion_tokens|max_tokens.*not supported|unsupported.*max_tokens/i.test(txt)) {
      const base = retry || payload;
      retry = { ...base, max_completion_tokens: base.max_tokens ?? base.max_completion_tokens };
      delete retry.max_tokens;
    }
    if (/temperature/i.test(txt)) { // some models allow only the default temperature
      retry = { ...(retry || payload) };
      delete retry.temperature;
    }
    // A model without vision rejects the image parts; keep the question, lose the picture.
    if (IMAGE_REJECTED_RE.test(txt) && JSON.stringify(payload).includes("image_url")) {
      log(`  ! ${payload.model} rejected the image(s) — retrying with them removed`);
      retry = stripImages(retry || payload);
    }
    // Generic: the API names the offending parameter, so drop exactly that one and retry.
    // Found by pointing the stock `claude` CLI at the proxy — the CLI sends stop_sequences,
    // this surface forwards them as `stop`, and gpt-5.x rejects it:
    //   "Unsupported parameter: 'stop' is not supported with this model."
    // Twelve 400s in one short session before this existed. Keying off the API's own `param`
    // field means the next unsupported knob self-heals instead of needing its own rule.
    {
      const bad = txt.match(/"param":\s*"([^"]+)"/);
      if (bad && /unsupported_parameter|Unsupported parameter/i.test(txt)) {
        const base = retry || payload;
        // A field that carries meaning is never dropped. Stripping `tools` would turn an agent turn
        // into a text-only one that looks like a model declining to act — and the memo would make it
        // permanent. See SEMANTIC_CONTRACTS.
        if (!isDroppableParam(bad[1])) {
          log(`  !! ${payload.model} rejected '${bad[1]}', which carries meaning — NOT dropping it. ` +
              `Continuing without it would change what was asked for. The upstream error stands.`);
        } else if (base[bad[1]] !== undefined) {
          rememberUnsupported(payload.model, bad[1], "chat");
          retry = { ...base };
          delete retry[bad[1]];
          log(`  ! ${payload.model} rejected '${bad[1]}' — dropped it and retried`);
        }
      }
    }
    if (retry) res = await doFetch(retry);
    // Context window exceeded -> compact and retry (issue #4).
    if (res.status === 400) {
      const t1 = await res.clone().text();
      // Same rule as the Responses surface: a classifier is never judged on a shortened
    // transcript. Fail closed and let Claude Code deny.
    if (CONTEXT_ERROR_RE.test(t1) && isClassifier) {
      log(`  ! a classifier request exceeded the context window — failing closed rather than ` +
          `judging a shortened transcript; Claude Code will deny the action`);
    } else if (CONTEXT_ERROR_RE.test(t1)) {
        let body = retry || payload;
        for (const keep of COMPACT_STEPS.slice(compactStartFor("chat", payload?.model, sessionId))) {
          let { messages, trimmed, reclaimed } = compactChatMessages(body.messages, keep);
          if (!trimmed) {
            ({ messages, trimmed, reclaimed } = compactOversizedChatText(body.messages));
            if (trimmed) log(`  ! no tool results left to trim — truncated an oversized message by ~${Math.round(reclaimed / 4000)}k tokens`);
          }
          if (!trimmed) { log(`  ! context exceeded and nothing left to compact (keep=${keep})`); break; }
          log(`  ! context exceeded — compacted ${trimmed} tool result(s), reclaimed ~${Math.round(reclaimed / 4000)}k tokens (keeping last ${keep} messages); retrying`);
          body = { ...body, messages };
          res = await doFetch(body);
          if (res.status !== 400) { rememberCompact(keep, "chat", payload?.model, sessionId); break; }
          const t2 = await res.clone().text();
          if (!CONTEXT_ERROR_RE.test(t2)) break;
        }
      }
    }
  }
  return res;
}

// ---------- SSE streaming: OpenAI -> Anthropic ----------
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

// `reqModel` is what the CLIENT asked for and is echoed back in the Anthropic message;
// `model` is the OpenAI model that actually answered, which is what the usage ledger must be
// keyed on. They differ on every request (claude-opus-4-8 vs gpt-5.6-sol), and this path used
// to file its usage under the client's name — the only one of the four that did.
async function streamAnthropic(res, upstream, reqModel, registry, model = reqModel) {
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });

  const mathFix = makeMathFixer(); // rewrites TeX delimiters across chunk boundaries
  let textIndex = null;          // anthropic index of the text block, once opened
  const toolBlocks = new Map();  // openai tool index -> {aIndex, started}
  let nextIndex = 0;             // content-block index counter; text is NOT pre-reserved,
                                 // otherwise a tool-only turn leaves a hole at index 0
  let finish = null, usage = null;

  const ensureText = () => {
    if (textIndex === null) {
      textIndex = nextIndex++;
      sse(res, "content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
    }
    return textIndex;
  };

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk; try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const ch = chunk.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) {
        ensureText();
        const fixed = mathFix.push(d.content);
        if (fixed) sse(res, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: fixed } });
      }
      for (const tc of d.tool_calls || []) {
        let tb = toolBlocks.get(tc.index);
        if (!tb) {
          // NO index is reserved and NO content_block_start is emitted yet. The block is opened
          // only once its arguments have arrived and parsed — see the loop after the stream ends.
          // Opening it up front is what made a truncated call unavoidable: the client already held
          // an open tool_use block, so the only remaining choice was which input to put in it, and
          // `{}` was the fallback.
          tb = { started: false, argBuf: "" };
          toolBlocks.set(tc.index, tb);
        }
        if (!tb.toolName && (tc.id || tc.function?.name)) {
          tb.toolName = registry.originalName(tc.function?.name || "");
          tb.callId = tc.id || rid("toolu_");
        }
        if (tc.function?.arguments) tb.argBuf += tc.function.arguments;
      }
    }
  }
  if (textIndex !== null) {
    const tail = mathFix.flush(); // emit any held-back partial delimiter
    if (tail) sse(res, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: tail } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: textIndex });
  }
  // Now that every call is complete, open the ones whose arguments are usable — and only those.
  // A call that cannot be parsed is withheld entirely and fails the turn: the client never sees a
  // tool_use block for it, so there is nothing for the agent to execute.
  let withheld = null;
  let emittedTools = 0;
  for (const tb of toolBlocks.values()) {
    if (!tb.toolName) continue;                 // never got a name; nothing to attribute a call to
    let pruned;
    try { pruned = toolArgs(registry, tb.toolName, tb.argBuf); }
    catch (e) { withheld = withheld || e; log(`  ! withholding ${tb.toolName}: ${e.message}`); continue; }
    const aIndex = nextIndex++;
    sse(res, "content_block_start", { type: "content_block_start", index: aIndex,
        content_block: { type: "tool_use", id: tb.callId || rid("toolu_"), name: tb.toolName, input: {} } });
    sse(res, "content_block_delta", { type: "content_block_delta", index: aIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(pruned) } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: aIndex });
    emittedTools++;
  }
  recordUsage(model, usage?.prompt_tokens, usage?.completion_tokens, usage?.completion_tokens_details?.reasoning_tokens,
              usage?.prompt_tokens_details?.cached_tokens, { route, surface: "chat" });
  // input_tokens goes in the FINAL delta, not message_start: at message_start the upstream has
  // not reported usage yet, and a placeholder there would be double counted by any client that
  // sums the two events. 0 + the truth is the truth either way.
  // A withheld call must not be reported as a normal completion. stop_reason=tool_use would
  // promise a call the client cannot find, and end_turn would present a truncated turn as finished.
  if (withheld) {
    sse(res, "error", { type: "error", error: { type: "api_error", message: withheld.message } });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "error", stop_sequence: null }, usage: mapUsage(usage, "chat") });
  } else {
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: mapFinish(finish, emittedTools > 0), stop_sequence: null }, usage: mapUsage(usage, "chat") });
  }
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ================= OpenAI Responses API path (for codex / responses-only models) =================
// Anthropic Messages -> Responses request
function toResponses(body, model, route = routeForRequest(body)) {
  const policy = policyFor(route);
  // Decided first, for the same reason as in toOpenAI: instructions, tools and tool_choice all read it.
  const registry = ToolRegistry.from(body.tools);
  const exposure = exposureFor(route);
  const exposedTools = exposure.visibility === VISIBILITY.NONE || !body.tools?.length
    ? []
    : (() => {
        // No cap on this surface (verified up to 512), so the agent keeps every tool.
        const { tools, dropped } = selectTools(body.tools, MAX_TOOLS_RESPONSES);
        if (dropped.length) log(`responses cap ${body.tools.length}->${tools.length}; dropped ${dropped.length}`);
        return tools;
      })();
  const input = [];
  let imagesSent = 0, filesSent = 0, notesEmitted = 0;
  for (const m of body.messages || []) {
    const content = m.content;
    if (typeof content === "string") {
      input.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    // ONE ORDERED PASS. The four separate buckets this replaces re-emitted content bucket by bucket,
    // so `[image, text, image]` came out as `[text, image, image]` — the question moved in front of
    // both pictures and which one it referred to was gone. Anything matching no bucket fell out of the
    // loop entirely: a `document` block took its whole message with it. See content.mjs.
    const toolCalls = [], toolResults = [], companions = [];
    const parts = decodeBlocks(content);
    for (const blk of content) {
      if (blk.type === "tool_use")
        toolCalls.push({ type: "function_call", call_id: blk.id, name: sanitizeToolName(blk.name), arguments: JSON.stringify(blk.input || {}) });
      else if (blk.type === "tool_result") {
        const { text: resultText, media } = decodeToolResult(blk);
        toolResults.push({ type: "function_call_output", call_id: blk.tool_use_id,
                           output: blk.is_error ? `[tool error] ${resultText}` : resultText });
        // A function_call_output takes a string, so media cannot live there. The text stays PAIRED
        // with its call — breaking that pairing makes the transcript describe something that never
        // happened — and the media follows as a companion message in deterministic order.
        if (media.length) companions.push(media);
      }
    }
    if (m.role === "assistant") {
      const textOnly = parts.filter((p) => p.kind === "text" || p.kind === "note");
      if (textOnly.length)
        input.push({ role: "assistant", content: [{ type: "output_text", text: textOnly.map((p) => p.text).join("\n") }] });
      for (const tc of toolCalls) input.push(tc);
    } else {
      for (const tr of toolResults) input.push(tr); // tool results are top-level items, not user content
      if (parts.length) {
        imagesSent += countImages(parts);
        filesSent += countFiles(parts);
        notesEmitted += countNotes(parts);
        input.push({ role: "user", content: partsToResponses(parts) });
      }
      for (const media of companions) {
        imagesSent += countImages(media);
        filesSent += countFiles(media);
        input.push({ role: "user", content: partsToResponses(media) });
      }
    }
  }
  const out = { model, input, stream: !!body.stream, max_output_tokens: Math.min(body.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS) };
  // Route this conversation to its own cache node rather than the bucket every session
  // shares by default. Stable for the session's life; see cacheKeyFor.
  const cacheKey = cacheKeyFor(body);
  if (cacheKey) out.prompt_cache_key = cacheKey;
  // Both fields are required for summaries to appear; effort alone or summary alone gives none.
  //
  // Never for a classifier call. Two independent reasons: its prompt asks for reasoning IN
  // BAND, inside <thinking> tags that the CLI parses itself, so out-of-band reasoning is not
  // just useless but a contract violation — the answer must START with the verdict tag. And
  // hidden reasoning is charged to the same output budget, which is how a verdict comes back
  // empty and the CLI concludes the model is unavailable.
  if (policy.reasoning && SHOW_THINKING && out.max_output_tokens >= THINKING_MIN_BUDGET) {
    out.reasoning = { effort: effortFor(model, "responses", route), summary: "detailed" };
  }
  // Verbosity shapes agent prose; a verdict has a fixed shape and does not want padding.
  if (VERBOSITY && policy.verbosity) out.text = { ...(out.text || {}), verbosity: VERBOSITY };
  if (body.system) out.instructions = withFormatHint(Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : body.system, policy.hints, exposedTools);
  // Responses tools are flat: {type,name,description,parameters}
  if (exposedTools.length) {
    out.tools = exposedTools.map((t) => ({
      type: "function", name: registry.wireName(t.name),
      description: t.description, parameters: t.input_schema,
    }));
  }
  {
    const exposedNames = exposedTools.map((t) => t.name);
    const { choice, cleared, reason } = resolveToolChoice(body.tool_choice, exposedNames, exposure);
    if (cleared && reason) log(`  ! ${reason}`);
    if (choice === "none") out.tool_choice = "none";
    else if (choice === "auto") out.tool_choice = "auto";
    else if (choice === "required") out.tool_choice = "required";
    else if (choice && choice.type === "tool")
      out.tool_choice = { type: "function", name: registry.wireName(choice.name) };
  }
  // temperature intentionally omitted — codex/reasoning models only accept the default.
  if (notesEmitted) log(`  ! ${notesEmitted} content part(s) could not be translated and were replaced ` +
    `with a labelled note rather than dropped`);
  return { payload: out, registry, imagesSent, filesSent, notesEmitted };
}

// Returns the Response, and records which body was ACCEPTED on `res.effectivePayload`.
//
// This function silently rewrites the request when the model rejects it: lowering the output cap,
// stripping images, dropping an unsupported parameter, compacting the context, walking the effort
// ladder down. Those fallbacks are why a turn succeeds at all — but only the Response came back,
// so a caller that later retried handed over the ORIGINAL payload and re-triggered every
// rejection it had already worked around (and re-compacted context that was already compacted).
// Attaching the accepted body lets the transport retry replay what actually worked.
async function callResponses(payload, isClassifier = false, sessionId = null) {
  const f = isClassifier ? classifierFetch : fetch;
  let accepted = payload;                        // updated by each fallback that gets used
  const doFetch = (b) => { accepted = b; return f(`${OPENAI_BASE}/responses`, { method: "POST", headers: upstreamHeaders(), body: JSON.stringify(stripUnsupported(b)) }); };
  let res = await doFetch(payload);
  if (res.status === 400) {
    const txt = await res.clone().text();
    const cap = txt.match(/at most (\d+)/);
    if (cap && payload.max_output_tokens != null) res = await doFetch({ ...payload, max_output_tokens: Math.min(payload.max_output_tokens, parseInt(cap[1], 10)) });
    // A model without vision rejects the image parts; keep the question, lose the picture.
    else if (IMAGE_REJECTED_RE.test(txt) && JSON.stringify(payload).includes("input_image")) {
      log(`  ! ${payload.model} rejected the image(s) — retrying with them removed`);
      res = await doFetch(stripImages(payload));
    }
    // Same generic unsupported-parameter recovery as the chat surface above.
    else if (/unsupported_parameter|Unsupported parameter/i.test(txt) && /"param":\s*"([^"]+)"/.test(txt)) {
      const bad = txt.match(/"param":\s*"([^"]+)"/)[1];
      // Same rule as the chat surface: a field that carries meaning is never dropped.
      if (!isDroppableParam(bad)) {
        log(`  !! ${payload.model} rejected '${bad}', which carries meaning — NOT dropping it. ` +
            `Continuing without it would change what was asked for. The upstream error stands.`);
      } else if (payload[bad] !== undefined) {
        rememberUnsupported(payload.model, bad, "responses");
        const { [bad]: _dropped, ...rest } = payload;
        log(`  ! ${payload.model} rejected '${bad}' — dropped it and retried`);
        res = await doFetch(rest);
      }
    }
    // Context window exceeded -> compact the conversation and retry (issue #4).
    //
    // NOT FOR A CLASSIFIER. This was gated only on the connection pool, so an HTTP-path overflow
    // on a safety verdict would shorten the transcript and re-ask — rendering a verdict on
    // evidence the proxy had just discarded, with the dangerous part possibly among what was
    // trimmed. The streaming path already refused (it gates on allowContinue, false for
    // classifiers), so the two paths disagreed about the same request depending only on whether
    // it streamed. Both now fail closed: the error is returned and Claude Code denies the action,
    // which is the correct outcome for a safety check that cannot be completed.
    else if (CONTEXT_ERROR_RE.test(txt) && isClassifier) {
      log(`  ! a classifier request exceeded the context window — failing closed rather than ` +
          `judging a shortened transcript; Claude Code will deny the action`);
    }
    else if (CONTEXT_ERROR_RE.test(txt)) {
      let body = payload;
      for (const keep of COMPACT_STEPS.slice(compactStartFor("responses", payload?.model, sessionId))) {
        let { input, trimmed, reclaimed, summarised } = await compactResponsesInputSummarised(body.input, keep);
        if (!trimmed) {
          ({ input, trimmed, reclaimed } = compactOversizedResponsesText(body.input));
          if (trimmed) log(`  ! no tool results left to trim — truncated an oversized message by ~${Math.round(reclaimed / 4000)}k tokens`);
        }
        if (!trimmed) { log(`  ! context exceeded and nothing left to compact (keep=${keep})`); break; }
        log(`  ! context exceeded — compacted ${trimmed} tool result(s)${summarised ? " (summarised)" : ""}, reclaimed ~${Math.round(reclaimed / 4000)}k tokens (keeping last ${keep} items); retrying`);
        body = { ...body, input };
        res = await doFetch(body);
        if (res.status !== 400) { rememberCompact(keep, "responses", payload?.model, sessionId); break; }
        const t2 = await res.clone().text();
        if (!CONTEXT_ERROR_RE.test(t2)) break;
      }
    }
    // Walk the effort ladder down until the model accepts one.
    else if (payload.reasoning?.effort && /not supported with the .* model/i.test(txt)) {
      let effort = payload.reasoning.effort, next, body = payload;
      while ((next = lowerEffort(payload.model, effort, "responses"))) {
        body = { ...body, reasoning: { ...body.reasoning, effort: next } };
        res = await doFetch(body);
        if (res.status !== 400) break;
        const t2 = await res.clone().text();
        if (!/not supported with the .* model/i.test(t2)) break;
        effort = next;
      }
    }
  }
  // Only meaningful when the request was accepted; on a failure the caller reports the error and
  // does not replay. Non-enumerable so it cannot leak into logs or JSON of the Response.
  try { Object.defineProperty(res, "effectivePayload", { value: accepted, enumerable: false }); } catch { /* frozen Response: replay falls back to the original */ }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Context-size visibility (github issue #17).
//
// The log used to say `input=53`, which is the number of MESSAGES, and out_tokens for the reply. So
// nothing recorded how big a turn's context actually was, and the one thing under investigation —
// why the client compacts so early — was invisible. Worse, `input=` reads like a token count, which
// is actively misleading when the question is "how many tokens are we at".
//
// Everything here is character-based and marked with ~ in the log, because the proxy has no
// tokenizer. chars/4 is a rough estimate and undercounts code and JSON; the authoritative number
// arrives with the response and is logged separately as in_tokens=.
const CHARS_PER_TOKEN_ESTIMATE = 4;
const approxTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN_ESTIMATE);
const kilo = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

// ---- cache routing ----
//
// OpenAI caches a request's PREFIX, and routes each request to a cache node by hashing the
// first tokens of the prompt unless it is told otherwise. Every Claude Code session opens
// with the same CLI system-prompt head, so without a key all concurrently-running sessions
// hash to ONE bucket while carrying DIFFERENT full prefixes — they compete for the same
// node and evict each other. This log shows 35% of requests arriving in a second that
// carried two or more, and 7-13 distinct live tool-block signatures per hour, so the
// contention is real rather than theoretical.
//
// prompt_cache_key is a routing HINT, not a correctness mechanism: an identical prefix
// still hits regardless, and a wrong key can only cost a miss, never a wrong answer. That
// is why it is safe to derive it heuristically.
//
// The key must be STABLE for a conversation's life and DISTINCT between conversations. The
// system prompt plus the first user message satisfy both: fixed once the session starts,
// and different per session (cwd, project instructions, the opening request). Deliberately
// NOT the tool list — it legitimately changes mid-session, and re-keying on it would split
// one conversation across two buckets, which is the problem this exists to avoid.
function cacheKeyFor(body) {
  const sys = Array.isArray(body?.system)
    ? body.system.map((b) => b?.text || "").join("\n")
    : (body?.system || "");
  const first = body?.messages?.[0];
  const firstText = typeof first?.content === "string"
    ? first.content
    : Array.isArray(first?.content)
      ? first.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
      : "";
  if (!sys && !firstText) return null;   // nothing stable to key on; let OpenAI route it
  return crypto.createHash("sha256").update(`${sys}\n \n${firstText}`).digest("hex").slice(0, 32);
}

// What the LAUNCHER configured, for logging only (issue #17). These are reported so a compaction
// line says which client identity and upper bound were in force, and they are deliberately NOT
// used to assert the client's effective window: that resolution happens inside the client from its
// internal suffix, beta headers, base URL, model registry and disable flags, none of which are
// visible in a /v1/messages request.
const CLAUDE_CODE_INTERNAL_MODEL = CFG.OPENAI_CLAUDE_CODE_MODEL;
const CLAUDE_CODE_CONTEXT_BOUND = CFG.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

// The CLI's own compaction calls. It asks the model to summarise the conversation, and there are
// THREE distinct prompts — worth telling apart, because they mean different things about what the
// client keeps afterwards. Taken verbatim from the bundled CLI this app launches, Claude Code
// 2.1.219 under user-data/claude-code/:
//
//   full        "...detailed summary of the conversation so far, paying close attention to the
//                user's explicit requests and your previous actions."
//   continuing  "...detailed summary of this conversation. This summary will be placed at the start
//                of a continuing session..."
//   partial     "...detailed summary of the RECENT portion of the conversation — the messages that
//                follow earlier retained context. The earlier messages are being kept intact..."
//
// Keyed on the distinguishing clause of each rather than the shared opening, so the three do not
// collide. These are recognised for LOGGING ONLY — a compaction call is a normal turn and is routed
// and answered exactly like any other.
const COMPACTION_KINDS = [
  ["partial", /detailed summary of the RECENT portion of the conversation/i],
  ["continuing", /summary will be placed at the start of a continuing session/i],
  ["full", /detailed summary of the conversation so far, paying close attention/i],
];

function compactionKind(body) {
  const parts = [];
  const push = (v) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const b of v) if (typeof b?.text === "string") parts.push(b.text);
  };
  push(body?.system);
  // The instruction arrives as the last user message, so scanning the tail is enough and avoids
  // walking a 200k-character transcript on every single request.
  const msgs = Array.isArray(body?.messages) ? body.messages.slice(-2) : [];
  for (const m of msgs) push(m?.content);
  const text = parts.join("\n");
  for (const [kind, re] of COMPACTION_KINDS) if (re.test(text)) return kind;
  return null;
}

// Size of a request, and where the bulk of it is. `biggest` is the point: an early compaction is
// usually one or two enormous tool results, or the fixed startup overhead, rather than a long
// conversation — and those look identical in a message count.
//
// `total` counts the TOOL SCHEMAS as well as system + messages, which is the correction that made
// issue #17 legible. This app sends ~236 tool definitions, ~121.8k estimated tokens of fixed
// overhead that arrives on turn one, so a total that omitted them understated every Desktop
// request by more than the entire conversation. `content` and `tools` are still reported
// separately, because only one of them shrinks when the client compacts.
//
// Candidate comparison is global and per-ITEM: individual blocks and individual schemas compete
// directly, so a single huge tool_result cannot hide inside its message and the fixed system
// prompt can win when it genuinely is the largest thing present. Inspecting candidates never adds
// to `total` — the aggregate counts system, message content and schemas exactly once each.
//
// This runs on EVERY request, including the latency-sensitive classifier verdicts, so it was
// measured before being left here: on a 955k-character payload (240 messages, 236 tool definitions,
// ~194k tokens estimated) requestShape() takes 0.07ms median / 0.56ms worst, and compactionKind()
// 0.008ms because it only looks at the tail. Nothing worth optimising, and nothing worth worrying
// about against a 60s classifier deadline.
function requestShape(body) {
  const sizeOf = (v) => {
    if (typeof v === "string") return v.length;
    if (Array.isArray(v)) return v.reduce((n, b) => n + sizeOf(b), 0);
    if (v && typeof v === "object") {
      if (typeof v.text === "string") return v.text.length;
      if (typeof v.content === "string") return v.content.length;
      if (v.content) return sizeOf(v.content);
      return JSON.stringify(v).length;
    }
    return 0;
  };
  // One label vocabulary for the log: system | user | assistant | tool_result | tool_use:<name> |
  // tool_schema:<name>. Anything else would make the field unparseable by eye.
  const blockLabel = (blk, role) => {
    if (blk?.type === "tool_result") return "tool_result";
    if (blk?.type === "tool_use") return `tool_use:${blk.name || "?"}`;
    return role || "?";
  };
  let biggest = 0;
  let biggestFrom = "";
  const consider = (n, label) => { if (n > biggest) { biggest = n; biggestFrom = label; } };

  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const system = sizeOf(body?.system);
  let content = system;
  consider(system, "system");
  for (const m of msgs) {
    content += sizeOf(m?.content);
    // Compare the individual blocks, not the message: a message is only a container, and the
    // whole point of this field is naming the one item that dominates.
    if (Array.isArray(m?.content)) {
      for (const blk of m.content) consider(sizeOf(blk), blockLabel(blk, m?.role));
    } else {
      consider(sizeOf(m?.content), m?.role || "?");
    }
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  let toolDefs = 0;
  for (const t of tools) {
    const n = JSON.stringify(t).length;
    toolDefs += n;
    consider(n, `tool_schema:${t?.name || "?"}`);
  }
  return {
    msgs: msgs.length, system, content, toolDefs,
    total: content + toolDefs, tools: tools.length, biggest, biggestFrom,
  };
}

// One formatter for both surfaces. These two log lines were assembled independently and had already
// drifted; a single builder is also what keeps the estimate markers consistent.
function contextFields(shape) {
  return `msgs=${shape.msgs} ~system+messages=${kilo(approxTokens(shape.content))}tok` +
    `${shape.toolDefs ? ` ~tools=${kilo(approxTokens(shape.toolDefs))}tok` : ""}` +
    ` ~total=${kilo(approxTokens(shape.total))}tok` +
    `${shape.biggest ? ` biggest=~${kilo(approxTokens(shape.biggest))}tok/${shape.biggestFrom}` : ""}`;
}

// What each of the client's three prompts actually does with the transcript. "Discards the
// transcript" was true only of the full path, and saying it for all three misdescribed the client.
const COMPACTION_EFFECT = {
  full: "replaces the conversation-so-far path with the summary",
  continuing: "places the summary at the start of a continuing session, with newer messages after it",
  partial: "summarises only the recent portion and keeps earlier retained context intact",
};

// The compaction warning. Deliberately narrow about what the proxy can and cannot know:
//
//   * WHICH prompt family this is — knowable, from the instruction text.
//   * What that family retains — knowable, from the client's own wording.
//   * Whether the user typed /compact or the client fired automatically — NOT knowable here. Both
//     send the same prompt. Only the transcript's compactMetadata.trigger settles it afterwards.
//   * The client's effective context window — NOT knowable here. The proxy reports the configured
//     identity and upper bound, and nothing more.
function compactionWarning(kind, shape, reqModel, model) {
  const cfg = [
    CLAUDE_CODE_INTERNAL_MODEL ? `configured internal identity ${CLAUDE_CODE_INTERNAL_MODEL}` : null,
    CLAUDE_CODE_CONTEXT_BOUND ? `configured upper bound ${kilo(CLAUDE_CODE_CONTEXT_BOUND)}tok` : null,
  ].filter(Boolean).join(", ");
  return `  !! CLIENT-SIDE COMPACTION (${kind}): the client asked us to summarise — it ` +
    `${COMPACTION_EFFECT[kind] || "reorganises its own transcript"}. Request as sent: ` +
    `wire model=${reqModel}->${model} ${contextFields(shape)}. ` +
    `Whether this was automatic or a manual /compact is not visible in the request; the ` +
    `transcript's compactMetadata.trigger records it. ` +
    (cfg ? `Launcher: ${cfg} — an upper bound the client clamps to whatever its internal ` +
      `identity actually resolves to, so early compaction means that resolution came out low ` +
      `(see .openai-model). ` : "") +
    `This is NOT the proxy's own overflow compaction, which only runs after an upstream ` +
    `context error and reports "context exceeded".`;
}

// The input size and how much of it was served from cache, straight from the upstream. Both
// turn-end sites format it through here.
//
// The cached part is ALWAYS printed, including "(0 cached)". It used to be suppressed at zero,
// so the worst possible case — a large turn that hit no cache at all — rendered exactly like a
// turn with no cache reporting, and a `\((\d+) cached\)` scan of the log silently skipped every
// one of them. In this log that hid 361 turns and 47.7M input tokens.
function inTokensField(usage) {
  const u = usage || {};
  if (u.input_tokens == null) return "?";
  const cached = u.input_tokens_details?.cached_tokens || 0;
  return `${u.input_tokens} (${cached} cached)`;
}

// Cache misses are the dominant cost in this proxy: ~96% of input is normally cache reads, so a
// large turn that misses is worth flagging the way a client compaction is. Only above a size
// threshold, and only under a low ratio — a small turn has nothing to reuse, and the FIRST turn
// of any conversation legitimately misses, which the message says rather than implying a bug.
const CACHE_WARN_MIN_TOKENS = 20000;
const CACHE_WARN_MAX_RATIO = 0.5;
function cacheWarning(usage) {
  const u = usage || {};
  const total = u.input_tokens || 0;
  if (total < CACHE_WARN_MIN_TOKENS) return null;
  const cached = u.input_tokens_details?.cached_tokens || 0;
  const ratio = cached / total;
  if (ratio > CACHE_WARN_MAX_RATIO) return null;
  return `  !! CACHE MISS on a large turn: ${total} input tokens, ${cached} from cache ` +
    `(${Math.round(ratio * 100)}%). Normal for the first turn of a conversation, or after the ` +
    `client rewrote its own history. Mid-conversation and repeated, it means the prompt prefix ` +
    `changed — anything edited ahead of the transcript (system text, tool list) invalidates it.`;
}

function logTurnEnd(surface, resp, toolCount, textLen, ms = null) {
  const status = resp?.status || "completed";
  const reason = resp?.incomplete_details?.reason;
  const out = resp?.usage?.output_tokens ?? "?";
  const verdict = toolCount ? `${toolCount} tool call(s)` : (textLen ? "text only — TURN ENDS, agent waits for user" : "EMPTY");
  log(`  <- ${surface}${ms != null ? " " + ms + "ms" : ""} status=${status}${reason ? "/" + reason : ""} in_tokens=${inTokensField(resp?.usage)} out_tokens=${out} text=${textLen}ch -> ${verdict}`);
  const warn = cacheWarning(resp?.usage);
  if (warn) log(warn);
}

function respStopReason(resp, hasTool) {
  if (hasTool) return "tool_use";
  if (resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
  return "end_turn";
}

// Responses (non-streaming) -> Anthropic message
function fromResponses(resp, reqModel, registry) {
  const content = [];
  let hasTool = false;
  // filled in below if nothing else is
  for (const item of resp.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) if (c.type === "output_text" && c.text) content.push({ type: "text", text: fixMath(c.text) });
    } else if (item.type === "function_call") {
      hasTool = true;
      {
        const nm = registry.originalName(item.name);
        content.push({ type: "tool_use", id: item.call_id || item.id, name: nm,
                       input: toolArgs(registry, nm, item.arguments) });
      }
    } // reasoning items are dropped
  }
  if (!content.length) {
    content.push({ type: "text", text: emptyTurnNotice(resp) });
    log("  ! empty turn — substituted a diagnostic notice instead of blank output");
  }
  return {
    id: rid("msg_"), type: "message", role: "assistant", model: reqModel, content,
    stop_reason: respStopReason(resp, hasTool), stop_sequence: null,
    usage: mapUsage(resp.usage, "responses"),
  };
}

// Responses SSE -> Anthropic SSE
// isClassifierPayload is threaded in rather than re-sniffed: every upstream call this function
// makes (transport retry, truncation continuation, auto-continue, context recovery, empty retry)
// must keep using the classifier's reserved connection pool, or a verdict can queue behind agent
// traffic and miss the CLI's fail-closed 60s deadline.
async function streamResponses(res, upstream, reqModel, registry, payload = null, allowContinue = false, taskState = null, isClassifierPayload = false, sessionId = null) {
  // Measured, not inferred. Pairing a request line with a completion line in this log is
  // unreliable because turns overlap — two earlier attempts to answer "how slow is a turn"
  // from the log produced confidently wrong medians (34s, then 483s) before that was noticed.
  const turnStart = Date.now();
  const msgId = rid("msg_");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, "ping", { type: "ping" });
  const items = new Map(); // Responses item_id -> {aIndex, opened, closed}
  let nextIndex = 0, hasTool = false, usage = null, incomplete = false;
  let toolCount = 0, textLen = 0, thinkLen = 0;   // for the turn-end diagnostic
  let taskChanged = false;                       // a task tool ran this turn (issue #7)
  let sawTerminal = null;                        // "completed"|"incomplete"|"failed"|"error", or null if the stream just stopped
  let streamError = null;                        // message from an error / response.failed event
  let refusalText = "";                          // a refusal is content, and must not be retried
  const unknownEvents = new Set();               // SSE event types this proxy does not handle
  let incompleteReason = null;                   // as reported by the API, never assumed
  let toolWithheld = null;                       // a tool call whose arguments could not be parsed
  // One turn, one id, so every attempt under it can be grouped and the two meters told apart.
  const turnId = newTurnId();
  const turnRoute = isClassifierPayload ? "classifier" : "main";
  const turnSessionId = sessionId;   // the real session, for provenance and compaction memory
  let totalOutTokens = 0;                        // cumulative across continuations
  // The index is assigned HERE, at open time, not when the item first appears. That is what lets a
  // tool block be deferred until its arguments parse: an item can exist, accumulate arguments, and
  // still never claim an index or emit a content_block_start.
  const open = (itemId, cb) => {
    let it = items.get(itemId);
    if (!it) { it = { opened: false, closed: false }; items.set(itemId, it); }
    if (it.aIndex === undefined) it.aIndex = nextIndex++;
    if (!it.opened) { sse(res, "content_block_start", { type: "content_block_start", index: it.aIndex, content_block: cb }); it.opened = true; }
    return it;
  };
  const close = (itemId) => {
    const it = items.get(itemId);
    if (it && it.opened && !it.closed) {
      if (it.mathFix) { const tail = it.mathFix.flush(); if (tail) sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: tail } }); }
      sse(res, "content_block_stop", { type: "content_block_stop", index: it.aIndex });
      it.closed = true;
    }
  };

  let turnText = "";        // this upstream's plain text, for the unfulfilled-intent check
  let streamBytes = 0, streamMs = 0;   // to characterise a stream that ends with no terminal event
  // Consume ONE upstream response, emitting into the message already in progress.
  async function consume(up) {
    turnText = "";
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    const startedAt = nowMs();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      streamBytes += value?.length || 0;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      let j; try { j = JSON.parse(t.slice(5).trim()); } catch { continue; }
      switch (j.type) {
        case "response.output_item.added":
          if (j.item?.type === "function_call") {
            toolCount++;
            // DEFERRED. No index, no content_block_start, and hasTool stays false until the
            // arguments have arrived AND parsed. Opening the block here is what made a truncated
            // call unavoidable: once the client holds an open tool_use block the only remaining
            // question is what input to put in it, and `{}` was the answer.
            items.set(j.item.id, {
              opened: false, closed: false, pending: true, argBuf: "",
              toolName: registry.originalName(j.item.name || ""),
              callId: j.item.call_id || j.item.id,
            });
          }
          break;
        // Reasoning summary -> Anthropic thinking block. Deliberately NOT added to
        // turnText: thinking is not a tool call and must not affect the auto-continue
        // decision, which looks only at the model's spoken text.
        case "response.reasoning_summary_part.added":
          if (SHOW_THINKING && j.item_id) open(j.item_id, { type: "thinking", thinking: "" });
          break;
        case "response.reasoning_summary_text.delta":
          if (SHOW_THINKING && j.delta) {
            const it = open(j.item_id, { type: "thinking", thinking: "" });
            thinkLen += String(j.delta).length;
            sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "thinking_delta", thinking: j.delta } });
          }
          break;
        case "response.reasoning_summary_part.done":
          if (j.item_id) close(j.item_id);
          break;
        case "response.output_text.delta":
          {
            const it = open(j.item_id, { type: "text", text: "" });
            if (!it.mathFix) it.mathFix = makeMathFixer();
            textLen += String(j.delta ?? "").length;
            turnText += String(j.delta ?? "");
            const fixed = it.mathFix.push(j.delta);
            if (fixed) sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: fixed } });
          }
          break;
        case "response.function_call_arguments.delta":
          // Accumulate rather than forward: pruning needs the whole JSON object. Tool
          // arguments are small, and the client assembles them before executing anyway.
          { const it = items.get(j.item_id); if (it) it.argBuf = (it.argBuf || "") + (j.delta || ""); }
          break;
        case "response.output_item.done":
          if (j.item?.id) {
            const it = items.get(j.item.id);
            if (it && it.pending) {
              let pruned;
              try {
                pruned = toolArgs(registry, it.toolName, it.argBuf);
              } catch (e) {
                // Withheld. The client never sees a tool_use block for this call, so there is
                // nothing for the agent to execute, and the turn ends with an error below.
                toolWithheld = toolWithheld || e;
                log(`  ! withholding ${it.toolName}: ${e.message}`);
                it.pending = false; it.argBuf = undefined;
                break;
              }
              // Usable: open the block now, fill it, and only now does the turn have a tool.
              open(j.item.id, { type: "tool_use", id: it.callId, name: it.toolName, input: {} });
              sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(pruned) } });
              // Record the task change while the arguments are in hand (issue #7).
              if (taskState && applyTaskCall(taskState, it.toolName, pruned)) taskChanged = true;
              hasTool = true;
              it.pending = false; it.argBuf = undefined;
            }
            close(j.item.id);
          }
          break;
        case "response.completed": usage = j.response?.usage; sawTerminal = "completed"; break;
        case "response.incomplete":
          usage = j.response?.usage;
          incomplete = true;
          sawTerminal = "incomplete";
          // Take the reason the API actually gave. This used to be hardcoded to
          // max_output_tokens, which made the empty-turn notice assert a cause it had not
          // verified and hand out budget advice that might not apply.
          incompleteReason = j.response?.incomplete_details?.reason || incompleteReason || "unknown";
          break;
        // A refusal produces no output_text at all, so without this the turn looked empty and
        // the reason was invisible. Surface it as text: the user is entitled to see it, and a
        // refusal must NOT be retried — the model will refuse again.
        case "response.refusal.delta":
          if (j.delta) {
            const it = open(j.item_id || "__refusal__", { type: "text", text: "" });
            refusalText += String(j.delta);
            textLen += String(j.delta).length;
            sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: String(j.delta) } });
          }
          break;
        // Terminal failures. Neither of these was handled, so an upstream error mid-stream
        // produced a silent empty turn that the notice then blamed on "status=completed".
        case "response.failed":
          sawTerminal = "failed";
          streamError = j.response?.error?.message || j.response?.error?.code || "response.failed with no detail";
          break;
        case "error":
          sawTerminal = sawTerminal || "error";
          streamError = j.message || j.error?.message || j.code || "error event with no detail";
          break;
        default:
          // Unknown events are usually harmless bookkeeping, but a silently-dropped one is
          // exactly how the empty turn hid. Record the names once so the next occurrence is
          // explainable instead of mysterious.
          if (typeof j.type === "string" && !BENIGN_EVENTS.has(j.type)) unknownEvents.add(j.type);
          break;
      }
      }
    }
    streamMs = nowMs() - startedAt;
    if (!sawTerminal) {
      // The fingerprint of the failure in issue-report terms: the upstream hung up without
      // saying completed or incomplete. Recording bytes and duration makes it measurable
      // instead of anecdotal.
      log(`  ! upstream stream ended with NO terminal event after ${streamMs}ms and ${streamBytes} byte(s)`);
    }
    for (const id of items.keys()) close(id);
  }

  // The upstream socket can die mid-body. undici surfaces that as TypeError("terminated") with
  // cause UND_ERR_SOCKET, thrown out of reader.read() — reproduced against a local server that
  // destroys the socket after sending partial SSE; a body that simply ENDS early gives a clean
  // EOF and no error, so this message really does mean the transport broke.
  //
  // It used to escape to the caller's `catch (e) { log("stream error:", e.message); res.end() }`,
  // which ends the turn with whatever had been emitted. 97 turns died that way and NONE was
  // retried: the four loops below all veto on `streamError`, so the guard that correctly stops
  // us re-asking after an upstream REFUSAL also stopped us re-asking after a dropped socket.
  //
  // Retry only while nothing has been emitted. Past the first delta the client already holds
  // content blocks at fixed indices, and a fresh response would renumber them — resuming is the
  // truncation loop's job, not this one. A partial turn is still surfaced, but as an ERROR: see
  // the transportAborted terminal below for why calling it end_turn was the worse bug.
  const emittedAnything = () => hasTool || textLen > 0 || thinkLen > 0 || items.size > 0;
  // Set when the transport broke after the client already held content. The turn is NOT a
  // success and must not be dressed up as one further down: `stop_reason` becomes an explicit
  // error and any half-built tool call is withheld rather than handed over as executable.
  let transportAborted = null;
  let transportRetries = 0;
  for (;;) {
    try {
      // Accumulate inside the loop, adjacent to the consume() it belongs to: a retried pass
      // still produces tokens on the abandoned attempt's behalf only if it got that far, and
      // every consume() in this file must be followed by its own accumulation.
      await consume(upstream);
      totalOutTokens += usage?.output_tokens || 0;
      // One upstream response = one attempt. Recorded HERE rather than at the terminal, because
      // the terminal only ever saw the last `usage` and every earlier attempt was billed and lost.
      recordAttempt({ turnId, sessionId: turnSessionId, kind: KIND.INITIAL, route: turnRoute,
                      surface: "responses", resolvedModel: payload?.model,
                      status: "completed", usage: {
                        grossInput: usage?.input_tokens ?? null, cached: usage?.input_tokens_details?.cached_tokens || 0,
                        output: usage?.output_tokens ?? null,
                        reasoning: usage?.output_tokens_details?.reasoning_tokens || 0 } });
      break;
    } catch (e) {
      if (!isTransportError(e)) throw e;                 // not ours: let the caller report it
      if (emittedAnything()) {
        // Keep what the user already saw, but tell the truth about it. Reporting end_turn here
        // presented a severed turn as a finished answer — and a tool call whose arguments were
        // still mid-flight could go out with `stop_reason: tool_use`, inviting the agent to
        // execute a half-parsed call. Both are worse than an honest failure.
        transportAborted = e.message || "terminated";
        log(`  ! upstream transport failed mid-turn (${transportAborted}) after content was sent` +
            ` — surfacing the partial turn as an error, not a completion`);
        break;
      }
      if (transportRetries >= MAX_TRANSPORT_RETRIES) {
        // Nothing was emitted, so there is no partial answer to keep — but message_start is
        // already on the wire, so ending here would look like a normal empty turn. Say so.
        transportAborted = e.message || "terminated";
        log(`  ! upstream transport failed (${transportAborted}); no retries left after ` +
            `${transportRetries} — reporting an error to the client`);
        break;
      }
      // Same shape as the Anthropic SDK's own connection-error backoff: 0.5s doubling, capped,
      // with jitter so concurrent turns dropped by one upstream blip do not return in lockstep.
      const waitMs = Math.min(500 * 2 ** transportRetries, 4000) * (1 - Math.random() * 0.25);
      transportRetries++;
      log(`  -> upstream transport failed (${e.message}) before any output — retry ` +
          `${transportRetries}/${MAX_TRANSPORT_RETRIES} in ${Math.round(waitMs)}ms`);
      await sleep(waitMs);
      if (!payload) { log("  ! no payload to retry with; giving up"); transportAborted = e.message; break; }
      let up;
      // isCls matters: a classifier turn has its own reserved connection pool precisely so a
      // verdict cannot queue behind agent traffic and blow the CLI's 60s fail-closed deadline.
      // The first call passed it; dropping it on the retry silently demoted the retry to the
      // shared pool — the exact starvation this pool exists to prevent.
      try { up = await callResponses(payload, isClassifierPayload); }
      catch (err) { log(`  -> transport retry fetch failed: ${err.message}`); transportAborted = err.message || e.message; break; }
      if (!up.ok) { log(`  -> transport retry got ${up.status}; giving up`); transportAborted = `upstream ${up.status} on retry`; break; }
      // Replay what was ACCEPTED, not what we first asked for. The initial call may have had its
      // images stripped, effort lowered, a parameter dropped or its context compacted to be
      // accepted at all; retrying the original re-triggers every one of those rejections.
      if (up.effectivePayload && up.effectivePayload !== payload) {
        payload = up.effectivePayload;
        log("  -> retry adopted the upstream-accepted payload (post-fallback), not the original");
      }
      upstream = up;
      sawTerminal = null; streamError = null; incomplete = false; incompleteReason = null;
    }
  }
  // A severed turn skips every recovery loop below. Those loops read `incomplete`/`streamError`
  // and would otherwise try to "continue" a stream whose upstream is gone.
  if (transportAborted) {
    // Withhold any tool call still mid-assembly: its arguments never finished arriving, so the
    // client must not be able to run it. Blocks already closed by consume() stay as they are.
    let withheld = 0;
    for (const [id, it] of items) {
      // `pending` is the deferred state: arguments were still arriving, so no block was ever
      // opened. Nothing has to be un-sent; it just must not be counted as a tool call.
      if (it.pending) { withheld++; it.pending = false; it.argBuf = undefined; }
      close(id);
    }
    if (withheld) log(`  ! withheld ${withheld} incomplete tool call(s) from the client`);
    const detail = `The upstream connection dropped mid-response (${transportAborted}). ` +
      (emittedAnything() ? "The partial output above is incomplete." : "No output was produced.") +
      (transportRetries ? ` Retried ${transportRetries} time(s).` : "");
    log(`  <- responses stream ABORTED after ${Date.now() - turnStart}ms` +
        ` retries=${transportRetries} text=${textLen}ch tools=${toolCount}`);
    // NOT recorded here. Each consume() already recorded its own attempt; recording again at the
    // terminal would double-count the final one — and recording ONLY here is what lost all the
    // others.
    // Anthropic's stream carries in-band errors as an `error` event; a bare res.end() after
    // message_start is a silent EOF the client cannot distinguish from success.
    sse(res, "error", { type: "error", error: { type: "api_error", message: detail } });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "error", stop_sequence: null }, usage: mapUsage(usage, "responses") });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
    return;
  }

  // A tool call whose arguments could not be parsed. Terminates the turn HERE, before any of the
  // continuation paths below: auto-continue, the truncation resume and the empty retry all decide
  // what to do next from `hasTool` and `textLen`, and none of them should run for a turn that is
  // already known to be broken. Continuing would also re-ask the model while the client is still
  // waiting on a promise that a tool call was coming.
  //
  // The call itself was never emitted — no content_block_start, so there is nothing to retract and
  // nothing the agent can execute. All that remains is to say so instead of claiming end_turn.
  if (toolWithheld) {
    for (const [id] of items) close(id);
    log(`  <- responses stream WITHHELD a tool call after ${Date.now() - turnStart}ms` +
        ` text=${textLen}ch tools=${toolCount}`);
    // NOT recorded here. Each consume() already recorded its own attempt; recording again at the
    // terminal would double-count the final one — and recording ONLY here is what lost all the
    // others.
    sse(res, "error", { type: "error", error: { type: "api_error", message: toolWithheld.message } });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "error", stop_sequence: null }, usage: mapUsage(usage, "responses") });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
    return;
  }

  // Continue the turn in place when it was cut off by the output cap (issue #8). The client
  // otherwise surfaces a truncated answer, or errors outright, and the user has to ask again.
  // Each pass appends to the SAME assistant message, so the cumulative budget below is what
  // keeps the spliced result under the client's own per-response maximum.
  let truncContinued = 0;
  // (textLen || hasTool): there must be something to continue FROM. A turn whose whole budget
  // went to reasoning has nothing, and asking it to "continue" just burns two more starved
  // calls — which is what the log shows happening before this guard existed.
  while (CONTINUE_ON_TRUNCATION && allowContinue && payload && incomplete &&
         incompleteReason === "max_output_tokens" && (textLen > 0 || hasTool) &&
         truncContinued < MAX_CONTINUATIONS && totalOutTokens < MAX_TURN_OUTPUT_TOKENS) {
    truncContinued++;
    const remaining = MAX_TURN_OUTPUT_TOKENS - totalOutTokens;
    log(`  -> continue-on-truncation ${truncContinued}/${MAX_CONTINUATIONS}: cut off at the output cap after ${totalOutTokens} token(s); resuming with ${remaining} left`);
    const carry = turnText.slice(-2000);   // enough context to resume mid-sentence
    const next = {
      ...payload,
      max_output_tokens: Math.max(256, Math.min(payload.max_output_tokens || remaining, remaining)),
      input: [...payload.input,
              { role: "assistant", content: [{ type: "output_text", text: turnText }] },
              { role: "user", content: [{ type: "input_text", text:
                "Your previous message was cut off by the output token limit. Continue it from " +
                "exactly where it stopped. Do not repeat anything already written, do not " +
                "restate the question, and do not open with a preamble — resume mid-sentence if " +
                "that is where it ended. The text ended with: " + JSON.stringify(carry) }] }],
    };
    // Reset the per-pass flags so the next consume() reports its own outcome.
    incomplete = false; incompleteReason = null;
    let up;
    try { up = await callResponses(next, isClassifierPayload); } catch (e) { log(`  -> continue-on-truncation fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> continue-on-truncation got ${up.status}; keeping the truncated turn`); break; }
    payload = next;
    await consume(up);
    totalOutTokens += usage?.output_tokens || 0;
    // One upstream response = one attempt. Recorded HERE rather than at the terminal, because
    // the terminal only ever saw the last `usage` and every earlier attempt was billed and lost.
    recordAttempt({ turnId, sessionId: turnSessionId, kind: KIND.TRUNCATION_CONTINUE, route: turnRoute,
                    surface: "responses", resolvedModel: payload?.model,
                    status: "completed", usage: {
                      grossInput: usage?.input_tokens ?? null, cached: usage?.input_tokens_details?.cached_tokens || 0,
                      output: usage?.output_tokens ?? null,
                      reasoning: usage?.output_tokens_details?.reasoning_tokens || 0 } });
  }
  if (incomplete && incompleteReason === "max_output_tokens" && totalOutTokens >= MAX_TURN_OUTPUT_TOKENS) {
    log(`  ! stopped continuing at ${totalOutTokens} output tokens (ceiling ${MAX_TURN_OUTPUT_TOKENS}) to stay under the client's per-response maximum`);
  }

  // Continue the turn in place when the model only SAID it would act.
  let continued = 0;
  let reason;
  while (AUTO_CONTINUE && allowContinue && payload && !hasTool && !incomplete &&
         continued < MAX_CONTINUATIONS &&
         (reason = continueReason(turnText, workDoneThisTurn(payload.input),
                                  backgroundToolUsedThisTurn(payload.input)))) {
    continued++;
    const why = reason === "false-background"
      ? "claimed background work was running but called no tool — nothing was started"
      : "announced an action but called no tool";
    log(`  -> auto-continue ${continued}/${MAX_CONTINUATIONS} (${reason}): ${why}; re-prompting`);
    const nudge = reason === "false-background" ? NUDGE_FALSE_BACKGROUND : NUDGE;
    const next = {
      ...payload,
      input: [...payload.input,
              { role: "assistant", content: [{ type: "output_text", text: turnText }] },
              { role: "user", content: [{ type: "input_text", text: nudge }] }],
    };
    let up;
    try { up = await callResponses(next, isClassifierPayload); } catch (e) { log(`  -> auto-continue fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> auto-continue got ${up.status}; keeping the original turn`); break; }
    payload = next;
    await consume(up);
    // This was missing: an auto-continued pass produced tokens that were never added to the
    // turn total, so out_tokens under-reported every time this loop fired.
    totalOutTokens += usage?.output_tokens || 0;
    // One upstream response = one attempt. Recorded HERE rather than at the terminal, because
    // the terminal only ever saw the last `usage` and every earlier attempt was billed and lost.
    recordAttempt({ turnId, sessionId: turnSessionId, kind: KIND.AUTO_CONTINUE, route: turnRoute,
                    surface: "responses", resolvedModel: payload?.model,
                    status: "completed", usage: {
                      grossInput: usage?.input_tokens ?? null, cached: usage?.input_tokens_details?.cached_tokens || 0,
                      output: usage?.output_tokens ?? null,
                      reasoning: usage?.output_tokens_details?.reasoning_tokens || 0 } });
  }

  // Show the list the agent just changed, since nothing downstream will (issue #7). Emitted
  // as its own text block AFTER the tool calls, so no existing block's indices move.
  if (TASK_ECHO && taskChanged && taskState) {
    const echo = renderTaskEcho(taskState);
    if (echo) {
      const it = open("__tasks__", { type: "text", text: "" });
      sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: `\n\n${echo}\n` } });
      close("__tasks__");
      textLen += echo.length;
      log(`  -> task echo: ${echo.split("\n").length - 1} item(s)`);
    }
  }

  // A context-window overflow can arrive as a mid-stream `error` event on a 200 response, not
  // only as an HTTP 400. The compaction path in callResponses only ever saw the 400 form, so
  // this shape surfaced as an empty turn with no recovery at all — which is what left the
  // "predict cash flow" session unable to answer anything:
  //   error=Your input exceeds the context window of this model. Please adjust your input...
  // Claude Code's own auto-compaction cannot help here: it sizes the window from the model it
  // thinks it is talking to (a 1M-context Claude), not the model actually being called.
  //
  // Gated on allowContinue, so a classifier turn that overflows fails closed rather than being
  // judged on a silently shortened transcript (issue #6).
  let ctxCompacted = 0;
  while (payload && allowContinue && streamError && CONTEXT_ERROR_RE.test(streamError) &&
         !hasTool && textLen === 0 && compactStartFor("responses", payload?.model, sessionId) + ctxCompacted < COMPACT_STEPS.length) {
    const keep = COMPACT_STEPS[compactStartFor("responses", payload?.model, sessionId) + ctxCompacted++];
    let { input, trimmed, reclaimed, summarised } =
      await compactResponsesInputSummarised(payload.input, keep);
    if (!trimmed) {
      ({ input, trimmed, reclaimed } = compactOversizedResponsesText(payload.input));
      if (trimmed) log(`  ! no tool results left to trim — truncated an oversized message by ~${Math.round(reclaimed / 4000)}k tokens`);
    }
    if (!trimmed) { log(`  ! context exceeded mid-stream and nothing left to compact (keep=${keep})`); break; }
    log(`  -> context exceeded mid-stream — compacted ${trimmed} tool result(s)` +
        `${summarised ? " (summarised)" : ""}, reclaimed ~${Math.round(reclaimed / 4000)}k tokens` +
        ` (keeping last ${keep}); retrying`);
    payload = { ...payload, input };
    let up;
    // Unreachable for classifiers today (this loop is gated on allowContinue, which is false for
    // them) — passed anyway so the "every upstream call keeps its pool" invariant holds locally
    // rather than depending on a guard 150 lines away.
    try { up = await callResponses(payload, isClassifierPayload); }
    catch (e) { log(`  -> compaction retry fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> compaction retry got ${up.status}; giving up`); break; }
    streamError = null; sawTerminal = null; incomplete = false; incompleteReason = null;
    await consume(up);
    totalOutTokens += usage?.output_tokens || 0;
    // One upstream response = one attempt. Recorded HERE rather than at the terminal, because
    // the terminal only ever saw the last `usage` and every earlier attempt was billed and lost.
    recordAttempt({ turnId, sessionId: turnSessionId, kind: KIND.CONTEXT_RETRY, route: turnRoute,
                    surface: "responses", resolvedModel: payload?.model,
                    status: "completed", usage: {
                      grossInput: usage?.input_tokens ?? null, cached: usage?.input_tokens_details?.cached_tokens || 0,
                      output: usage?.output_tokens ?? null,
                      reasoning: usage?.output_tokens_details?.reasoning_tokens || 0 } });
  }

  // An empty turn used to be reported and then abandoned, which stalls the session: the user
  // sends a message, waits ~40s, and gets a diagnostic instead of work. Ask again instead.
  //
  // Retried only when retrying can plausibly help. NOT for a refusal (the model will refuse
  // again, and the refusal is the answer), NOT for a truncated turn (the truncation loop above
  // owns that), and NOT for a hard upstream failure reported by error/response.failed.
  let emptyRetries = 0;
  while (payload && shouldRetryEmpty({ enabled: EMPTY_RETRY, allowContinue, hasTool, textLen,
                                       refusalText, streamError, incomplete, incompleteReason,
                                       retries: emptyRetries, maxRetries: MAX_EMPTY_RETRIES })) {
    emptyRetries++;
    log(`  -> empty turn, retry ${emptyRetries}/${MAX_EMPTY_RETRIES}` +
        ` (terminal=${sawTerminal || "none"}${unknownEvents.size ? `, unhandled=[${[...unknownEvents].join(",")}]` : ""})`);
    // Drop reasoning on the retry. A turn that burned ~40s and returned nothing was almost
    // certainly spent reasoning, and asking for the same hidden reasoning again reproduces it.
    const { reasoning, ...retry } = payload;
    let up;
    try { up = await callResponses(retry, isClassifierPayload); } catch (e) { log(`  -> empty-turn retry fetch failed: ${e.message}`); break; }
    if (!up.ok) { log(`  -> empty-turn retry got ${up.status}; giving up on the retry`); break; }
    sawTerminal = null; streamError = null; incomplete = false; incompleteReason = null;
    await consume(up);
    totalOutTokens += usage?.output_tokens || 0;
    // One upstream response = one attempt. Recorded HERE rather than at the terminal, because
    // the terminal only ever saw the last `usage` and every earlier attempt was billed and lost.
    recordAttempt({ turnId, sessionId: turnSessionId, kind: KIND.EMPTY_RETRY, route: turnRoute,
                    surface: "responses", resolvedModel: payload?.model,
                    status: "completed", usage: {
                      grossInput: usage?.input_tokens ?? null, cached: usage?.input_tokens_details?.cached_tokens || 0,
                      output: usage?.output_tokens ?? null,
                      reasoning: usage?.output_tokens_details?.reasoning_tokens || 0 } });
  }

  // Never hand back a blank turn (issue #1).
  if (!hasTool && textLen === 0) {
    // Report what the API actually said. `status` used to be inferred as
    // `incomplete ? "incomplete" : "completed"`, so a stream that ended with NO terminal event
    // at all — which is what every empty turn in the log looked like, all with no usage —
    // was reported as "completed" on no evidence whatsoever.
    const notice = emptyTurnNotice({
      status: streamError ? "failed" : (sawTerminal || "no terminal event"),
      incomplete_details: incompleteReason ? { reason: incompleteReason } : undefined,
      usage, error: streamError, retries: emptyRetries,
      unhandled: unknownEvents.size ? [...unknownEvents] : null,
    });
    const it = open("__empty__", { type: "text", text: "" });
    sse(res, "content_block_delta", { type: "content_block_delta", index: it.aIndex, delta: { type: "text_delta", text: notice } });
    close("__empty__");
    textLen = notice.length;
    log(`  ! empty turn after ${emptyRetries} retr${emptyRetries === 1 ? "y" : "ies"}` +
        ` — terminal=${sawTerminal || "none"}${streamError ? `, error=${streamError}` : ""}` +
        `${unknownEvents.size ? `, unhandled=[${[...unknownEvents].join(",")}]` : ""}`);
  } else if (emptyRetries) {
    log(`  -> recovered after ${emptyRetries} empty-turn retr${emptyRetries === 1 ? "y" : "ies"}`);
  }
  // Also not recorded here, for the same reason: consume() owns attempt accounting now.
  const stop = hasTool ? "tool_use" : (incomplete ? "max_tokens" : "end_turn");
  // in_tokens is the authoritative context size for this turn — the same number the client's context
  // meter uses. Logged on the STREAMING path too, which is every real turn; without it the log
  // recorded only how much was written back, never how full the context was getting.
  log(`  <- responses stream ${Date.now() - turnStart}ms stop_reason=${stop} in_tokens=${inTokensField(usage)} out_tokens=${totalOutTokens || (usage?.output_tokens ?? "?")} text=${textLen}ch` +
      (thinkLen ? ` thinking=${thinkLen}ch` : "") + ` -> ` +
      (toolCount ? `${toolCount} tool call(s)` :
       stop === "max_tokens" ? "hit the output cap mid-turn — agent stops" :
       textLen ? "TEXT ONLY, no tool call — turn ends here and the agent waits for the user" : "EMPTY response"));
  { const warn = cacheWarning(usage); if (warn) log(warn); }
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: mapUsage(usage, "responses") });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ---------- server ----------
function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
}
function sendJSON(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json" }); res.end(s); }
function anthropicError(res, code, type, message) { sendJSON(res, code, { type: "error", error: { type, message } }); }

// ---------- provenance ----------
//
// The client identifies its session on every request:
//   x-claude-code-session-id: 0bfac150-a1d5-4253-86c7-2236cb2f8768
// This was being thrown away, which is why nothing could answer "which model actually wrote this
// session?" after the fact — the stored `model` is the identity the CLIENT selected, not what
// answered, and in OpenAI mode those are never the same thing.
//
// Recorded to a repo-owned sidecar, never into the session files: that directory is a symlink to
// the real Claude Desktop install (issue #3), so both apps write it, and adding unknown keys there
// would be betting that two proprietary apps preserve them through a round trip.
//
// Only writes when something CHANGED. A busy session makes thousands of requests and one epoch.
function recordProvenance(req, body, { route, model, surface }) {
  const sid = req.headers["x-claude-code-session-id"];
  if (!sid) return;
  try {
    // The beta list is the client's OWN account of the capabilities it negotiated, which is
    // stronger evidence than what the launcher configured — those can disagree, and when they do
    // the observed one is what set the context window. Kept separate for exactly that reason.
    const betas = String(req.headers["anthropic-beta"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    const r = provenance.record(sid, {
      kind: "turn",
      provider: provider(),
      wireModel: body.model || null,               // what arrived
      resolvedModel: model,                        // what will answer
      apiSurface: surface,
      route,
      capabilityIdentity: CLAUDE_CODE_INTERNAL_MODEL || null,   // what the launcher configured
      contextBeta: betas.find((b) => /^context-1m-/.test(b)) || null,   // what the client negotiated
      effortBeta: betas.find((b) => /^effort-/.test(b)) || null,
      contextBound: CLAUDE_CODE_CONTEXT_BOUND || null,
      clientVersion: (String(req.headers["user-agent"] || "").match(/claude-cli\/([\d.]+)/) || [])[1] || null,
      configHash: CONFIG_HASH,
      codeVersion: codeVersion(),
      // A launch-time override resolves identically to a persisted value, so without this a
      // temporary `OPENAI_MODEL=x ./run.sh` is indistinguishable from a saved setting forever.
      source: CFG_SOURCES.OPENAI_MODEL === "env" ? "launch override" : "persisted",
    });
    if (r.providerSwitch)
      // Loud, because it means the earlier half of this session was answered by something else.
      // Resuming across providers also carries a persisted model id that is meaningless under the
      // new one, and nothing else in the system says so.
      log(`  !! CROSS-PROVIDER RESUME on session ${sid}: this session was previously answered by ` +
          `${r.providerSwitch.from} and is now being answered by ${r.providerSwitch.to}. Earlier ` +
          `turns are NOT attributable to the current provider or model.`);
    else if (r.written)
      log(`  provenance: ${r.reason} for session ${sid} (${body.model || "?"} -> ${model} via ${surface})`);
  } catch (e) {
    // Never fatal. Losing a provenance record costs a diagnostic; failing a turn over it would
    // trade the thing the user asked for against bookkeeping about it.
    log(`  ! could not record provenance (${e.message})`);
  }
}

// How many turns are being served right now. Reported on /health so a restart can say what it
// would interrupt: a turn is often minutes of real work, and the settings window used to discard
// them without a word. Counted on the response's close rather than after the handler returns,
// because a streaming turn's handler resolves long before the stream ends.
let inflight = 0;

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "POST" && url === "/v1/messages") {
    inflight++;
    res.on("close", () => { inflight--; });
  }
  // /health is an IDENTITY, not a liveness ping. The first four fields are the original
  // response and are kept verbatim so anything already reading them keeps working; everything
  // after is what lets a caller tell "the proxy I configured" from "a proxy".
  //
  // `instance` is the load-bearing one. A launcher that finds a server on the port needs to
  // know whether it may stop it, and the only unforgeable answer is a nonce this process
  // generated at startup and also wrote to its manifest. `configHash` answers the separate
  // question of whether restarting would change anything, and `codeVersion` catches a proxy
  // running last week's translation logic with this week's settings.
  //
  // Nothing here is secret: the key appears only as a one-way fingerprint, and the snapshot
  // omits it entirely. That is checked by test, because this endpoint is unauthenticated.
  if (req.method === "GET" && (url === "/" || url === "/health"))
    return sendJSON(res, 200, {
      ok: true, proxy: "anthropic->openai", model: OPENAI_MODEL, api: OPENAI_API,
      classifier_model: OPENAI_CLASSIFIER_MODEL || null,
      instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT, inflight,
      configHash: CONFIG_HASH, codeVersion: codeVersion(), provider: provider(),
      port: PORT, upstream: OPENAI_BASE,
      // Blank is a real choice now ("use the main model and accept the latency"), so it must not
      // be reported as null — that reads as "unset" and hides which model is judging safety.
      safety_model: OPENAI_CLASSIFIER_SAFETY_MODEL === "" ? OPENAI_MODEL : OPENAI_CLASSIFIER_SAFETY_MODEL,
      safety_model_source: OPENAI_CLASSIFIER_SAFETY_MODEL === "" ? "blank -> main model" : "configured",
      compact_model: COMPACT_MODEL || null,
      claude_code_identity: CLAUDE_CODE_INTERNAL_MODEL || null,
      context_bound: CLAUDE_CODE_CONTEXT_BOUND || null,
      config: CONFIG_SNAPSHOT,
    });

  if (req.method === "GET" && url === "/usage") return sendJSON(res, 200, usageSummary());

  if (req.method === "POST" && url === "/v1/messages/count_tokens") {
    // A malformed body used to parse to `{}` and be answered with input_tokens: 2 — a confident
    // count of a request that could not be read.
    let body;
    try { body = parseRequestBody(await readBody(req), { what: "count_tokens body" }); }
    catch (e) { const r = errorResponse(e); return sendJSON(res, r.status, r.body); }
    const txt = JSON.stringify(body.messages || "") + (body.system ? JSON.stringify(body.system) : "");
    return sendJSON(res, 200, { input_tokens: Math.ceil(txt.length / 4) }); // rough estimate
  }

  if (req.method === "GET" && url === "/v1/models") {
    log(`/v1/models discovery -> ${PICKER_MODELS.map((m) => m.id).join(", ")}`);
    return sendJSON(res, 200, {
      data: PICKER_MODELS.map((m) => ({ type: "model", id: m.id, display_name: m.name, created_at: "2025-01-01T00:00:00Z" })),
      has_more: false, first_id: PICKER_MODELS[0]?.id ?? null, last_id: PICKER_MODELS[PICKER_MODELS.length - 1]?.id ?? null,
    });
  }

  if (req.method === "POST" && url === "/v1/messages") {
    const raw = await readBody(req);
    // Strict from here on. A body that cannot be read is a 400, not an empty conversation: the
    // old `safeParse` returned `{}`, so a truncated or mistyped request was answered as though
    // the client had sent no messages at all.
    let body;
    try {
      body = validateMessagesRequest(hoistInlineSystemMessages(parseRequestBody(raw, { what: "/v1/messages body" })));
    } catch (e) {
      const r = errorResponse(e);
      log(`/v1/messages rejected: ${r.body.error.message}`);
      return sendJSON(res, r.status, r.body);
    }
    const reqModel = body.model || OPENAI_MODEL;
    // Decided once per request: it drives the model choice, hint injection, reasoning and
    // whether the turn may be continued, and it logs when it vetoes a match.
    // The session the client named. Used for provenance and to key the learned compaction level to a
    // conversation rather than to the whole process.
    const sessionId = req.headers["x-claude-code-session-id"] || null;
    const route = routeForRequest(body);                 // one typed decision per request
    const policy = policyFor(route);
    const family = route === ROUTE.PREFIX ? "prefix" : isSafety(route) ? "safety" : null;
    const isCls = isClassifier(route);
    const model = pickModel(body, route);                // FROM THE ROUTE — never inherited
    const useResp = apiForModel(model) === "responses";  // codex -> Responses, else Chat Completions
    // Claude Code's WebSearch is Anthropic's server-side tool; the local model can't run it. When this
    // is that search sub-request, run the search here and inject the results, so it actually works.
    if (WEB_SEARCH_ENABLED) await handleWebSearch(body, { log, proxy: WEB_SEARCH_PROXY });
    dropDisabledMcpTools(body);   // strip MCP tool groups the config disables, before dump/translation
    dumpTools(body.tools);

    // A local backend (Ollama etc.) cannot ingest a PDF the way Anthropic's servers do, so a
    // `document` block would otherwise reach a model that just answers "I can't read PDFs". Extract
    // the text here and hand it over as text — the on-device equivalent of server-side ingestion.
    // No-op for a cloud endpoint (it takes `input_file` itself) and for a turn with no PDF.
    if (IS_LOCAL_ENDPOINT) await localizePdfsInBody(body, { extract: extractPdf });

    // Both encoders build the tool registry, which validates the whole declared catalog. A name
    // collision throws here rather than being sanitized into an alias, because two tools sharing a
    // wire name means a returned call cannot be attributed — see tool-registry.mjs.
    if (useResp) {
      let payload, registry, imagesSent;
      try { ({ payload, registry, imagesSent } = toResponses(body, model, route)); }
      catch (e) {
        const r = errorResponse(e);
        log(`/v1/messages [responses] rejected: ${r.body.error.message}`);
        return sendJSON(res, r.status, r.body);
      }
      const hintOn = policy.hints && (OUTPUT_FIXUPS || PERSISTENCE);
      // `msgs=`, not `input=`: the old name read like a token count and was a message count.
      // ~total includes the tool schemas, biggest= names the single largest item, and the
      // compaction line below fires when the client is asking us to summarise its own transcript.
      recordProvenance(req, body, { route, model, surface: "responses" });
      const shape = requestShape(body);
      const compacting = compactionKind(body);
      log(`/v1/messages [responses] model=${reqModel}->${model} ${contextFields(shape)}` +
        ` stream=${!!payload.stream}${payload.tools ? ` tools=${payload.tools.length}` : ""}` +
        `${imagesSent ? " images=" + imagesSent : ""} hints=${hintOn ? "on" : "off"}` +
        `${routeLabel(route)}${isCls ? " reasoning=off tools=none" : ""}` +
        `${req.headers["x-claude-code-session-id"] ? ` session=${String(req.headers["x-claude-code-session-id"]).slice(0, 8)}` : ""}`);
      if (compacting) log(compactionWarning(compacting, shape, reqModel, model));
      let upstream;
      const startedAt = Date.now();
      try { upstream = await callResponses(payload, policy.reservedPool, sessionId); }
      catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI(responses) fetch failed: ${e.message}`); }
      if (!upstream.ok) {
        const errTxt = await upstream.text();
        log(`OpenAI(responses) ${upstream.status}: ${errTxt.slice(0, 300)}`);
        return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
      }
      if (payload.stream) {
        const mayContinue = policy.continuation && !!payload.tools?.length;
        const taskState = TASK_ECHO && !isCls ? collectPriorTasks(body) : null;
        // Hand the stream the body the upstream ACCEPTED. This first call is where the fallbacks
        // actually fire (images stripped, effort lowered, context compacted), so a later transport
        // retry inside the stream must not resurrect the pre-fallback request.
        const accepted = upstream.effectivePayload || payload;
        try { await streamResponses(res, upstream, reqModel, registry, accepted, mayContinue, taskState, policy.reservedPool, sessionId); }
        catch (e) { log("stream error:", e.message); try { res.end(); } catch {} }
        return;
      }
      { let rj = await upstream.json();
        // Belt and braces for budgets above the threshold that still get starved.
        const starved = rj?.status === "incomplete" &&
          rj?.incomplete_details?.reason === "max_output_tokens" &&
          !(rj.output || []).some((it) => it.type === "message" && (it.content || []).some((c) => c.text));
        if (starved && payload.reasoning) {
          log("  ! empty answer with status=incomplete/max_output_tokens — retrying without reasoning");
          const { reasoning, ...noThink } = payload;
          try {
            // isCls: classifiers take this non-streaming path, so the reserved-pool flag has to
            // ride the retry too. (It cannot fire for them today — a classifier payload carries
            // no `reasoning` — but the routing must not depend on that staying true.)
            const retry = await callResponses(noThink, policy.reservedPool, sessionId);
            if (retry.ok) rj = await retry.json();
          } catch (e) { log(`  ! retry failed: ${e.message}`); }
        }
        recordUsage(model, rj?.usage?.input_tokens, rj?.usage?.output_tokens, rj?.usage?.output_tokens_details?.reasoning_tokens,
                    rj?.usage?.input_tokens_details?.cached_tokens, { route, surface: "responses", requestedModel: reqModel,
                  sessionId: req.headers["x-claude-code-session-id"] || null });
        // fromResponses throws when a tool call's arguments cannot be parsed. Nothing has been
        // sent yet on this path, so the failure becomes a clean error response rather than a
        // tool_use block the agent would execute with empty input.
        let msg;
        try { msg = fromResponses(rj, reqModel, registry); }
        catch (e) {
          const r = errorResponse(e);
          log(`  ! ${r.body.error.message}`);
          return sendJSON(res, r.status, r.body);
        }
        appendTaskEcho(msg, body, isCls);
        if (isCls) {
          // Measured, not inferred: a classifier verdict that approaches the CLI's budget is
          // what produces "temporarily unavailable" and a denied action.
          const ms = Date.now() - startedAt;
          log(`  <- ${routeLabel(route) || "classifier"} verdict in ${ms}ms` +
              (ms >= CLASSIFIER_SLOW_MS
                ? ` — SLOW. The CLI aborts its classifier at 60s and then DENIES the action.`
                : ""));
        }
        logTurnEnd("responses", rj, msg.content.filter((c) => c.type === "tool_use").length,
                   msg.content.filter((c) => c.type === "text").reduce((n, c) => n + c.text.length, 0),
                   Date.now() - startedAt);
        return sendJSON(res, 200, msg); }
    }

    let payload, registry, imagesSent;
    try { ({ payload, registry, imagesSent } = toOpenAI(body, model, route)); }
    catch (e) {
      const r = errorResponse(e);
    recordProvenance(req, body, { route, model, surface: "chat" });
      log(`/v1/messages [chat] rejected: ${r.body.error.message}`);
      return sendJSON(res, r.status, r.body);
    }
    const shape = requestShape(body);
    const compacting = compactionKind(body);
    log(`/v1/messages [chat] model=${reqModel}->${model} ${contextFields(shape)}` +
      ` stream=${!!payload.stream}${payload.tools ? ` tools=${payload.tools.length}` : ""}` +
      `${imagesSent ? " images=" + imagesSent : ""}${routeLabel(route) ? " " + routeLabel(route) : ""}`);
    if (compacting) log(compactionWarning(compacting, shape, reqModel, model));
    let upstream;
    try { upstream = await callOpenAI(payload, policy.reservedPool, sessionId); }
    catch (e) { return anthropicError(res, 502, "api_error", `proxy->OpenAI fetch failed: ${e.message}`); }
    if (!upstream.ok) {
      const errTxt = await upstream.text();
      log(`OpenAI ${upstream.status}: ${errTxt.slice(0, 300)}`);
      return anthropicError(res, upstream.status, "api_error", `OpenAI ${upstream.status}: ${errTxt.slice(0, 500)}`);
    }
    if (payload.stream) { try { await streamAnthropic(res, upstream, reqModel, registry, model); } catch (e) { log("stream error:", e.message); try { res.end(); } catch {} } return; }
    const oai = await upstream.json();
    recordUsage(model, oai?.usage?.prompt_tokens, oai?.usage?.completion_tokens,
                oai?.usage?.completion_tokens_details?.reasoning_tokens,
                oai?.usage?.prompt_tokens_details?.cached_tokens, { route, surface: "chat", requestedModel: reqModel,
                sessionId: req.headers["x-claude-code-session-id"] || null });
    logTurnEnd("chat", { usage: { input_tokens: oai?.usage?.prompt_tokens,
                                  output_tokens: oai?.usage?.completion_tokens,
                                  input_tokens_details: { cached_tokens: oai?.usage?.prompt_tokens_details?.cached_tokens } } },
               (oai?.choices?.[0]?.message?.tool_calls || []).length,
               (oai?.choices?.[0]?.message?.content || "").length);
    { let msg;
      try { msg = toAnthropic(oai, reqModel, registry); }
      catch (e) {
        const r = errorResponse(e);
        log(`  ! ${r.body.error.message}`);
        return sendJSON(res, r.status, r.body);
      }
      appendTaskEcho(msg, body, isCls);
      return sendJSON(res, 200, msg); }
  }

  anthropicError(res, 404, "not_found_error", `no route for ${req.method} ${url}`);
});

// Exported for the unit tests in proxy.test.mjs; set PROXY_NO_LISTEN=1 to import
// this module without binding the port.
export { mapUsage, compactionKind, requestShape, contextFields, compactionWarning, COMPACTION_EFFECT, cacheKeyFor,
         inTokensField, cacheWarning, recordUsage, usageSummary,
         approxTokens, kilo, makeMathFixer, fixMath, selectTools, isEssentialTool, withFormatHint, buildFormatHint,
         buildPersistenceHint, findWriteTool, findSendFileTool, findRenderTool, findBgTools, toolResultText,
         shouldAutoContinue, continueReason, workDoneThisTurn, backgroundToolUsedThisTurn,
         pruneToolArgs, emptyTurnNotice, toolArgs, pruneByName,
         compactResponsesInput, compactChatMessages, CONTEXT_ERROR_RE, COMPACT_STEPS, TRIMMED,
         compactStartFor, rememberCompact,
         compactResponsesInputSummarised, summariseDropped,
         compactOversizedResponsesText, compactOversizedChatText, MAX_TEXT_CHARS,
         isClassifierRequest, classifierFamily, classifierPrompt, CLASSIFIER_RE, PREFIX_RE, SAFETY_RE,
         toResponses, toOpenAI, pickModel,
         taskToolKind, parseTaskReminder, applyTaskCall, collectPriorTasks, renderTaskEcho,
         newTaskState, appendTaskEcho, shouldRetryEmpty, BENIGN_EVENTS,
         rememberUnsupported, stripUnsupported, effortFor, lowerEffort,
         isTransportError, TRANSPORT_ERROR_CODES, MAX_TRANSPORT_RETRIES,
         // Exported so a test can bind it to an ephemeral port and drive a real request through
         // the whole path — the transport retry lives in the streaming loop and cannot be
         // exercised by calling a pure function.
         server };

// ---------- do not let one broken socket kill every other session ----------
//
// Measured, not theoretical. On 08-13 at 05:32:47 this proxy died outright:
//
//   TypeError: terminated
//       at Fetch.onAborted (undici/lib/web/fetch/index.js:2132:49)
//     [cause]: Error: read ETIMEDOUT { errno: -60, syscall: 'read' }
//   Node.js v26.5.0
//
// A single upstream read timed out on ONE long turn. undici turned that socket error into a
// rejection on the fetch's own internal task — not on anything this code was awaiting — so Node
// applied its default --unhandled-rejections=throw and terminated the process. The app, the
// launcher and four live Claude Code agents stayed up pointing at a dead port, and every OpenAI
// turn failed to connect until the proxy was restarted by hand.
//
// The transport retry below cannot prevent that: it only sees errors thrown out of `await`. This
// is the backstop that turns "the proxy is gone" into "that one turn failed". It deliberately
// does NOT exit on a transport error, because the cost is asymmetric — one abandoned turn versus
// every concurrent session. A genuine bug (TypeError in our own translation, for instance) still
// exits, because continuing on unknown corrupt state is worse than a restart.
const fatal = (kind, err) => {
  const e = err instanceof Error ? err : new Error(String(err));
  if (isTransportError(e)) {
    // An in-flight turn already got, or will get, its own error path. Nothing to salvage here.
    log(`! ${kind} from a dropped upstream connection (${e.message}) — that turn is lost, staying up`);
    return;
  }
  log(`!! ${kind}: ${e.stack || e.message} — exiting so the supervisor can restart cleanly`);
  process.exitCode = 1;
  // Flush the log before dying: the previous crash's evidence survived only because stdout was
  // already appended to proxy.log. Give the write a beat, then leave.
  setTimeout(() => process.exit(1), 50).unref?.();
};
process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));
process.on("uncaughtException", (err) => fatal("uncaughtException", err));

if (!process.env.PROXY_NO_LISTEN) server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT}  ->  ${OPENAI_BASE} (model ${OPENAI_MODEL}, api ${OPENAI_API})`);
  // Both classifier models, always. The safety model decides whether a risky action is allowed to
  // run, and it did not appear here at all — so the single most consequential routing decision the
  // proxy makes was invisible in its own startup log.
  // A model that will actually be used but has no published rate makes every request through it
  // unpriced. Worth knowing before the bill rather than after.
  {
    const unpriced = unpricedAmong([OPENAI_MODEL, OPENAI_CLASSIFIER_MODEL,
                                    OPENAI_CLASSIFIER_SAFETY_MODEL || OPENAI_MODEL, COMPACT_MODEL]);
    if (unpriced.length)
      log(`  ? no published rate for ${unpriced.join(", ")} — requests on ${unpriced.length > 1 ? "those models" : "that model"} ` +
          `will be counted but not priced (rate table ${RATE_TABLE_VERSION})`);
  }
  log(`classifier routing: prefix=${OPENAI_CLASSIFIER_MODEL || `(main: ${OPENAI_MODEL})`}` +
      ` safety=${OPENAI_CLASSIFIER_SAFETY_MODEL === "" ? `(blank -> main: ${OPENAI_MODEL})` : OPENAI_CLASSIFIER_SAFETY_MODEL}` +
      ` compaction=${COMPACT_MODEL}` +
      ` — a classifier gets no tools, no hints, no reasoning, and fails closed on overflow`);
  // The identity, on one line, so the log says which configuration produced everything after
  // it. Reconstructing this from a log that only recorded the default model was guesswork.
  log(`instance ${INSTANCE} pid ${process.pid} config ${CONFIG_HASH} code ${codeVersion()} provider ${provider()}`);
  // The manifest is what makes this process OWNABLE. Written after listen() succeeds, never
  // before: a manifest claiming a port this process failed to bind would send the launcher to
  // stop a proxy that is not there and reuse one that is.
  try {
    writeManifest({
      instance: INSTANCE, pid: process.pid, startedAt: STARTED_AT, port: PORT,
      configHash: CONFIG_HASH, codeVersion: codeVersion(), provider: provider(),
      // Whether the settings on disk are the whole story. A one-launch
      // `OPENAI_MODEL=x ./run.sh` resolves identically to a persisted value but must not be
      // reported as persisted — that is how a temporary override becomes an unexplained
      // permanent-looking state in the settings window.
      envOverrides: Object.entries(CFG_SOURCES).filter(([, s]) => s === "env").map(([k]) => k),
      repo: REPO,
    });
  } catch (e) {
    // Not fatal. An unwritable manifest costs the launcher its ability to restart this proxy
    // cleanly; it does not stop the proxy from serving, and refusing to serve over it would
    // turn a management inconvenience into an outage.
    log(`  ! could not write the runtime manifest (${e.message}) — restarts will not recognise this process`);
  }
});

// Startup validation. Errors are logged, not thrown: a proxy that refuses to start leaves the
// app pointed at a dead port, which is the exact failure mode this phase exists to remove. The
// operator gets a loud line instead, and a request that genuinely cannot work still fails with
// its own specific error.
for (const w of CONFIG_ISSUES.warnings) log(`  ? config: ${w}`);
for (const e of CONFIG_ISSUES.errors) log(`  ! config: ${e}`);

// Release the manifest on the way out, so nothing later mistakes a dead instance for a live
// one. Both signals, because SIGTERM is the graceful stop and SIGINT is a foreground Ctrl-C.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    const m = readManifest();
    if (m?.instance === INSTANCE) clearManifest();
    log(`received ${sig} — shutting down instance ${INSTANCE}`);
    server.close(() => process.exit(0));
    // A stream in flight must not hold the process open indefinitely.
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}
