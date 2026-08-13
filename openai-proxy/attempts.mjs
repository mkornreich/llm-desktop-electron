// Every upstream request, counted once, and kept apart from what the client was told.
//
// THE BUG. `usage` was a single variable, reassigned by each consume():
//
//   case "response.completed": usage = j.response?.usage; …
//   …
//   recordUsage(payload?.model, usage?.input_tokens, usage?.output_tokens, …)
//
// So a turn that retried, continued, or auto-continued recorded ONLY ITS LAST ATTEMPT. Every
// earlier attempt's input and output — real requests, really billed — never reached the ledger.
// `totalOutTokens` did accumulate across attempts, but it was used for the LOG line and not for
// the ledger, so the two disagreed and the log was the more accurate of the two.
//
// The retries inside callResponses were worse: a parameter retry, an image retry, an effort-ladder
// step and a context compaction each issue a fresh upstream request, and none of them was counted
// at all.
//
// Measured over 45,442 logged turns: 206 such extra requests (0.5%). Small — worth saying plainly,
// because the headline error in this ledger was never the retries. It was the long-context tier,
// which understated the total by 43%. Both are fixed here; only one of them mattered.
//
// TWO METERS, NOT ONE. They answer different questions and must not be added together:
//
//   ATTEMPT accounting   every upstream request, for the bill and the audit. Retries included.
//   TURN accounting      what the client was actually given: the final effective context and the
//                        stitched output. A retry does NOT multiply the client's context meter —
//                        the conversation did not get bigger because the proxy asked twice.
//
// UNKNOWN IS NOT ZERO. An interrupted stream reports no usage. Recording 0 there would say the
// request was free; it says `unknown` instead and counts how often that happened, so a total can
// never quietly rest on absent data.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { priceRequest, isPriced, RATE_TABLE_VERSION, isLongContext } from "./model-registry.mjs";

export const LEDGER_VERSION = 2;

// Why an attempt happened. Every distinct upstream request in the proxy has a kind, so a total can
// be broken down by what caused it rather than being one opaque number.
export const KIND = {
  INITIAL: "initial",
  PARAM_RETRY: "param-retry",              // an unsupported parameter was dropped and resent
  IMAGE_RETRY: "image-retry",              // images stripped after a rejection
  EFFORT_RETRY: "effort-retry",            // reasoning effort walked down the ladder
  OUTPUT_CAP_RETRY: "output-cap-retry",    // max_output_tokens lowered to what the model allows
  CONTEXT_RETRY: "context-retry",          // transcript compacted after an overflow
  REASONING_RETRY: "reasoning-retry",      // reasoning dropped after it ate the whole budget
  TRANSPORT_RETRY: "transport-retry",      // the socket dropped before any output
  TRUNCATION_CONTINUE: "truncation-continue",
  AUTO_CONTINUE: "auto-continue",
  EMPTY_RETRY: "empty-retry",
  COMPACTION_SUMMARY: "compaction-summary",  // the digest call the compactor makes
};

export const newId = () => crypto.randomBytes(8).toString("hex");

// An immutable record of one upstream request. Frozen because an attempt is a historical fact: if a
// later stage could edit it, "how much did this turn cost" would depend on when you asked.
export function makeAttempt({
  attemptId = newId(), parentAttemptId = null, turnId, sessionId = null,
  kind = KIND.INITIAL, route = null, provider = null, surface = null,
  requestedModel = null, resolvedModel = null, payloadFingerprint = null, requestId = null,
  status = "pending", error = null, retryable = null,
  startedAt = null, headersMs = null, firstTokenMs = null, completedMs = null,
  usage = null,
} = {}) {
  const priced = usage ? priceRequest({
    model: resolvedModel,
    grossInput: usage.grossInput,
    cached: usage.cached ?? 0,
    output: usage.output,
  }) : null;
  return Object.freeze({
    attemptId, parentAttemptId, turnId, sessionId, kind, route, provider, surface,
    requestedModel, resolvedModel, payloadFingerprint, requestId,
    status, error, retryable,
    timing: Object.freeze({ startedAt, headersMs, firstTokenMs, completedMs }),
    // null, not zeroes. An interrupted stream measured nothing.
    usage: usage ? Object.freeze({
      grossInput: usage.grossInput ?? null,
      cached: usage.cached ?? null,
      output: usage.output ?? null,
      // Informational only. OpenAI bills reasoning inside output_tokens; adding it would charge it
      // twice, and at effort `max` reasoning is over half of output.
      reasoning: usage.reasoning ?? null,
    }) : null,
    cost: priced ? Object.freeze({ micros: priced.micros, long: priced.long,
                                   rateTableVersion: priced.rateTableVersion }) : null,
    unpriced: !!usage && !isPriced(resolvedModel),
  });
}

// One turn's worth of attempts. Holds the attempts and answers both questions separately.
export class Turn {
  constructor({ turnId = newId(), sessionId = null, route = null } = {}) {
    this.turnId = turnId;
    this.sessionId = sessionId;
    this.route = route;
    this.attempts = [];
  }

  add(attempt) { this.attempts.push(attempt); return attempt; }

  // The bill: every attempt, summed. Retries included, because they were charged.
  attemptTotals() {
    let grossInput = 0, cached = 0, output = 0, reasoning = 0, micros = 0;
    let unknownUsage = 0, unpriced = 0, long = 0;
    let rejected = 0;
    for (const a of this.attempts) {
      // A request the upstream REJECTED (a 400 for an unsupported parameter, an oversized context,
      // an unsupported effort) generated no tokens and was not billed. That is known-zero, not
      // unknown — conflating the two would mark every turn containing a parameter retry as
      // unpriced, which would hide the real unknowns among a crowd of harmless ones.
      if (a.status === "rejected") { rejected++; continue; }
      if (!a.usage || a.usage.grossInput === null) { unknownUsage++; continue; }
      grossInput += a.usage.grossInput || 0;
      cached += a.usage.cached || 0;
      output += a.usage.output || 0;
      reasoning += a.usage.reasoning || 0;
      if (a.cost) { micros += a.cost.micros; if (a.cost.long) long++; }
      else unpriced++;
    }
    return {
      attempts: this.attempts.length,
      grossInput, cached, output, reasoning,
      // null rather than a partial number when something was unpriced or unmeasured: a total that
      // silently omits an attempt is indistinguishable from a complete one.
      micros: unpriced || unknownUsage ? null : micros,
      partialMicros: micros,
      unknownUsage, unpriced, rejected, longContextAttempts: long,
    };
  }

  // What the client got. The LAST attempt's input is the effective context — the conversation did
  // not grow because the proxy asked twice — while output is the stitched total across the
  // continuations that were actually spliced into the reply.
  turnTotals() {
    const measured = this.attempts.filter((a) => a.usage && a.usage.grossInput !== null);
    const last = measured[measured.length - 1] || null;
    const spliced = this.attempts.filter((a) =>
      a.kind === KIND.INITIAL || a.kind === KIND.TRUNCATION_CONTINUE || a.kind === KIND.AUTO_CONTINUE);
    return {
      effectiveGrossInput: last?.usage?.grossInput ?? null,
      effectiveCached: last?.usage?.cached ?? null,
      stitchedOutput: spliced.reduce((n, a) => n + (a.usage?.output || 0), 0),
      attempts: this.attempts.length,
      retries: this.attempts.length - 1,
    };
  }
}

// ---------- the persisted aggregate ----------

const emptyBucket = () => ({ requests: 0, grossInput: 0, cached: 0, output: 0, reasoning: 0, micros: 0 });

export function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    since: null,
    rateTableVersion: RATE_TABLE_VERSION,
    // The v1 aggregate, kept verbatim and labelled. It cannot be priced exactly — the
    // long-context tier is a per-request property and summing destroyed it — so it is carried as a
    // lower bound rather than converted into a number that would look authoritative.
    legacy: null,
    attempts: { total: 0, byKind: {}, unknownUsage: 0, unpriced: 0, rejected: 0, longContext: 0 },
    turns: { total: 0 },
    // Split by tier, because a total that mixes them cannot be checked against a bill.
    byModel: {},
    byRoute: {},
  };
}

export function applyAttempt(ledger, attempt) {
  if (!ledger.since) ledger.since = new Date().toISOString();
  ledger.attempts.total++;
  ledger.attempts.byKind[attempt.kind] = (ledger.attempts.byKind[attempt.kind] || 0) + 1;
  if (attempt.route) ledger.byRoute[attempt.route] = (ledger.byRoute[attempt.route] || 0) + 1;

  if (attempt.status === "rejected") { ledger.attempts.rejected++; return ledger; }
  if (!attempt.usage || attempt.usage.grossInput === null) { ledger.attempts.unknownUsage++; return ledger; }
  if (attempt.unpriced) ledger.attempts.unpriced++;
  if (attempt.cost?.long) ledger.attempts.longContext++;

  const model = attempt.resolvedModel || "unknown";
  const m = (ledger.byModel[model] ||= { short: emptyBucket(), long: emptyBucket(), unpriced: attempt.unpriced });
  const b = attempt.cost?.long ? m.long : m.short;
  b.requests++;
  b.grossInput += attempt.usage.grossInput || 0;
  b.cached += attempt.usage.cached || 0;
  b.output += attempt.usage.output || 0;
  b.reasoning += attempt.usage.reasoning || 0;
  b.micros += attempt.cost?.micros || 0;
  return ledger;
}

// Migrate a v1 aggregate. Deliberately lossy in one direction only: it becomes a labelled lower
// bound and is never folded into the new totals, because doing so would mix an exact figure with an
// estimate and produce something that is neither.
export function migrateLegacy(v1) {
  if (!v1 || v1.version === LEDGER_VERSION) return null;
  const byModel = v1.byModel || {};
  if (!Object.keys(byModel).length) return null;
  let lower = 0, unpriced = 0;
  for (const [model, v] of Object.entries(byModel)) {
    const gross = v.input_tokens || 0;
    // tier: "short" EXPLICITLY. This is an aggregate, so it has no per-request tier — and letting
    // the auto path read the threshold off a multi-billion-token sum would price the whole history
    // at 2x and produce a "floor" above the real figure.
    const p = priceRequest({ model, grossInput: gross, cached: v.cached_input_tokens || 0,
                             output: v.output_tokens || 0, tier: "short" });
    if (p) lower += p.micros; else unpriced++;
  }
  return {
    since: v1.since || null,
    byModel,
    unpricedModels: unpriced,
    lowerBoundMicros: lower,
    // Says exactly why it is a lower bound rather than leaving the reader to wonder.
    note: "Aggregated before per-attempt accounting existed, so it cannot be priced exactly. The " +
      "long-context tier (>272,000 input tokens: 2x input, 1.5x output for the whole request) is a " +
      "property of an individual request, and summing per model destroyed it — so this figure " +
      "prices everything at short-context rates and is therefore a FLOOR, not a cost. Measured over " +
      "44,571 logged turns from this app, 16.3% of requests crossed the threshold and carried 52.3% " +
      "of all input tokens; applying that split puts the real figure about 43% above this floor. " +
      "It also omits retries and continuations, which were never recorded (a further ~0.5% of requests).",
  };
}

// ---------- persistence ----------

export function ledgerPath() {
  // Same test-mode redirection the v1 ledger used, resolved per call rather than at import: a
  // module-level constant is captured before a test can set the variable.
  return process.env.PROXY_USAGE_FILE
    || fileURLToPath(new URL(process.env.PROXY_NO_LISTEN === "1"
        ? "./usage.test-scratch.json" : "./usage.json", import.meta.url));
}

export function loadLedger(file = ledgerPath()) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return emptyLedger(); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return emptyLedger(); }
  if (parsed?.version === LEDGER_VERSION) {
    const l = { ...emptyLedger(), ...parsed };
    // A ledger written by an older rate table must not be added to one priced differently without
    // saying so; the version travels with the totals.
    l.attempts = { ...emptyLedger().attempts, ...(parsed.attempts || {}) };
    l.turns = { ...emptyLedger().turns, ...(parsed.turns || {}) };
    return l;
  }
  // v1, or unrecognised. Never discarded: 51,935 requests of history is worth keeping even when it
  // cannot be priced exactly.
  const l = emptyLedger();
  l.legacy = migrateLegacy(parsed);
  l.since = parsed?.since || null;
  return l;
}

export function saveLedger(ledger, file = ledgerPath()) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
