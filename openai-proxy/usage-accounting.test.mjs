// Pricing and per-attempt accounting.
//   node --test openai-proxy/usage-accounting.test.mjs
//
// Rates are from developers.openai.com/api/docs/pricing, read on 2026-08-13. The long-context rule
// is quoted from the gpt-5.6-sol model page:
//   "Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request."
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  priceRequest, isPriced, rateFor, isLongContext, formatMicros, unpricedAmong,
  LONG_CONTEXT_THRESHOLD, LONG_INPUT_MULTIPLIER, LONG_OUTPUT_MULTIPLIER, RATE_TABLE_VERSION,
} from "./model-registry.mjs";
import {
  makeAttempt, Turn, KIND, emptyLedger, applyAttempt, migrateLegacy,
  loadLedger, saveLedger, LEDGER_VERSION,
} from "./attempts.mjs";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), "usage.json");

// ---------- the threshold ----------

test("the long-context tier turns on strictly above 272,000 input tokens", () => {
  // The wording is "Prompts with >272K input tokens", so 272,000 exactly is still short context.
  // An off-by-one here doubles or halves the price of every request that sits on the boundary.
  assert.equal(LONG_CONTEXT_THRESHOLD, 272_000);
  assert.equal(isLongContext(271_999, "gpt-5.6-sol"), false);
  assert.equal(isLongContext(272_000, "gpt-5.6-sol"), false, "at the threshold is NOT above it");
  assert.equal(isLongContext(272_001, "gpt-5.6-sol"), true);
});

test("crossing the threshold by one token doubles input and adds half again to output", () => {
  const below = priceRequest({ model: "gpt-5.6-sol", grossInput: 272_000, cached: 0, output: 1_000 });
  const above = priceRequest({ model: "gpt-5.6-sol", grossInput: 272_001, cached: 0, output: 1_000 });
  assert.equal(below.long, false);
  assert.equal(above.long, true);
  // input: 272000 * $5/M = $1.36 -> 1_360_000 micro-dollars
  assert.equal(below.breakdown.freshInput, 1_360_000);
  assert.equal(above.breakdown.freshInput, Math.round(272_001 * 5_000_000 / 1_000_000) * LONG_INPUT_MULTIPLIER,
    "input is charged at 2x for the whole request");
  // output: 1000 * $30/M = $0.03 -> 30_000, then 1.5x
  assert.equal(below.breakdown.output, 30_000);
  assert.equal(above.breakdown.output, 45_000);
  assert.equal(above.breakdown.output / below.breakdown.output, LONG_OUTPUT_MULTIPLIER);
});

test("the tier is decided by GROSS input, cache reads included", () => {
  // A 900K-token prompt with a 96% cache hit rate is still a 900K-token prompt. Deciding on fresh
  // input would put this app's largest requests in the cheap tier — exactly backwards, and this
  // app's cache hit rate is ~96%.
  const gross = 900_000, cached = 864_000;      // 4% fresh
  const p = priceRequest({ model: "gpt-5.6-sol", grossInput: gross, cached, output: 100 });
  assert.equal(p.long, true, "gross decides it");
  assert.equal(isLongContext(gross - cached, "gpt-5.6-sol"), false,
    "and fresh input alone would have said otherwise");
  // Cached tokens are charged at 2x their own rate too: 864000 * $0.50/M * 2 = $0.864
  assert.equal(p.breakdown.cachedInput, Math.round(864_000 * 500_000 / 1_000_000) * 2);
});

test("a model with no published long-context tier never gets one", () => {
  // Not an assumption that such requests are cheap: for these models the context window is at or
  // below the threshold, so the tier cannot apply.
  for (const m of ["gpt-5.3-codex", "gpt-4.1", "gpt-4.1-mini", "gpt-5.4-nano", "gpt-5.4-mini"]) {
    assert.equal(rateFor(m).longTier, false, m);
    assert.equal(isLongContext(10_000_000, m), false, `${m} has no long tier to enter`);
    assert.equal(priceRequest({ model: m, grossInput: 500_000, output: 10 }).long, false);
  }
});

// ---------- the rates ----------

test("the published rates are stored exactly, in integer micro-dollars", () => {
  // Read from developers.openai.com/api/docs/pricing. A wrong digit here is a wrong bill estimate
  // that looks precise, which is worse than no estimate.
  const expect = {
    "gpt-5.6-sol":   [5_000_000,   500_000,  30_000_000],
    "gpt-5.6-terra": [2_000_000,   200_000,  12_000_000],
    "gpt-5.6-luna":  [  200_000,    20_000,   1_200_000],
    "gpt-5.4":       [2_500_000,   250_000,  15_000_000],
    "gpt-5.4-mini":  [  750_000,    75_000,   4_500_000],
    "gpt-5.4-nano":  [  200_000,    20_000,   1_250_000],
    "gpt-5.3-codex": [1_750_000,   175_000,  14_000_000],
    "gpt-4.1":       [2_000_000,   500_000,   8_000_000],
    "gpt-4.1-mini":  [  400_000,   100_000,   1_600_000],
  };
  for (const [m, [i, c, o]] of Object.entries(expect)) {
    const r = rateFor(m);
    assert.ok(r, `${m} must be priced`);
    assert.equal(r.input, i, `${m} input`);
    assert.equal(r.cached, c, `${m} cached`);
    assert.equal(r.output, o, `${m} output`);
  }
});

test("the safety model this repository pins is priced", () => {
  // A pinned snapshot with no rate would make every safety verdict unpriced, and there are 20,000
  // of them.
  assert.ok(isPriced("gpt-5.4-2026-03-05"));
  assert.deepEqual(
    [rateFor("gpt-5.4-2026-03-05").input, rateFor("gpt-5.4-2026-03-05").output],
    [rateFor("gpt-5.4").input, rateFor("gpt-5.4").output],
    "a snapshot shares its alias's rates only because that was checked");
});

test("an unknown model is unpriced, never estimated", () => {
  // A plausible number attached to a model nobody verified looks like an answer and cannot be
  // corrected, because nothing records that it was a guess.
  for (const m of ["gpt-6", "gpt-5.6-sol-2027-01-01", "some-finetune", "", null, undefined]) {
    assert.equal(isPriced(m), false, `${m} must not be priced`);
    assert.equal(priceRequest({ model: m, grossInput: 1000, output: 10 }), null);
  }
  assert.deepEqual(unpricedAmong(["gpt-5.6-sol", "gpt-6", "gpt-5.4", null]), ["gpt-6"]);
});

test("unknown usage prices to null, never to zero", () => {
  // Zero claims the request was free. null says it was not measured, and the two must not be summed.
  assert.equal(priceRequest({ model: "gpt-5.6-sol", grossInput: null, output: 5 }), null);
  assert.equal(priceRequest({ model: "gpt-5.6-sol", grossInput: 100, output: null }), null);
  assert.equal(priceRequest({ model: "gpt-5.6-sol", grossInput: 0, output: 0 }).micros, 0,
    "a genuinely empty request is 0, which is different from unknown");
});

test("reasoning tokens are never charged on top of output", () => {
  // OpenAI bills reasoning inside output_tokens. At effort `max` reasoning is over half of output
  // here, so charging it separately would inflate every agent turn by ~57%.
  const a = priceRequest({ model: "gpt-5.6-sol", grossInput: 1000, output: 10_000 });
  const t = new Turn({});
  t.add(makeAttempt({ turnId: "t", resolvedModel: "gpt-5.6-sol",
                      usage: { grossInput: 1000, cached: 0, output: 10_000, reasoning: 5_700 } }));
  assert.equal(t.attemptTotals().micros, a.micros,
    "the cost must not depend on the reasoning breakdown at all");
  assert.equal(t.attemptTotals().reasoning, 5_700, "but it is still reported");
});

test("money is integer micro-dollars, so a total cannot drift with summation order", () => {
  const one = priceRequest({ model: "gpt-5.6-sol", grossInput: 333_333, cached: 111_111, output: 777 });
  assert.equal(Number.isInteger(one.micros), true);
  assert.equal(Number.isInteger(one.breakdown.freshInput), true);
  // Same set, two orders, identical total.
  const parts = [1, 7, 13, 999_999, 3].map((n) =>
    priceRequest({ model: "gpt-5.4", grossInput: n, output: n }).micros);
  const fwd = parts.reduce((a, b) => a + b, 0);
  const rev = [...parts].reverse().reduce((a, b) => a + b, 0);
  assert.equal(fwd, rev);
  assert.equal(formatMicros(1_234_567), "$1.23");
  assert.equal(formatMicros(0), "$0.00");
  assert.equal(formatMicros(null), "unpriced");
});

// ---------- attempts ----------

test("an attempt record is frozen: cost cannot change after the fact", () => {
  const a = makeAttempt({ turnId: "t", resolvedModel: "gpt-5.4",
                          usage: { grossInput: 100, cached: 0, output: 10 } });
  assert.throws(() => { a.usage.output = 999; }, TypeError);
  assert.throws(() => { a.cost.micros = 0; }, TypeError);
  assert.throws(() => { a.timing.completedMs = 1; }, TypeError);
});

test("every attempt in a multi-attempt turn is counted, not just the last", () => {
  // THE BUG. `usage` was one variable, reassigned per consume(), and recordUsage passed the last
  // value — so a retried turn's earlier attempts were billed by OpenAI and invisible here.
  const t = new Turn({ turnId: "t1" });
  const mk = (kind, input, output) => t.add(makeAttempt({
    turnId: "t1", kind, resolvedModel: "gpt-5.6-sol",
    usage: { grossInput: input, cached: 0, output, reasoning: 0 },
  }));
  mk(KIND.INITIAL, 100_000, 500);
  mk(KIND.TRANSPORT_RETRY, 100_000, 0);
  mk(KIND.AUTO_CONTINUE, 101_000, 700);

  const at = t.attemptTotals();
  assert.equal(at.attempts, 3);
  assert.equal(at.grossInput, 301_000, "all three attempts' input is billed");
  assert.equal(at.output, 1_200);
  const expected = [100_000, 100_000, 101_000].reduce((sum, i, n) =>
    sum + priceRequest({ model: "gpt-5.6-sol", grossInput: i, output: [500, 0, 700][n] }).micros, 0);
  assert.equal(at.micros, expected);
});

test("the client's context meter is not multiplied by retries", () => {
  // The conversation did not get bigger because the proxy asked twice. Reporting 301,000 input to
  // the client for a 101,000-token conversation would also push its compaction maths off a cliff.
  const t = new Turn({ turnId: "t1" });
  const mk = (kind, input, output) => t.add(makeAttempt({
    turnId: "t1", kind, resolvedModel: "gpt-5.6-sol", usage: { grossInput: input, cached: 0, output },
  }));
  mk(KIND.INITIAL, 100_000, 500);
  mk(KIND.TRANSPORT_RETRY, 100_000, 0);
  mk(KIND.AUTO_CONTINUE, 101_000, 700);

  const tt = t.turnTotals();
  assert.equal(tt.effectiveGrossInput, 101_000, "the final effective context, not the sum");
  assert.equal(tt.stitchedOutput, 1_200, "output IS stitched: both passes reached the client");
  assert.equal(tt.retries, 2);
  // And the two meters genuinely differ, which is the whole reason there are two.
  assert.notEqual(t.attemptTotals().grossInput, tt.effectiveGrossInput);
});

test("a transport retry's output is not stitched into the turn — nothing reached the client", () => {
  const t = new Turn({ turnId: "t" });
  t.add(makeAttempt({ turnId: "t", kind: KIND.INITIAL, resolvedModel: "gpt-5.4",
                      usage: { grossInput: 10, cached: 0, output: 0 } }));
  t.add(makeAttempt({ turnId: "t", kind: KIND.TRANSPORT_RETRY, resolvedModel: "gpt-5.4",
                      usage: { grossInput: 10, cached: 0, output: 5 } }));
  assert.equal(t.turnTotals().stitchedOutput, 0,
    "a retry replaces the attempt that failed; its output is billed but not part of the reply");
  assert.equal(t.attemptTotals().output, 5, "billed all the same");
});

test("an interrupted attempt is unknown, and poisons the total rather than being dropped", () => {
  const t = new Turn({ turnId: "t" });
  t.add(makeAttempt({ turnId: "t", resolvedModel: "gpt-5.6-sol",
                      usage: { grossInput: 1000, cached: 0, output: 10 } }));
  t.add(makeAttempt({ turnId: "t", kind: KIND.TRANSPORT_RETRY, resolvedModel: "gpt-5.6-sol",
                      status: "aborted", usage: null }));
  const at = t.attemptTotals();
  assert.equal(at.unknownUsage, 1);
  assert.equal(at.micros, null, "a total resting on absent data must not present itself as exact");
  assert.ok(at.partialMicros > 0, "what IS known is still available, clearly labelled");
});

test("an attempt on an unpriced model marks the total unpriced instead of undercounting it", () => {
  const t = new Turn({ turnId: "t" });
  t.add(makeAttempt({ turnId: "t", resolvedModel: "gpt-5.6-sol",
                      usage: { grossInput: 1000, cached: 0, output: 10 } }));
  t.add(makeAttempt({ turnId: "t", resolvedModel: "gpt-99-unknown",
                      usage: { grossInput: 5000, cached: 0, output: 50 } }));
  const at = t.attemptTotals();
  assert.equal(at.unpriced, 1);
  assert.equal(at.micros, null);
  assert.equal(at.grossInput, 6000, "the tokens are still counted; only the money is unknown");
});

// ---------- the aggregate ----------

test("the ledger splits each model by tier, so a total can be checked against a bill", () => {
  const l = emptyLedger();
  applyAttempt(l, makeAttempt({ turnId: "a", route: "main", resolvedModel: "gpt-5.6-sol",
    usage: { grossInput: 100_000, cached: 50_000, output: 100 } }));
  applyAttempt(l, makeAttempt({ turnId: "b", route: "main", resolvedModel: "gpt-5.6-sol",
    usage: { grossInput: 400_000, cached: 300_000, output: 200 } }));
  applyAttempt(l, makeAttempt({ turnId: "c", route: "safety:block", resolvedModel: "gpt-5.4-2026-03-05",
    usage: { grossInput: 90_000, cached: 88_000, output: 11 } }));
  const sol = l.byModel["gpt-5.6-sol"];
  assert.equal(sol.short.requests, 1);
  assert.equal(sol.long.requests, 1);
  assert.equal(sol.short.grossInput, 100_000);
  assert.equal(sol.long.grossInput, 400_000);
  assert.equal(l.attempts.longContext, 1);
  assert.equal(l.attempts.total, 3);
  // Classifier traffic is separable, which is what made the transcript-versus-ledger gap explicable.
  assert.equal(l.byRoute["safety:block"], 1);
  assert.equal(l.byRoute.main, 2);
});

test("attempt kinds are counted, so a total can say what caused it", () => {
  const l = emptyLedger();
  for (const kind of [KIND.INITIAL, KIND.INITIAL, KIND.AUTO_CONTINUE, KIND.TRANSPORT_RETRY])
    applyAttempt(l, makeAttempt({ turnId: "t", kind, resolvedModel: "gpt-5.4",
                                  usage: { grossInput: 10, cached: 0, output: 1 } }));
  assert.deepEqual(l.attempts.byKind,
    { [KIND.INITIAL]: 2, [KIND.AUTO_CONTINUE]: 1, [KIND.TRANSPORT_RETRY]: 1 });
});

test("unknown usage and unpriced models are counted in the aggregate too", () => {
  const l = emptyLedger();
  applyAttempt(l, makeAttempt({ turnId: "t", resolvedModel: "gpt-5.6-sol", usage: null }));
  applyAttempt(l, makeAttempt({ turnId: "t", resolvedModel: "mystery-model",
                                usage: { grossInput: 10, cached: 0, output: 1 } }));
  assert.equal(l.attempts.unknownUsage, 1);
  assert.equal(l.attempts.unpriced, 1);
  assert.equal(l.byModel["mystery-model"].unpriced, true);
});

// ---------- the legacy ledger ----------

test("a v1 ledger becomes a labelled lower bound, never an exact figure", () => {
  const v1 = {
    since: "2026-07-30T05:01:02.715Z",
    byModel: {
      "gpt-5.6-sol": { requests: 25722, input_tokens: 6_150_211_951, output_tokens: 44_108_012,
                       reasoning_tokens: 25_082_211, cached_input_tokens: 4_620_843_861 },
      "gpt-5.4": { requests: 21256, input_tokens: 1_062_961_933, output_tokens: 587_747,
                   reasoning_tokens: 0, cached_input_tokens: 820_246_016 },
    },
  };
  const m = migrateLegacy(v1);
  assert.ok(m.lowerBoundMicros > 0);
  assert.equal(m.byModel, v1.byModel, "the raw history is kept verbatim");
  // The floor must be recognisable as a floor, and say why.
  assert.match(m.note, /FLOOR/);
  assert.match(m.note, /272,000/);
  assert.match(m.note, /16\.3%/);
  assert.match(m.note, /52\.3%/);
  assert.match(m.note, /43%/);
  // Sanity: the sol+5.4 floor is in the low tens of thousands of dollars, not cents or millions.
  const dollars = m.lowerBoundMicros / 1_000_000;
  assert.ok(dollars > 10_000 && dollars < 15_000, `expected ~$12k floor, got $${dollars.toFixed(0)}`);
});

test("a legacy ledger is never folded into the new totals", () => {
  // Mixing an exact figure with an estimate produces something that is neither.
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    since: "2026-01-01T00:00:00Z",
    byModel: { "gpt-5.4": { requests: 5, input_tokens: 1000, output_tokens: 10, cached_input_tokens: 0 } },
  }));
  const l = loadLedger(file);
  assert.equal(l.version, LEDGER_VERSION);
  assert.ok(l.legacy, "the old data is carried");
  assert.equal(l.attempts.total, 0, "and is NOT counted as attempts");
  assert.deepEqual(l.byModel, {}, "nor mixed into the per-model totals");
  assert.equal(l.since, "2026-01-01T00:00:00Z", "but the start date survives");
});

test("a v2 ledger round-trips, and a damaged one does not lose the process its accounting", () => {
  const file = tmpFile();
  const l = emptyLedger();
  applyAttempt(l, makeAttempt({ turnId: "t", resolvedModel: "gpt-5.4",
                                usage: { grossInput: 100, cached: 0, output: 5 } }));
  saveLedger(l, file);
  const back = loadLedger(file);
  assert.equal(back.attempts.total, 1);
  assert.equal(back.byModel["gpt-5.4"].short.requests, 1);
  assert.equal(back.rateTableVersion, RATE_TABLE_VERSION);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")), [],
    "the write is atomic");

  fs.writeFileSync(file, "{ truncated");
  const fresh = loadLedger(file);
  assert.equal(fresh.attempts.total, 0, "a damaged ledger starts clean rather than throwing");
  assert.equal(fresh.version, LEDGER_VERSION);
});

test("the rate table version travels with the totals", () => {
  // A total priced under one table and added to one priced under another is not comparable, and
  // nothing else would record that the rates moved.
  assert.match(RATE_TABLE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  const a = makeAttempt({ turnId: "t", resolvedModel: "gpt-5.4",
                          usage: { grossInput: 10, cached: 0, output: 1 } });
  assert.equal(a.cost.rateTableVersion, RATE_TABLE_VERSION);
  assert.equal(emptyLedger().rateTableVersion, RATE_TABLE_VERSION);
});

test("a rejected request is known-zero, not unknown", () => {
  // A 400 for an unsupported parameter or an oversized context generated no tokens and was not
  // billed. Counting it as "unknown" would mark every turn containing a parameter retry as unpriced
  // — hiding the real unknowns in a crowd of harmless ones.
  const t = new Turn({ turnId: "t" });
  t.add(makeAttempt({ turnId: "t", kind: KIND.INITIAL, resolvedModel: "gpt-5.6-sol",
                      status: "rejected", error: "unsupported_parameter", usage: null }));
  t.add(makeAttempt({ turnId: "t", kind: KIND.PARAM_RETRY, resolvedModel: "gpt-5.6-sol",
                      status: "completed", usage: { grossInput: 1000, cached: 0, output: 10 } }));
  const at = t.attemptTotals();
  assert.equal(at.attempts, 2, "both requests happened and both are counted");
  assert.equal(at.rejected, 1);
  assert.equal(at.unknownUsage, 0, "a rejection is not an unknown");
  assert.ok(at.micros > 0, "and the total stays exact");

  const l = emptyLedger();
  for (const a of t.attempts) applyAttempt(l, a);
  assert.equal(l.attempts.total, 2);
  assert.equal(l.attempts.rejected, 1);
  assert.equal(l.attempts.unknownUsage, 0);
  assert.equal(l.byModel["gpt-5.6-sol"].short.requests, 1, "only the billed one has tokens");
});
