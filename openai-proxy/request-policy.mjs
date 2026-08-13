// Parsing, split by whose input it is.
//
// One `safeParse` served both directions and returned `{}` for both:
//
//   const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
//
// Inbound, that turned a malformed request body into an empty one, which was then answered as
// though the client had sent no messages — a 200 for something that should have been a 400.
//
// Outbound, it turned malformed tool arguments from the MODEL into an executable call with no
// arguments. That is the serious one. `{}` is not a neutral value for a tool call: the client
// receives a complete, well-formed `tool_use` block and runs it. A truncated
// `{"command":"rm -r` becomes `Bash({})`; a half-streamed `Write` becomes `Write({})`. The agent
// cannot tell that from a model that genuinely passed no arguments, so a parse failure surfaces as
// a tool behaving strangely, attributed to the model.
//
// So the two directions get different functions with different failure modes, and neither has a
// fallback value.
import { RequestError, TranslationError } from "./errors.mjs";

// ---------- inbound: the client's request ----------

// A request body must be a JSON OBJECT. `null`, an array, a bare string and a number all parse
// successfully as JSON and are all invalid here — and all of them used to reach the translator,
// where `body.messages` on a non-object is either undefined or, for an array, something worse.
export function parseRequestBody(raw, { what = "request body" } = {}) {
  if (typeof raw !== "string" || raw.trim() === "")
    throw new RequestError(`empty ${what}: expected a JSON object`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // The position is worth keeping: a truncated body and a mistyped field are different problems
    // and the client sees only this message.
    throw new RequestError(`${what} is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RequestError(
      `${what} must be a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}`);
  return parsed;
}

// The shape /v1/messages requires before any translation is attempted. Deliberately minimal: this
// rejects what cannot possibly work, and leaves anything the upstream can judge for itself to the
// upstream, which gives better messages than a reimplementation of its validation would.
export function validateMessagesRequest(body) {
  if (!Array.isArray(body.messages))
    throw new RequestError("messages must be an array");
  if (body.model !== undefined && typeof body.model !== "string")
    throw new RequestError("model must be a string");
  if (body.tools !== undefined && !Array.isArray(body.tools))
    throw new RequestError("tools must be an array");
  if (body.max_tokens !== undefined &&
      (typeof body.max_tokens !== "number" || !Number.isFinite(body.max_tokens) || body.max_tokens <= 0))
    throw new RequestError("max_tokens must be a positive number");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new RequestError("stream must be a boolean");
  for (const [i, m] of body.messages.entries()) {
    if (m === null || typeof m !== "object" || Array.isArray(m))
      throw new RequestError(`messages[${i}] must be an object`);
    if (m.role !== "user" && m.role !== "assistant")
      throw new RequestError(`messages[${i}].role must be "user" or "assistant", got ${JSON.stringify(m.role)}`);
  }
  return body;
}

// ---------- outbound: what the model sent back ----------

// Does this schema accept a call with no arguments at all? Only then may `{}` stand for "the model
// passed nothing", which is a real and legitimate case — plenty of tools take no parameters.
export function schemaAllowsEmpty(schema) {
  if (!schema || typeof schema !== "object") return true;   // nothing declared, nothing to violate
  const required = schema.required;
  if (!Array.isArray(required)) return true;
  return required.length === 0;
}

// Turn accumulated argument bytes into arguments, or fail the turn.
//
// Three distinct outcomes, where there used to be one:
//   no bytes at all      -> {} IF the schema permits it, otherwise a failure. A call that needs
//                           arguments and received none was truncated, not minimal.
//   bytes, unparseable   -> failure. This is the truncation case, and the one that used to become
//                           an executable `{}`.
//   bytes, not an object -> failure. `[1,2]` and `"text"` are valid JSON and invalid arguments;
//                           the client expects `input` to be an object.
export function parseToolArguments(raw, { toolName = "a tool", schema = null } = {}) {
  const text = typeof raw === "string" ? raw : "";
  if (text.trim() === "") {
    if (schemaAllowsEmpty(schema)) return {};
    const need = (schema.required || []).join(", ");
    throw new TranslationError(
      `${toolName} was called with no arguments, but its schema requires ${need}. ` +
      `The upstream response was cut off before the arguments arrived, so the call is withheld ` +
      `rather than executed with empty input.`,
      { detail: { toolName, reason: "empty-but-required" } });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // The tell for truncation, and worth stating because it points at max_output_tokens rather
// than at the model producing bad JSON.
    const truncated = !text.trimEnd().endsWith("}");
    throw new TranslationError(
      `${toolName}: the arguments are not valid JSON (${e.message})` +
      (truncated ? `, and they end without a closing brace — the turn was almost certainly cut ` +
                   `off by the output limit` : "") +
      `. The call is withheld: executing it with empty or partial input would be indistinguishable ` +
      `from a call the model meant to make.`,
      { detail: { toolName, reason: truncated ? "truncated" : "malformed", bytes: text.length } });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TranslationError(
      `${toolName}: the arguments parsed to ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, ` +
      `but a tool call's input must be an object. The call is withheld.`,
      { detail: { toolName, reason: "not-an-object" } });
  return parsed;
}
