// Typed failures, so a caller can tell WHOSE fault something is.
//
// Everything used to funnel through `safeParse`, which returns `{}` on any parse failure. One
// function, one fallback, two completely different meanings:
//
//   * a malformed /v1/messages body became an empty request and was answered as though the
//     client had sent nothing, instead of being rejected as a bad request;
//   * malformed tool arguments from the MODEL became `{}` and were handed to the agent as a
//     complete, executable call with no arguments.
//
// The second is the dangerous one. `Bash({})`, `Write({})`, `Edit({})` — a tool invoked with an
// empty input is not a no-op, it is a call whose arguments were lost, and the agent has no way to
// know that. Losing the distinction is what made a single fallback value able to cause it.
//
// So there are two kinds of failure and they are not interchangeable:
//
//   RequestError      the client sent something invalid -> 400, the client's problem
//   TranslationError  the upstream returned something unusable -> the turn fails, our problem
//
// Both carry an Anthropic error `type` because that is the wire format the client speaks.

export class RequestError extends Error {
  constructor(message, { type = "invalid_request_error", status = 400 } = {}) {
    super(message);
    this.name = "RequestError";
    this.anthropicType = type;
    this.status = status;
  }
}

// The upstream produced something that cannot be represented as a valid Anthropic response —
// unparseable tool arguments, a tool name that maps nowhere, a call the schema forbids. Never
// silently repaired into something executable.
export class TranslationError extends Error {
  constructor(message, { type = "api_error", status = 502, detail = null } = {}) {
    super(message);
    this.name = "TranslationError";
    this.anthropicType = type;
    this.status = status;
    this.detail = detail;
  }
}

// The declared tool catalog cannot be represented on the wire. Separate from RequestError only in
// name: it IS a bad request, but it deserves its own type because the message has to name both
// colliding tools for it to be actionable.
export class ToolCatalogError extends RequestError {
  constructor(message, { tools = [] } = {}) {
    super(message, { type: "invalid_request_error", status: 400 });
    this.name = "ToolCatalogError";
    this.tools = tools;
  }
}

export const anthropicError = (type, message) => ({ type: "error", error: { type, message } });

// Any thrown value, as an Anthropic error body plus a status. An unexpected error must not leak a
// stack trace to the client, so only known types keep their message.
export function errorResponse(e) {
  if (e instanceof RequestError || e instanceof TranslationError)
    return { status: e.status, body: anthropicError(e.anthropicType, e.message) };
  return { status: 500, body: anthropicError("api_error", "internal proxy error") };
}

// ---------- semantic contracts ----------
//
// The generic unsupported-parameter recovery is keyed off the API's own `param` field: whatever the
// upstream names, the proxy deletes and resends. That self-heals a knob like `stop` — which is what it
// was built for, after twelve 400s in one session — but it must not be allowed near a field that
// CARRIES MEANING.
//
// If the upstream ever answers `"param": "tools"` (a model without function calling would), the
// recovery would strip the tools and continue. The turn then succeeds as text, the agent appears to
// have declined to act, and the memo makes it permanent for the rest of the process. That is the same
// failure shape as every silent tool-drop this project has already fixed: the symptom looks like a
// model choosing not to work.
//
// So these are never dropped. A request that cannot be sent WITH them is a request that cannot be
// honoured, and saying so is the only honest outcome.
export const SEMANTIC_CONTRACTS = new Set([
  "tools",            // dropping them makes an agent turn text-only
  "tool_choice",      // dropping it silently un-forces a required call
  "messages",         // Chat surface: the conversation itself
  "input",            // Responses surface: same
  "model",
  "instructions",     // the system prompt
  // Structured-output fields. Not sent today (see the phase note), listed so that if they ever are,
  // the recovery cannot quietly return unstructured text against a schema the caller is parsing.
  "response_format",
  "text.format",
  "output_config",
  "strict",
]);

// Is this parameter safe for the drop-and-retry path?
//
// Matched against every PREFIX of the path, not just its root. A root-only check let
// `text.format.json_schema` through — the root is `text`, which is not itself a contract, so a schema
// rejection inside a structured-output field would have been "fixed" by deleting the field. Caught by
// the test for exactly that case.
export function isDroppableParam(param) {
  const p = String(param ?? "");
  if (!p) return false;
  // Array indices are noise for this decision: tools[0] and tools[3] are both `tools`.
  const segments = p.replace(/\[\d+\]/g, "").split(".").filter(Boolean);
  if (!segments.length) return false;
  for (let i = 1; i <= segments.length; i++) {
    if (SEMANTIC_CONTRACTS.has(segments.slice(0, i).join("."))) return false;
  }
  return true;
}
