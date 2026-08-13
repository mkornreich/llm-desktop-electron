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
