// Which tools the MODEL can see, per route — and nothing about what the agent is allowed to run.
//
// THE LINE THAT MUST NOT BLUR. Claude Code's `allowedTools` is the permission system: it decides
// what may actually execute, and it is the user's. This file decides only what the model is SHOWN.
// Hiding a tool cannot grant anything, and showing one cannot either — a call still goes back to the
// client, which still applies its own permissions. Any future `allowed_tools` sent to a provider is
// an extra encoding of what is already decided here, never a source of authority.
//
// WHAT PROMPTED IT. Three things, one of them measured at scale.
//
// 1. A COMPACTION REQUEST WAS OFFERED 236 TOOLS. The client asks the proxy to summarise a
//    transcript; the answer must be prose. Measured in this app's own logs: 224 of 318 client
//    compaction requests carried tools, ~115k tokens of schemas each, ~25.8M tokens in total,
//    attached to requests that must not call anything.
//
//    THE OBVIOUS FIX IS WRONG, and measurement is what showed it. Removing the tool block would
//    change the prompt prefix, and those requests run at a 95.7% cache hit rate (299 of 300 above
//    50%, 39.3M of 41.1M input tokens served from cache). Dropping the tools would turn ~39M cached
//    tokens into fresh ones — roughly $177 of extra spend to avoid ~$13 of cached schema tokens.
//
//    So the tools stay in the prefix and `tool_choice: "none"` makes a call impossible. Probed
//    directly against the API to be sure that parameter is not part of the cache key:
//
//      1 prime            input=4055 cached=0
//      2 same again       input=4055 cached=4052
//      3 + tool_choice    input=4055 cached=3980     <- still cached
//      4 tool_choice agn  input=4055 cached=3980
//      5 back to no tc    input=4055 cached=4052
//
//    98.2% retained; the 72-token difference is cache-block granularity, not a miss.
//
// 2. tool_choice COULD NAME A TOOL THAT WAS NOT SENT. On the Chat surface the 128-tool cap drops
//    tools, and `tool_choice` was translated independently of that — verified: a request with 200
//    tools asking for the 200th produced a payload containing 128 tools and
//    `tool_choice: {name: "zz_dropped_199"}`, which the API rejects. A turn that could have worked
//    fails, and the error names a parameter rather than the cause.
//
// 3. HINTS CAN NAME A TOOL THE MODEL CANNOT SEE. The format hints are built from the CLIENT's tool
//    list, not from what was actually sent. Today that is latent rather than live — every tool a
//    hint names (write, send-file, renderer) is matched by the essential-tool selector and survives
//    the cap — but it becomes live the moment any policy hides a tool, which is what this file
//    introduces. Hints are generated from the exposed set from here on.
//
// DEFERRED TOOL SEARCH IS DEFINED AND NOT ENABLED. The shape is here — `eager`, `deferred`,
// `allowed` — because the policy needs somewhere for it to live. It stays off: the real
// ToolSearch→load→call loop has not been proven end to end in the app, and a deferral that loses a
// tool presents as a model that "chose" not to use it. That is the worst possible failure to debug,
// so it does not ship on an assumption.
import { ROUTE, isClassifier } from "./routes.mjs";
import crypto from "node:crypto";

// How the model may interact with tools on a given route.
//   "all"      every declared tool is visible and callable
//   "none"     no tools are sent at all
//   "no-calls" tools stay in the prompt (so the cache prefix is untouched) but no call is possible
export const VISIBILITY = { ALL: "all", NONE: "none", NO_CALLS: "no-calls" };

const POLICIES = {
  [ROUTE.MAIN]: { visibility: VISIBILITY.ALL, reason: "an agent turn needs its tools" },
  // Tools present for the cache, calls disabled for correctness. See the note above for the
  // measurement that rules out simply removing them.
  [ROUTE.COMPACTION]: {
    visibility: VISIBILITY.NO_CALLS,
    reason: "a summarisation request must produce prose, but dropping the tools would cost more in " +
            "lost prompt caching than the schemas cost to send",
  },
  [ROUTE.PREFIX]: { visibility: VISIBILITY.NONE, reason: "a verdict has no use for a tool" },
  [ROUTE.SAFETY_SEVERITY]: { visibility: VISIBILITY.NONE, reason: "a verdict has no use for a tool" },
  [ROUTE.SAFETY_BLOCK]: { visibility: VISIBILITY.NONE, reason: "a verdict has no use for a tool" },
};

// Unknown routes get the agent policy. Failing the other way would silently strip tools from a new
// route, and a tool-less agent turn looks exactly like a model that declined to act.
export function exposureFor(route) {
  return POLICIES[route] || POLICIES[ROUTE.MAIN];
}

// The client-executable search tool stays EAGER, always. It is the entry point to any deferred
// scheme, so deferring it would make every deferred tool unreachable.
export const ALWAYS_EAGER = /^(ToolSearch|Skill)$/i;

// Split a catalogue into what the model sees now and what it would have to ask for. `deferred` is
// empty unless deferral is explicitly enabled, which it is not.
export function partition(toolNames, { deferral = false } = {}) {
  const names = (toolNames || []).filter(Boolean).map(String);
  if (!deferral) return { eager: names, deferred: [], allowed: names };
  const eager = names.filter((n) => ALWAYS_EAGER.test(n));
  const deferred = names.filter((n) => !ALWAYS_EAGER.test(n));
  // `allowed` is the union: deferral changes what is VISIBLE, never what may be called once loaded.
  return { eager, deferred, allowed: names };
}

// A stable digest of exactly what the model was shown. Two requests with the same fingerprint were
// offered the same tools in the same order — which is what makes an exposure change reviewable
// instead of a matter of opinion, and what the evaluation baseline pins.
export function exposureFingerprint({ visibility, names = [] }) {
  const material = JSON.stringify({ visibility, names });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 12);
}

// Resolve the client's tool_choice against what is actually being sent.
//
// Returns { choice, cleared, reason }. `choice: null` means send nothing — a cleared tool_choice
// lets the turn proceed, where forwarding an unavailable one fails it outright.
export function resolveToolChoice(requested, exposedNames, { visibility } = {}) {
  if (visibility === VISIBILITY.NONE)
    return { choice: null, cleared: !!requested,
             reason: requested ? "no tools are sent on this route" : null };
  if (visibility === VISIBILITY.NO_CALLS)
    // Overrides whatever was asked for: the point of this route is that nothing may be called.
    return { choice: "none", cleared: !!requested && requested.type !== "none",
             reason: "calls are disabled on this route" };
  if (!requested) return { choice: null, cleared: false, reason: null };

  if (requested.type === "auto") return { choice: "auto", cleared: false, reason: null };
  if (requested.type === "any") return { choice: "required", cleared: false, reason: null };
  if (requested.type === "none") return { choice: "none", cleared: false, reason: null };
  if (requested.type === "tool") {
    const set = new Set(exposedNames || []);
    if (set.has(requested.name)) return { choice: requested, cleared: false, reason: null };
    // The confirmed bug: naming a tool that is not in the payload is a 400, and the message points
    // at the parameter rather than at the cap that dropped the tool. Cleared, and said out loud.
    return { choice: null, cleared: true,
             reason: `tool_choice named "${requested.name}", which is not among the ${set.size} ` +
                     `tools being sent — it was dropped by a per-surface cap or hidden by policy. ` +
                     `Clearing it so the turn can proceed rather than failing the request.` };
  }
  return { choice: null, cleared: true, reason: `unrecognised tool_choice type "${requested.type}"` };
}

// Are tools sent at all on this route?
export const sendsTools = (route) => exposureFor(route).visibility !== VISIBILITY.NONE;
// May the model actually call one?
export const allowsCalls = (route) => exposureFor(route).visibility === VISIBILITY.ALL;
// Classifiers must never be in the tools-sending set; asserted by test rather than assumed.
export const classifierSendsNoTools = (route) => !isClassifier(route) || !sendsTools(route);
