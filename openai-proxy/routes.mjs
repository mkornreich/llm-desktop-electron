// What KIND of call is this, and what is it allowed to do?
//
// This replaces a boolean. `isCls` answered "is this a classifier?", which was enough to strip
// hints and reasoning and not enough for anything else — so three things went wrong:
//
//   1. MODEL RESOLUTION RAN IN THE WRONG ORDER. pickModel checked for a requested OpenAI model
//      id FIRST and returned it, before ever looking at the classifier family:
//
//        if (OPENAI_MODEL_RE.test(req)) return req;          // <- passthrough won
//        if (family === "safety" && OPENAI_CLASSIFIER_SAFETY_MODEL) return …
//
//      So any request naming an OpenAI model inherited it, INCLUDING a safety verdict. The
//      gateway model picker is enabled in this repository (
//      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1) and its default list contains gpt-4.1-mini —
//      the model measured to allow an `ssh backend-prod` that gpt-5.3-codex blocked, and to emit
//      no parseable verdict at all on another real prompt. Picking a fast model in the UI would
//      silently downgrade the auto-mode safety classifier to it.
//
//      Measured over 47k logged requests: every one of the 20,160 real safety verdicts arrived
//      asking for a `claude-*` identity, so the passthrough never fired for safety in practice.
//      The mechanism is demonstrably live though — `model=gpt-4.1-mini[1m]->gpt-4.1-mini[1m]`
//      appears in the log — so this is latent, not theoretical.
//
//   2. TOOLS REACHED CLASSIFIERS. Neither encoder guarded its tools block on `isCls`, so a
//      verdict call carrying up to OPENAI_CLASSIFIER_MAX_TOOLS (4) tools sent them upstream along
//      with `tool_choice`. A verdict has a rigid output contract and no use for a tool; offering
//      one invites a tool call in place of the verdict, which is unparseable, which makes the CLI
//      retry and then deny.
//
//   3. THE POLICY WAS SCATTERED. `!isCls` appeared at eight separate call sites. Adding a rule
//      meant finding all of them, and missing one was invisible.
//
// STAGES ARE DIAGNOSTIC, NOT BEHAVIOURAL — deliberately. The safety classifier has two stages:
// stage 1 answers `<severity>N</severity>`, stage 2 answers `<block>yes|no</block>`. Splitting
// them into separately-configured routes was the plan, and the evidence says not yet:
//
//   All 13 real classifier prompts recovered from the CLI's own error dumps are stage 2. Each one
//   opens its SYSTEM prompt with "security monitor for autonomous AI coding agents" (found at
//   fraction 0.00–0.03 of the request). Three of them also contain `<severity>N</severity>` — but
//   at fractions 0.21, 0.89 and 0.91, inside the USER transcript, where the conversation happens
//   to quote an earlier stage-1 exchange. There is no stage-1 corpus to validate against, and the
//   one available discriminator is indistinguishable from a transcript mention unless it is
//   anchored to the system prompt.
//
// So the stages are typed and logged separately, the discriminator is anchored to the system text
// only, and both stages resolve to the SAME model and the SAME policy. A stage mislabel therefore
// cannot change what happens — it can only mislabel a log line. Giving them different behaviour
// needs a real stage-1 corpus first.

export const ROUTE = {
  MAIN: "main",                       // an ordinary agent turn
  PREFIX: "prefix",                   // Bash command-prefix detection: latency-sensitive, low stakes
  SAFETY_SEVERITY: "safety:severity", // auto-mode stage 1
  SAFETY_BLOCK: "safety:block",       // auto-mode stage 2
  COMPACTION: "compaction",           // the CLI asking us to summarise its own transcript
};

export const isSafety = (r) => r === ROUTE.SAFETY_SEVERITY || r === ROUTE.SAFETY_BLOCK;
export const isClassifier = (r) => isSafety(r) || r === ROUTE.PREFIX;

// ---------- detection ----------
//
// Needles verified against all 13 real classifier prompts in the CLI's error dumps.
export const PREFIX_NEEDLES = [
  "risk levels for actions that the Claude Code agent",
  "broader safety framework",
  "command_injection_detected",
];
// The stage-2 opener, and the contract lines that only a verdict prompt carries.
export const SAFETY_NEEDLES = [
  "security monitor for autonomous AI coding agents",
  "ENTIRE response MUST begin with <block>",
  "<block>(?:yes|no)</block>",
  "Err on the side of blocking",
  "<severity>N</severity>",
  "Review the classification process",
];
// Stage 1's own contract. Matched against the SYSTEM text only — in a transcript these are just
// words, and three of the thirteen real stage-2 prompts contain the first one mid-conversation.
export const SEVERITY_NEEDLES = [
  "<severity>N</severity>",
  "Review the classification process",
];
// Stage 2's own contract, likewise system-anchored.
export const BLOCK_NEEDLES = [
  "security monitor for autonomous AI coding agents",
  "ENTIRE response MUST begin with <block>",
  "<block>(?:yes|no)</block>",
];

const re = (needles) => new RegExp(needles.join("|"), "i");
export const PREFIX_RE = re(PREFIX_NEEDLES);
export const SAFETY_RE = re(SAFETY_NEEDLES);
export const SEVERITY_RE = re(SEVERITY_NEEDLES);
export const BLOCK_RE = re(BLOCK_NEEDLES);
export const CLASSIFIER_RE = new RegExp(`${PREFIX_RE.source}|${SAFETY_RE.source}`, "i");

// Decide the route.
//
// `systemText` and `tailText` arrive already sniffed (head+tail of each) — a real transcript runs
// to megabytes and the contract lines sit at the ends.
//
// The FAMILY check still looks at both system and tail, which is the fail-closed direction: a
// prompt that looks like a verdict is treated as one, losing hints and tools rather than gaining
// them. The STAGE check looks only at the system text, for the reason above.
export function routeFor({ systemText = "", tailText = "", toolCount = 0, maxTools = 4,
                           isCompaction = false, onVeto = null } = {}) {
  const both = `${systemText}\n${tailText}`;
  const family = SAFETY_RE.test(both) ? "safety" : PREFIX_RE.test(both) ? "prefix" : null;

  if (family) {
    // Corroboration, because the needles are only text. A verdict carries no tool list; an agent
    // turn carries the whole toolbox. Without this, a session that merely QUOTES the contract —
    // debugging this very file, say — would have its own turns misrouted and its hints stripped.
    if (toolCount > maxTools) {
      onVeto?.(family, toolCount);
    } else if (family === "prefix") {
      return ROUTE.PREFIX;
    } else {
      // Anchored to the system prompt. Stage 2's opener wins when both appear, because that opener
      // is what every real stage-2 prompt starts with, while a severity mention can be transcript.
      if (BLOCK_RE.test(systemText)) return ROUTE.SAFETY_BLOCK;
      if (SEVERITY_RE.test(systemText)) return ROUTE.SAFETY_SEVERITY;
      // Matched on the tail only: still a safety call, and stage 2 is the conservative label —
      // it is the stage that can block, so treating an unknown safety call as stage 2 keeps the
      // strictest handling.
      return ROUTE.SAFETY_BLOCK;
    }
  }
  return isCompaction ? ROUTE.COMPACTION : ROUTE.MAIN;
}

// ---------- policy ----------
//
// One table instead of eight scattered `!isCls` checks. Every field is a thing that used to be
// decided at a call site.
//
//   tools              may model-visible tools and tool_choice be sent
//   hints              format / persistence / SVG instructions appended to the system prompt
//   reasoning          ask for reasoning summaries (they share the output budget)
//   verbosity          send text.verbosity
//   continuation       auto-continue an announced-but-not-taken action, and resume a truncated turn
//   compactOnOverflow  may the transcript be shortened and the call retried
//   reservedPool       use the reserved classifier connection pool
//   failClosed         a failure must surface as an error, never as a degraded answer
const CLASSIFIER_POLICY = {
  tools: false, hints: false, reasoning: false, verbosity: false,
  continuation: false, compactOnOverflow: false, reservedPool: true, failClosed: true,
};
const AGENT_POLICY = {
  tools: true, hints: true, reasoning: true, verbosity: true,
  continuation: true, compactOnOverflow: true, reservedPool: false, failClosed: false,
};

const POLICIES = {
  [ROUTE.MAIN]: AGENT_POLICY,
  // Identical to MAIN today, on purpose. A compaction request is genuinely not an agent turn, but
  // changing how it is summarised is a fact-retention question with measurable quality effects,
  // and that belongs to the phase that owns compaction. Typed here so the distinction exists and
  // is logged; behaviour deliberately unchanged.
  [ROUTE.COMPACTION]: AGENT_POLICY,
  [ROUTE.PREFIX]: CLASSIFIER_POLICY,
  [ROUTE.SAFETY_SEVERITY]: CLASSIFIER_POLICY,
  [ROUTE.SAFETY_BLOCK]: CLASSIFIER_POLICY,
};

export function policyFor(route) {
  return POLICIES[route] || AGENT_POLICY;
}

// ---------- model resolution ----------
//
// FAMILY FIRST. This is the ordering fix: a classifier's model comes from its own setting and can
// never be inherited from the request, the picker, or CLAUDE_CODE_BG_CLASSIFIER_MODEL. Only an
// ordinary agent turn honours a directly requested OpenAI model.
export const OPENAI_MODEL_RE = /^(gpt-|o[1-9]|chatgpt|ft:)/i;

export function modelForRoute(route, {
  main, prefixModel, safetyModel, requestedModel = "", safetyModelIsBlank = false,
} = {}) {
  if (route === ROUTE.PREFIX) return prefixModel || main;
  if (isSafety(route)) {
    // An explicitly blank setting means "use the main model and accept the latency", which is what
    // the settings help has always promised. It could not be honoured before: blank is falsy, so
    // `||` walked straight past it to the default. The caller distinguishes "defined but empty"
    // from "absent" and passes that through, because those must not mean the same thing.
    if (safetyModelIsBlank) return main;
    return safetyModel || main;
  }
  // MAIN and COMPACTION only.
  const req = String(requestedModel || "");
  if (OPENAI_MODEL_RE.test(req)) return req;
  return main;
}

// A one-line description for the request log. The route is the single most useful thing to know
// about a call after the fact, and `classifier=yes` — the field this replaces — could not tell a
// prefix detection from a safety verdict.
export function routeLabel(route) {
  switch (route) {
    case ROUTE.PREFIX: return "classifier=prefix";
    case ROUTE.SAFETY_SEVERITY: return "classifier=safety:severity";
    case ROUTE.SAFETY_BLOCK: return "classifier=safety:block";
    case ROUTE.COMPACTION: return "route=compaction";
    default: return "";
  }
}

// ---------- route-specific effort and output ----------
//
// Effort, verbosity and output ceilings were applied globally: one `OPENAI_REASONING_EFFORT` for
// every call, and a single output cap. That is wrong in both directions — a verdict wants no
// reasoning and eleven tokens, a hard agent task wants everything available — but it is also the
// incumbent behaviour, so the tables below REPRODUCE IT EXACTLY.
//
// That is deliberate. This phase adds the mechanism; it does not move a default. A default may only
// change on paired evaluation showing zero safety or tool regression plus either a credible quality
// win or non-inferiority with a real speed gain, and none of that evidence exists yet. Shipping a
// tuned table here would be changing behaviour on taste, and the evaluation baseline would record it
// as a diff with no measurement behind it.
//
// What the mechanism buys now is that the decision has ONE home. `effortFor(model)` consulted a
// process-global memo; the route never entered into it, so "which effort did this call use, and why"
// had no answer that named the call.

// null means "do not request reasoning at all" — distinct from an effort of "none", which asks the
// model for reasoning at the lowest setting and still pays for the parameter.
const ROUTE_EFFORT = {
  [ROUTE.MAIN]: "global",          // whatever OPENAI_REASONING_EFFORT resolves to
  [ROUTE.COMPACTION]: "global",    // fact retention is a measured question; see the phase note
  [ROUTE.PREFIX]: null,
  [ROUTE.SAFETY_SEVERITY]: null,
  [ROUTE.SAFETY_BLOCK]: null,
};

// Target effort for a route, before the model's own ceiling is applied. The two are separate on
// purpose: a route asking for `max` and a model that caps at `xhigh` are different facts, and
// collapsing them is what made a single rejection look like a configuration change.
export function effortForRoute(route, globalEffort) {
  const t = Object.hasOwn(ROUTE_EFFORT, route) ? ROUTE_EFFORT[route] : "global";
  return t === "global" ? globalEffort : t;
}

// A verdict is about eleven output tokens. It has never been given a smaller ceiling than an agent
// turn, and it does not need one — the client already asks for a small max_tokens on those calls, and
// imposing a tighter cap here could truncate a contract this proxy does not own. So: no route-specific
// output ceiling today, and the reason recorded rather than the knob added.
export function outputCeilingForRoute(route, requested, hardCap) {
  return Math.min(requested, hardCap);
}
