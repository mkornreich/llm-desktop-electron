// Strict parsing and the tool registry.
//   node --test openai-proxy/strict-parsing.test.mjs
//
// The single invariant behind all of it: malformed model JSON must never become an executable
// tool call. `{}` is not a safe default for a tool call — the client receives a complete,
// well-formed `tool_use` block and runs it, so `Bash({})` and `Write({})` are calls whose
// arguments were lost, indistinguishable from calls the model meant to make.
import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, sanitizeToolName } from "./tool-registry.mjs";
import {
  parseRequestBody, validateMessagesRequest, parseToolArguments, schemaAllowsEmpty,
} from "./request-policy.mjs";
import { RequestError, TranslationError, ToolCatalogError, errorResponse } from "./errors.mjs";

const tool = (name, schema) => ({ name, description: name, input_schema: schema });

// ---------- inbound ----------

test("a malformed request body is a 400, not an empty request", () => {
  // It used to become `{}` and be answered as though the client had sent no messages — a 200 for
  // something that cannot be honoured.
  for (const raw of ["{ not json", "", "   ", "{\"messages\":", undefined, null]) {
    assert.throws(() => parseRequestBody(raw), RequestError,
      `${JSON.stringify(raw)} must be rejected`);
  }
  const e = (() => { try { parseRequestBody("{ oops"); } catch (x) { return x; } })();
  assert.equal(e.status, 400);
  assert.equal(e.anthropicType, "invalid_request_error");
  assert.match(e.message, /not valid JSON/);
});

test("valid JSON that is not an object is still rejected", () => {
  // Each of these parses successfully and then breaks the translator in a different way: an array
  // has a `.length` where `.messages` was expected, a string has neither.
  for (const [raw, word] of [["null", "null"], ["[1,2]", "an array"], ['"hello"', "string"],
                             ["42", "number"], ["true", "boolean"]]) {
    const e = (() => { try { parseRequestBody(raw); } catch (x) { return x; } })();
    assert.ok(e instanceof RequestError, `${raw} must be rejected`);
    assert.match(e.message, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.deepEqual(parseRequestBody('{"a":1}'), { a: 1 });
});

test("the messages request shape is checked before any translation is attempted", () => {
  const ok = { model: "m", messages: [{ role: "user", content: "hi" }] };
  assert.equal(validateMessagesRequest(ok), ok);
  const bad = [
    [{ messages: "nope" }, /messages must be an array/],
    [{ messages: [], model: 7 }, /model must be a string/],
    [{ messages: [], tools: {} }, /tools must be an array/],
    [{ messages: [], max_tokens: 0 }, /max_tokens/],
    [{ messages: [], max_tokens: -1 }, /max_tokens/],
    [{ messages: [], max_tokens: "64" }, /max_tokens/],
    [{ messages: [], stream: "yes" }, /stream must be a boolean/],
    [{ messages: [null] }, /messages\[0\] must be an object/],
    [{ messages: [{ role: "system", content: "x" }] }, /role must be/],
    [{ messages: [{ role: "user" }, { role: "nope" }] }, /messages\[1\]/],
  ];
  for (const [body, re] of bad) {
    const e = (() => { try { validateMessagesRequest(body); } catch (x) { return x; } })();
    assert.ok(e instanceof RequestError, `${JSON.stringify(body)} must be rejected`);
    assert.match(e.message, re);
  }
});

// ---------- outbound: tool arguments ----------

test("unparseable tool arguments fail the turn instead of becoming {}", () => {
  // THE INVARIANT. A truncated call used to arrive as `Bash({})` — a complete, executable block.
  const e = (() => {
    try { parseToolArguments('{"command":"rm -r', { toolName: "Bash" }); }
    catch (x) { return x; }
  })();
  assert.ok(e instanceof TranslationError);
  assert.match(e.message, /Bash/);
  assert.match(e.message, /withheld/);
  // And it says WHY, because a missing closing brace points at the output limit rather than at
  // the model producing bad JSON.
  assert.match(e.message, /closing brace|output limit/);
  assert.equal(e.detail.reason, "truncated");
});

test("malformed-but-complete arguments are distinguished from truncated ones", () => {
  const e = (() => {
    try { parseToolArguments('{"a": undefined}', { toolName: "Edit" }); } catch (x) { return x; }
  })();
  assert.equal(e.detail.reason, "malformed");
  assert.ok(!/output limit/.test(e.message), "a complete-but-invalid object is not a truncation");
});

test("arguments that parse to something other than an object are rejected", () => {
  // All valid JSON, none of them usable as a tool call's `input`.
  for (const [raw, reason] of [["[1,2]", "not-an-object"], ['"text"', "not-an-object"],
                               ["42", "not-an-object"], ["null", "not-an-object"]]) {
    const e = (() => { try { parseToolArguments(raw, { toolName: "T" }); } catch (x) { return x; } })();
    assert.ok(e instanceof TranslationError, `${raw} must be rejected`);
    assert.equal(e.detail.reason, reason);
  }
});

test("no arguments at all is legal only when the schema permits it", () => {
  // Plenty of tools genuinely take no parameters, so `{}` must stay possible — but only when it
  // means "the model passed nothing", never when it means "the arguments were lost".
  assert.deepEqual(parseToolArguments("", { toolName: "ListAgents" }), {});
  assert.deepEqual(parseToolArguments("   ", { toolName: "ListAgents", schema: { properties: {} } }), {});
  assert.deepEqual(parseToolArguments("", { toolName: "T", schema: { required: [] } }), {});

  const e = (() => {
    try {
      parseToolArguments("", { toolName: "Bash", schema: { required: ["command"], properties: { command: {} } } });
    } catch (x) { return x; }
  })();
  assert.ok(e instanceof TranslationError, "a required argument cannot be silently absent");
  assert.match(e.message, /requires command/);
  assert.equal(e.detail.reason, "empty-but-required");
});

test("schemaAllowsEmpty is permissive only where nothing was declared", () => {
  assert.equal(schemaAllowsEmpty(null), true);
  assert.equal(schemaAllowsEmpty({}), true);
  assert.equal(schemaAllowsEmpty({ required: [] }), true);
  assert.equal(schemaAllowsEmpty({ required: "command" }), true, "a malformed required is not a constraint");
  assert.equal(schemaAllowsEmpty({ required: ["command"] }), false);
});

test("well-formed arguments pass through untouched", () => {
  const args = { command: "ls -la", timeout: 5000, nested: { a: [1, 2] } };
  assert.deepEqual(parseToolArguments(JSON.stringify(args), { toolName: "Bash" }), args);
});

// ---------- the tool registry ----------

test("names are sanitized to what OpenAI accepts", () => {
  assert.equal(sanitizeToolName("Bash"), "Bash");
  assert.equal(sanitizeToolName("foo.bar"), "foo_bar");
  assert.equal(sanitizeToolName("a b:c"), "a_b_c");
  assert.equal(sanitizeToolName("notion-create-comment"), "notion-create-comment");
  assert.equal(sanitizeToolName("x".repeat(80)).length, 64);
  assert.equal(sanitizeToolName(""), "tool");
  assert.equal(sanitizeToolName(null), "tool");
});

test("a punctuation collision is refused, naming both tools and the reason", () => {
  // `foo.bar` and `foo_bar` both become `foo_bar`. Before this, the wire carried two tools with
  // the same name, the reverse map kept whichever was declared LAST, and the wrong schema pruned
  // the arguments — a call to the wrong tool with mangled input, attributed to the model.
  const e = (() => {
    try { ToolRegistry.from([tool("foo.bar"), tool("foo_bar")]); } catch (x) { return x; }
  })();
  assert.ok(e instanceof ToolCatalogError);
  assert.equal(e.status, 400);
  assert.match(e.message, /"foo\.bar"/);
  assert.match(e.message, /"foo_bar"/);
  assert.match(e.message, /characters OpenAI does not allow/);
  assert.deepEqual(e.tools.sort(), ["foo.bar", "foo_bar"]);
});

test("a truncation collision is refused, and blamed on the 64-character limit", () => {
  // The realistic one. `mcp__` plus a 36-character UUID plus `__` is 43 characters, leaving 21 for
  // the tool name. Measured on the 57 real MCP names this app sends: 32 are already truncated and
  // the closest pair is two characters from colliding.
  const uuid = "34c022b6-c54d-43d0-a207-c999a7f65ec4";
  const a = `mcp__${uuid}__slack_search_public_v1`;
  const b = `mcp__${uuid}__slack_search_public_v2`;
  assert.ok(a.length > 64 && b.length > 64, "the fixture must actually exceed the limit");
  assert.equal(sanitizeToolName(a), sanitizeToolName(b), "the fixture must actually collide");

  const e = (() => { try { ToolRegistry.from([tool(a), tool(b)]); } catch (x) { return x; } })();
  assert.ok(e instanceof ToolCatalogError);
  assert.match(e.message, /first 64 characters/);
  assert.match(e.message, /refused rather than guessing/);
  assert.ok(e.message.includes(a) && e.message.includes(b));
});

test("the real tool set this app sends is accepted", () => {
  // The collision is latent, not live. If this ever starts failing, a connector added a name that
  // collides — which is the entire point of checking.
  const uuid = "01039c8e-a5f1-4b5a-83d5-caf692a1bbab";
  const real = [
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task", "TodoWrite", "WebFetch",
    `mcp__${uuid}__download_file_content`, `mcp__${uuid}__get_file_permissions`,
    `mcp__${uuid}__get_file_metadata`, `mcp__${uuid}__read_file_content`,
    "mcp__34c022b6-c54d-43d0-a207-c999a7f65ec4__slack_search_public",
    "mcp__34c022b6-c54d-43d0-a207-c999a7f65ec4__slack_search_public_and_private",
    "mcp__3b7c752f-5851-4064-8612-392a2748bce5__notion-convert-page-to-skill",
    "mcp__3b7c752f-5851-4064-8612-392a2748bce5__notion-create-file-upload",
  ].map((n) => tool(n));
  const reg = ToolRegistry.from(real);
  assert.equal(reg.size, real.length);
});

test("a duplicate original name is refused before sanitizing enters into it", () => {
  const e = (() => {
    try { ToolRegistry.from([tool("Bash"), tool("Read"), tool("Bash")]); } catch (x) { return x; }
  })();
  assert.ok(e instanceof ToolCatalogError);
  assert.match(e.message, /declared more than once/);
});

test("a tool with no usable name is refused rather than becoming \"tool\"", () => {
  // sanitizeToolName maps an empty name to the literal "tool"; two of those would collide, and one
  // of them would silently answer for a tool the model cannot name.
  for (const bad of [{}, { name: "" }, { name: null }, { name: 42 }])
    assert.throws(() => ToolRegistry.from([bad]), ToolCatalogError);
});

test("the catalog is validated in full, before any cap drops tools", () => {
  // A collision must not depend on which tools happened to survive a per-surface cap — otherwise
  // the same catalog is valid on Responses and broken on Chat, and only sometimes.
  const many = Array.from({ length: 200 }, (_, i) => tool(`tool_${i}`));
  many.push(tool("collide.me"), tool("collide_me"));
  assert.throws(() => ToolRegistry.from(many), ToolCatalogError,
    "the collision is at the end of a 202-tool list and must still be found");
});

test("names round-trip in both directions, with the right schema", () => {
  const reg = ToolRegistry.from([
    tool("Bash", { required: ["command"], properties: { command: {} } }),
    tool("mcp__srv__do.thing", { properties: { x: {} } }),
  ]);
  assert.equal(reg.wireName("Bash"), "Bash");
  assert.equal(reg.wireName("mcp__srv__do.thing"), "mcp__srv__do_thing");
  assert.equal(reg.originalName("mcp__srv__do_thing"), "mcp__srv__do.thing");
  assert.equal(reg.originalName("Bash"), "Bash");
  assert.deepEqual(reg.schema("Bash").required, ["command"]);
  assert.equal(reg.has("Bash"), true);
  assert.equal(reg.has("Nope"), false);
});

test("a tool name the model invented reaches the client unchanged", () => {
  // The client's own "no such tool" error has to name what the model actually asked for. Rewriting
  // it to something plausible would send the user hunting for the wrong problem.
  const reg = ToolRegistry.from([tool("Bash")]);
  assert.equal(reg.originalName("TotallyMadeUp"), "TotallyMadeUp");
  assert.equal(reg.schema("TotallyMadeUp"), undefined);
});

test("an empty or absent tool list is a valid catalog", () => {
  for (const t of [[], null, undefined]) {
    const reg = ToolRegistry.from(t);
    assert.equal(reg.size, 0);
    assert.deepEqual(reg.all(), t === undefined || t === null ? [] : []);
  }
});

// ---------- error mapping ----------

test("a known failure keeps its message and status; anything else does not", () => {
  const req = errorResponse(new RequestError("messages must be an array"));
  assert.equal(req.status, 400);
  assert.equal(req.body.error.type, "invalid_request_error");
  assert.match(req.body.error.message, /messages must be an array/);

  const tr = errorResponse(new TranslationError("Bash: withheld"));
  assert.equal(tr.status, 502);
  assert.equal(tr.body.error.type, "api_error");

  // An unexpected error must not leak a stack trace or an internal path to the client.
  const boom = errorResponse(new TypeError("cannot read properties of undefined (reading 'x')"));
  assert.equal(boom.status, 500);
  assert.equal(boom.body.error.message, "internal proxy error");
  assert.ok(!JSON.stringify(boom).includes("undefined (reading"));
});
