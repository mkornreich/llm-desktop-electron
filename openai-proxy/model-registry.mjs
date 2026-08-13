// What a request cost, in integer money, or nothing at all.
//
// THE TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. AN UNKNOWN MODEL IS UNPRICED, never estimated. A plausible number attached to a model nobody
//    verified is worse than no number: it looks like an answer and cannot be corrected, because
//    nothing records that it was a guess. Every rate below was read from
//    developers.openai.com/api/docs/pricing; anything absent from the table returns null and is
//    counted under `unpriced` so the gap is visible in the total.
//
// 2. THE LONG-CONTEXT TIER IS PER REQUEST, and it is not a rounding error. Quoting the gpt-5.6-sol
//    model page directly:
//
//      "Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request."
//
//    So a 300K-token request is not "mostly the same" as a 200K one — every token in it, including
//    the cached ones, costs double, and the output costs half again as much. Measured over 44,571
//    logged turns from this app: 16.3% of requests cross that threshold, and those requests carry
//    52.3% of all input tokens. Pricing the ledger's aggregate at short-context rates therefore
//    understated the measured figure by 43% ($13,250 against ~$19,007).
//
//    That is also why an aggregate ledger cannot be priced at all: the tier is a property of an
//    individual request, and once totals are summed the information is gone. Hence per-attempt
//    records.
//
// INTEGER MONEY. Costs are micro-dollars (1e-6 USD) as integers. Floating point accumulated over
// 50,000 requests drifts, and a cost total that changes depending on the order it was summed in is
// not a cost total.
//
// REASONING IS NOT CHARGED TWICE. OpenAI bills reasoning tokens as part of `output_tokens`;
// `reasoning_tokens` is a subset breakdown, not an additional line. Adding them would inflate every
// reasoning-heavy turn — and this app runs at effort `max`, where reasoning is 57% of output.

// Bump when any rate changes. Stored with every priced record, so a total can always say which
// table produced it — and a table that changed under a stored total is detectable rather than
// silently mixed in.
export const RATE_TABLE_VERSION = "2026-08-13";
export const RATES_SOURCE = "https://developers.openai.com/api/docs/pricing";

// Micro-dollars per 1,000,000 tokens. $5.00 -> 5_000_000.
const M = (dollars) => Math.round(dollars * 1_000_000);

// The long-context rule, verified on the model page and cross-checked against the published
// long-context rows: sol $5->$10 input (2x), $0.50->$1.00 cached (2x), $30->$45 output (1.5x).
// Deriving the tier from multipliers rather than storing a second set of numbers means the two
// cannot drift apart in this file.
export const LONG_CONTEXT_THRESHOLD = 272_000;   // strictly greater than, per the wording
export const LONG_INPUT_MULTIPLIER = 2;
export const LONG_OUTPUT_MULTIPLIER = 1.5;

// `longTier: false` means the model has no long-context pricing published. It is NOT an assumption
// that such requests are cheap — for these models the context window is at or below the threshold,
// so the tier cannot apply.
export const RATES = {
  "gpt-5.6-sol":              { input: M(5.00),  cached: M(0.50),  output: M(30.00),  longTier: true },
  "gpt-5.6-terra":            { input: M(2.00),  cached: M(0.20),  output: M(12.00),  longTier: true },
  "gpt-5.6-luna":             { input: M(0.20),  cached: M(0.02),  output: M(1.20),   longTier: true },
  "gpt-5.4":                  { input: M(2.50),  cached: M(0.25),  output: M(15.00),  longTier: true },
  "gpt-5.4-2026-03-05":       { input: M(2.50),  cached: M(0.25),  output: M(15.00),  longTier: true },
  "gpt-5.4-mini":             { input: M(0.75),  cached: M(0.075), output: M(4.50),   longTier: false },
  "gpt-5.4-nano":             { input: M(0.20),  cached: M(0.02),  output: M(1.25),   longTier: false },
  "gpt-5.4-pro":              { input: M(30.00), cached: null,     output: M(180.00), longTier: true },
  "gpt-5.3-codex":            { input: M(1.75),  cached: M(0.175), output: M(14.00),  longTier: false },
  "gpt-4.1":                  { input: M(2.00),  cached: M(0.50),  output: M(8.00),   longTier: false },
  "gpt-4.1-mini":             { input: M(0.40),  cached: M(0.10),  output: M(1.60),   longTier: false },
};

// Snapshot ids share their alias's rates ONLY where that has been checked. A dated snapshot whose
// price was never read is unpriced, not assumed — see rule 1.
export const ALIASES = {
  "gpt-5.4-2026-03-05": "gpt-5.4",
};

export const isPriced = (model) => Object.hasOwn(RATES, String(model ?? ""));

export function rateFor(model) {
  return RATES[String(model ?? "")] || null;
}

// Does this request fall in the long-context tier?
//
// GROSS input decides it — the whole prompt, cached tokens included — because the rule is about the
// size of the prompt, not about what was billed at the full rate. Using fresh input instead would
// put a 900K-token request with a 96% cache hit rate in the cheap tier, which is exactly backwards:
// that request is enormous.
export function isLongContext(grossInputTokens, model) {
  const r = rateFor(model);
  if (!r || !r.longTier) return false;
  return (grossInputTokens || 0) > LONG_CONTEXT_THRESHOLD;
}

// Price one upstream request.
//
// Returns null when the model is unknown or when usage is unknown — never 0. Zero is a claim that
// something was free; null is the truth that it was not measured, and the two must not be summed
// together.
//
//   grossInput  total prompt tokens, cache reads INCLUDED (OpenAI's own convention)
//   cached      the subset served from cache
//   output      completion tokens, reasoning INCLUDED (do not add reasoning separately)
// `tier` is normally "auto", which reads the threshold off this request's own gross input. The
// other two values exist for ONE legitimate caller: pricing a pre-existing aggregate, where the
// per-request tier information no longer exists.
//
// That distinction is not cosmetic. Passing an aggregate through the auto path silently prices
// everything at 2x — 6.15 billion tokens is "greater than 272,000", so the check that is meaningful
// per request becomes meaningless in the sum. The first version of the legacy migration did exactly
// that and reported a $23,536 "lower bound", which is ABOVE the measured estimate of ~$19,007. A
// floor that exceeds the real figure is worse than no floor, so the choice is now explicit at the
// call site and cannot be reached by accident.
export function priceRequest({ model, grossInput, cached = 0, output = 0, tier = "auto" } = {}) {
  const r = rateFor(model);
  if (!r) return null;
  if (grossInput === undefined || grossInput === null) return null;
  if (output === undefined || output === null) return null;

  const gross = Math.max(0, Math.trunc(grossInput));
  const cachedTok = Math.max(0, Math.min(Math.trunc(cached || 0), gross));
  const freshTok = gross - cachedTok;
  const outTok = Math.max(0, Math.trunc(output));

  const r2 = rateFor(model);
  const long = tier === "short" ? false
    : tier === "long" ? !!r2?.longTier
    : isLongContext(gross, model);
  const inMul = long ? LONG_INPUT_MULTIPLIER : 1;
  const outMul = long ? LONG_OUTPUT_MULTIPLIER : 1;

  // A model with no published cached rate is billed at the full input rate for those tokens, which
  // is the conservative reading — assuming a discount nobody published would understate the bill.
  const cachedRate = r.cached ?? r.input;

  const micros =
    Math.round(freshTok * r.input * inMul / 1_000_000) +
    Math.round(cachedTok * cachedRate * inMul / 1_000_000) +
    Math.round(outTok * r.output * outMul / 1_000_000);

  return {
    micros,
    long,
    rateTableVersion: RATE_TABLE_VERSION,
    breakdown: {
      freshInput: Math.round(freshTok * r.input * inMul / 1_000_000),
      cachedInput: Math.round(cachedTok * cachedRate * inMul / 1_000_000),
      output: Math.round(outTok * r.output * outMul / 1_000_000),
    },
  };
}

// Micro-dollars -> a string with the unit. Formatting is separated from arithmetic so nothing
// downstream is tempted to add floats.
export function formatMicros(micros) {
  if (micros === null || micros === undefined) return "unpriced";
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const dollars = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0").slice(0, 2);
  return `${sign}$${dollars.toLocaleString()}.${frac}`;
}

// Every model this proxy might route to, for a startup check that the table covers them. A model
// that will actually be used but has no rate is worth knowing about before the bill, not after.
export function unpricedAmong(models) {
  return [...new Set(models.filter(Boolean).map(String))].filter((m) => !isPriced(m));
}
