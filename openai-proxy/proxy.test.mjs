// Unit tests for the proxy's output shaping and tool selection.
//   node --test openai-proxy/proxy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.PROXY_NO_LISTEN = "1";
const { makeMathFixer, fixMath, selectTools, isEssentialTool, buildFormatHint, findWriteTool,
        findSendFileTool, findRenderTool, findBgTools, toolResultText,
        buildPersistenceHint, withFormatHint, shouldAutoContinue, pruneToolArgs } =
  await import("./proxy.mjs");

// ---------- math delimiter rewriting ----------

test("rewrites inline and display TeX delimiters", () => {
  assert.equal(fixMath("the area is \\(\\pi r^2\\) exactly"), "the area is $\\pi r^2$ exactly");
  assert.equal(fixMath("\\[E = mc^2\\]"), "$$E = mc^2$$");
  assert.equal(fixMath("a \\(x\\) and \\[y\\] mixed"), "a $x$ and $$y$$ mixed");
});

test("leaves already-correct math untouched", () => {
  const s = "inline $x^2$ and display $$\\int_0^1 f$$";
  assert.equal(fixMath(s), s);
});

test("does NOT rewrite inside fenced code blocks", () => {
  const s = "before \\(a\\)\n```tex\n\\(keep me\\) \\[and me\\]\n```\nafter \\(b\\)";
  const out = fixMath(s);
  assert.match(out, /before \$a\$/);
  assert.match(out, /after \$b\$/);
  assert.ok(out.includes("\\(keep me\\) \\[and me\\]"), "code block content must be verbatim");
});

test("handles an unterminated fence without corrupting the tail", () => {
  const s = "text \\(a\\)\n```js\nconst x = 1; // \\(not math\\)";
  const out = fixMath(s);
  assert.match(out, /text \$a\$/);
  assert.ok(out.includes("\\(not math\\)"));
});

// The important one: the transform is applied to a stream of arbitrary chunks, so a
// delimiter or a ``` fence can straddle any boundary. Streaming output must equal
// one-shot output for EVERY possible split.
function streamAll(text, chunkSize) {
  const f = makeMathFixer();
  let out = "";
  for (let i = 0; i < text.length; i += chunkSize) out += f.push(text.slice(i, i + chunkSize));
  return out + f.flush();
}

test("streaming equals one-shot for every fixed chunk size", () => {
  const samples = [
    "area \\(\\pi r^2\\) and \\[E=mc^2\\] done",
    "```\n\\(code\\)\n```\nprose \\(math\\)",
    "\\(a\\)\\(b\\)\\[c\\]",
    "trailing backslash at end \\",
    "ends mid-delimiter \\(",
    "one ` tick and `` two and ``` fence \\(x\\)",
    "no math here at all",
  ];
  for (const s of samples) {
    const expect = fixMath(s);
    for (let cs = 1; cs <= Math.max(1, s.length); cs++) {
      assert.equal(streamAll(s, cs), expect, `chunkSize=${cs} sample=${JSON.stringify(s)}`);
    }
  }
});

test("streaming equals one-shot for every single split point", () => {
  const s = "x \\(a+b\\) y ```\n\\(raw\\)\n``` z \\[q\\]";
  const expect = fixMath(s);
  for (let i = 0; i <= s.length; i++) {
    const f = makeMathFixer();
    const out = f.push(s.slice(0, i)) + f.push(s.slice(i)) + f.flush();
    assert.equal(out, expect, `split at ${i}`);
  }
});

test("a held-back tail is always flushed, never dropped", () => {
  // Tails that look like the start of a fence or a delimiter get buffered; flush() must
  // emit them verbatim so no character is silently swallowed at end of stream.
  for (const s of ["abc\\", "abc`", "abc``", "abc```", "\\(", "\\", "`", "``", "```"]) {
    const f = makeMathFixer();
    const out = f.push(s) + f.flush();
    assert.equal(out, fixMath(s), `stream != one-shot for ${JSON.stringify(s)}`);
    // Nothing vanishes: a lone tail with no closing delimiter comes back unchanged.
    if (!/\\[()[\]]/.test(s)) assert.equal(out, s, `tail dropped for ${JSON.stringify(s)}`);
  }
});

// ---------- tool selection ----------

test("no clamping when under the limit", () => {
  const tools = [{ name: "Read" }, { name: "obscure_mcp_thing" }];
  const r = selectTools(tools, 128);
  assert.equal(r.tools.length, 2);
  assert.deepEqual(r.dropped, []);
});

test("Infinity limit keeps every tool (Responses API path)", () => {
  const tools = Array.from({ length: 214 }, (_, i) => ({ name: `tool_${i}` }));
  const r = selectTools(tools, Infinity);
  assert.equal(r.tools.length, 214);
  assert.deepEqual(r.dropped, []);
});

test("essential tools survive even when they sort last", () => {
  // 200 junk tools first, then the ones the agent actually needs — exactly the shape
  // that made blind slice(0,128) drop Bash/Write/Artifact.
  const junk = Array.from({ length: 200 }, (_, i) => ({ name: `mcp__vendor__thing_${i}` }));
  const essential = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task", "TodoWrite",
                     "WebFetch", "WebSearch", "Artifact", "mcp__visualize__show_widget"].map((name) => ({ name }));
  const r = selectTools([...junk, ...essential], 128);
  assert.equal(r.tools.length, 128);
  const kept = new Set(r.tools.map((t) => t.name));
  for (const e of essential) assert.ok(kept.has(e.name), `${e.name} must be kept`);
  assert.equal(r.dropped.length, 200 + essential.length - 128);
  for (const d of r.dropped) assert.ok(d.startsWith("mcp__vendor__thing_"), "only junk is dropped");
});

test("dropped list is accurate and duplicate names do not confuse it", () => {
  const tools = [{ name: "dup" }, { name: "dup" }, { name: "Read" }];
  const r = selectTools(tools, 2);
  assert.equal(r.tools.length, 2);
  assert.equal(r.dropped.length, 1);
});

test("isEssentialTool matches renderers and core tools, not arbitrary vendor tools", () => {
  for (const n of ["Read", "write", "Bash", "Grep", "Task", "WebSearch", "Artifact",
                   "mcp__visualize__show_widget", "create_diagram", "render_chart", "canvas"])
    assert.ok(isEssentialTool(n), `${n} should be essential`);
  for (const n of ["mcp__jira__list_issues", "slack_send_message", "get_weather", ""])
    assert.ok(!isEssentialTool(n), `${n} should not be essential`);
});

// ---------- format hint ----------

test("format hint always states the math rule", () => {
  for (const tools of [null, [], [{ name: "Write" }]])
    assert.match(buildFormatHint(tools), /\$\$\.\.\.\$\$/);
});

test("findWriteTool recognises the common file-writing tool names", () => {
  assert.equal(findWriteTool([{ name: "Read" }, { name: "Write" }]), "Write");
  assert.equal(findWriteTool([{ name: "create_file" }]), "create_file");
  assert.equal(findWriteTool([{ name: "str_replace_based_edit_tool" }]), null);
  assert.equal(findWriteTool([{ name: "Read" }, { name: "Bash" }]), null);
  assert.equal(findWriteTool(null), null);
});

test("hint ORDERS the model to call the write tool by name when one exists", () => {
  const h = buildFormatHint([{ name: "Read" }, { name: "Write" }]);
  assert.match(h, /MUST call the `Write` tool/);
  assert.match(h, /\.svg/);
  // The failure mode being fixed: telling the user to save the file themselves.
  assert.match(h, /do NOT tell the user to save, copy, or open it themselves/i);
});

test("hint falls back to a fenced svg block when no file tool is available", () => {
  const h = buildFormatHint([{ name: "Read" }, { name: "Bash" }]);
  assert.match(h, /```svg/);
  assert.ok(!/MUST call/.test(h), "must not order a tool call that isn't available");
  assert.match(h, /Do NOT instruct the user to save/i);
});

test("findSendFileTool recognises the file-display tool", () => {
  assert.equal(findSendFileTool([{ name: "Write" }, { name: "SendUserFile" }]), "SendUserFile");
  assert.equal(findSendFileTool([{ name: "send_user_file" }]), "send_user_file");
  assert.equal(findSendFileTool([{ name: "Write" }, { name: "Bash" }]), null);
  assert.equal(findSendFileTool(null), null);
});

test("with write AND send tools, the hint demands both steps", () => {
  // Writing the file only yields a path; the harness displays a file when it is SENT
  // with display:"render". Missing step 2 is why "render a pelican" produced a link.
  const h = buildFormatHint([{ name: "Write" }, { name: "SendUserFile" }, { name: "Bash" }]);
  assert.match(h, /\(1\) call `Write`/);
  assert.match(h, /\(2\) call `SendUserFile`/);
  assert.match(h, /display:"render"/);
  assert.match(h, /do NOT tell the user to open, save or download/i);
});

test("with only a send tool, the hint still asks for display:render", () => {
  const h = buildFormatHint([{ name: "SendUserFile" }, { name: "Read" }]);
  assert.match(h, /`SendUserFile`/);
  assert.match(h, /display:"render"/);
});

test("write-only hint does not reference a send tool that isn't there", () => {
  const h = buildFormatHint([{ name: "Write" }, { name: "Read" }]);
  assert.match(h, /MUST call the `Write` tool/);
  assert.ok(!/SendUserFile|display:"render"/.test(h), "must not name an unavailable tool");
});

// ---------- inline rendering + background visibility ----------

test("findRenderTool finds the app's real inline-render tool", () => {
  // The app exposes no SendUserFile; mcp__visualize__show_widget is what draws inline,
  // and it is the LAST of its 214 tools — the exact thing blind truncation dropped.
  assert.equal(findRenderTool([{ name: "Write" }, { name: "mcp__visualize__show_widget" }]),
    "mcp__visualize__show_widget");
  assert.equal(findRenderTool([{ name: "Artifact" }]), "Artifact");
  assert.equal(findRenderTool([{ name: "Write" }, { name: "Bash" }]), null);
});

test("render + write: BOTH are required, not either/or", () => {
  // show_widget draws inline but is transient and size-capped; the file is the durable
  // artifact. Neither substitutes for the other, so the hint demands both.
  const h = buildFormatHint([{ name: "Write" }, { name: "mcp__visualize__show_widget" }]);
  assert.match(h, /ALWAYS do both in the same turn/);
  assert.match(h, /\(1\) call `mcp__visualize__show_widget`/);
  assert.match(h, /\(2\) call `Write`/);
  assert.match(h, /ending in \.svg/);
  assert.match(h, /state the saved path/);
  // Must not fall back to the weaker write-only instruction.
  assert.ok(!/MUST call the `Write` tool/.test(h));
});

test("render with no write tool renders only, and demands no file", () => {
  const h = buildFormatHint([{ name: "mcp__visualize__show_widget" }, { name: "Read" }]);
  assert.match(h, /call `mcp__visualize__show_widget` with the SVG/);
  assert.ok(!/ALWAYS do both|\(2\) call/.test(h), "must not demand a write tool that isn't there");
});

test("background bullet names the retrieval tools that exist", () => {
  const h = buildFormatHint([{ name: "Workflow" }, { name: "TaskOutput" }, { name: "TaskList" }]);
  assert.match(h, /`TaskOutput`/);
  assert.match(h, /`TaskList`/);
  assert.match(h, /state clearly when you start something in the background/i);
  // The refusal this replaces: "I can't show output from an async tool."
  assert.match(h, /Never tell the user that output is unavailable/i);
});

test("background bullet still demands progress when no retrieval tool exists", () => {
  const h = buildFormatHint([{ name: "Bash" }]);
  assert.match(h, /never looks stalled/i);
  assert.ok(!/`TaskOutput`/.test(h), "must not name a tool that isn't available");
});

// ---------- tool_result fidelity ----------

test("tool_result text passes through unchanged for success", () => {
  assert.equal(toolResultText({ content: "total 24\ndrwxr-xr-x" }), "total 24\ndrwxr-xr-x");
  assert.equal(toolResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
});

test("is_error is marked so a failure cannot look like success", () => {
  // OpenAI has no error flag on tool output; dropping is_error made the model report
  // that a failed command had succeeded.
  assert.equal(toolResultText({ content: "No such file", is_error: true }), "[tool error] No such file");
  assert.match(toolResultText({ content: [{ type: "text", text: "boom" }], is_error: true }), /^\[tool error\] boom$/);
});

test("non-text tool_result parts are labelled, not silently emptied", () => {
  const out = toolResultText({ content: [{ type: "text", text: "chart:" }, { type: "image", source: {} }] });
  assert.match(out, /chart:/);
  assert.match(out, /\[image omitted by proxy\]/);
});

test("empty and null tool_result content do not throw", () => {
  assert.equal(toolResultText({ content: null }), "");
  assert.equal(toolResultText({}), "");
  assert.equal(toolResultText({ content: [] }), "");
});

// ---------- agentic persistence ----------

test("persistence hint forbids offering instead of acting", () => {
  const h = buildPersistenceHint();
  // The exact shape observed: "If you want, I'll run that now and return a clean list".
  assert.match(h, /Never reply with an offer to act/i);
  assert.match(h, /If you want, I can/);
  assert.match(h, /Shall I/);
  assert.match(h, /Investigation and read-only steps never need permission/i);
  assert.match(h, /carry out all of them in order/i);
});

test("persistence hint keeps the carve-out for actions that need a human", () => {
  // This must not talk the model out of pausing where pausing is correct.
  const h = buildPersistenceHint();
  assert.match(h, /destructive, irreversible, or sends something outward/i);
  assert.match(h, /credential or a decision only the user can make/i);
  assert.match(h, /genuinely ambiguous/i);
});

test("persistence and output fixups are independent sections", () => {
  // Both default on, so a request's system prompt carries both, and neither depends on
  // the other being enabled.
  const sys = withFormatHint("BASE", true, [{ name: "Write" }, { name: "TaskOutput" }]);
  assert.match(sys, /^BASE/);
  assert.match(sys, /## Output formatting for this client/);
  assert.match(sys, /## Working autonomously/);
});

test("the classifier call gets neither section", () => {
  assert.equal(withFormatHint("BASE", false, [{ name: "Write" }]), "BASE");
});

// ---------- auto-continue trigger ----------

test("auto-continue fires on announcements the model did not act on", () => {
  // All observed verbatim from the app.
  for (const t of [
    "I'll query Gerrit for your most recently abandoned CLs now and list them newest-first.",
    "I can pull that for you, but I need to query your Gerrit (SSH/REST) first. If you want, I'll run that now",
    "I can check that, but I need one detail to proceed: which Gerrit host/project should I query?",
    "Let me run the tests and report back.",
    // Captured verbatim from a real stall. The model writes a typographic apostrophe
    // (U+2019) in "I’ll", which an ASCII-only i'?ll pattern silently misses.
    "I’ll check your local git/Gerrit metadata for your recently abandoned CLs and report back.",
    "I’m going to run the query now.",
    "I'm starting that now in the background.",
    "Shall I go ahead and list them?",
  ]) assert.ok(shouldAutoContinue(t), `should continue: ${t.slice(0, 60)}`);
});

test("auto-continue does NOT fire on a finished turn", () => {
  for (const t of [
    "Done — I rendered a red pelican SVG and saved it to /tmp/red_pelican.svg",
    "The tests pass: 33/33.",
    "I found 3 abandoned CLs: 4589, 4527 and 4482.",
    "",
  ]) assert.ok(!shouldAutoContinue(t), `should stop: ${t.slice(0, 60)}`);
});

test("auto-continue NEVER fires on a confirmation request for something destructive", () => {
  // Continuing these would answer the question for the user and then act.
  for (const t of [
    "That command would permanently delete the remote branch. Confirm and I will run it.",
    "This is irreversible — are you sure? I'll proceed once you confirm.",
    "I'll force-push to master once you give the go-ahead.",
    "I need your approval before I continue: I'll run rm -rf on that directory.",
  ]) assert.ok(!shouldAutoContinue(t), `must stay ended: ${t.slice(0, 60)}`);
});

test("auto-continue leaves a genuine user-only decision alone", () => {
  assert.ok(!shouldAutoContinue("Which of these two designs do you prefer — the flat one or the nested one?"));
  assert.ok(!shouldAutoContinue("I could not find a Gerrit remote after checking git config, .gitreview and ~/.ssh/config."));
});

// ---------- tool-argument pruning ----------

const WORKFLOW_SCHEMA = {
  type: "object",
  properties: { script: { type: "string" }, scriptPath: { type: "string" }, name: { type: "string" },
                args: {}, resumeFromRunId: { type: "string" }, title: {}, description: {} },
};

test("drops an argument that belongs to a different tool", () => {
  // The real failure: Workflow called with run_in_background, which Agent/Bash have and
  // Workflow does not, rejected as InputValidationError.
  const { args, dropped } = pruneToolArgs(WORKFLOW_SCHEMA, { script: "export const meta = {}", run_in_background: true });
  assert.deepEqual(Object.keys(args), ["script"]);
  assert.deepEqual(dropped, ["run_in_background"]);
});

test("leaves a valid call completely untouched", () => {
  const call = { script: "x", name: "find-flaky", args: [1, 2] };
  const { args, dropped } = pruneToolArgs(WORKFLOW_SCHEMA, call);
  assert.deepEqual(args, call);
  assert.deepEqual(dropped, []);
});

test("does not prune when the schema opts into extra properties", () => {
  const schema = { type: "object", properties: { a: {} }, additionalProperties: true };
  const { args, dropped } = pruneToolArgs(schema, { a: 1, b: 2 });
  assert.deepEqual(args, { a: 1, b: 2 });
  assert.deepEqual(dropped, []);
});

test("does not prune when the schema enumerates nothing", () => {
  for (const schema of [undefined, null, {}, { type: "object" }]) {
    const { args, dropped } = pruneToolArgs(schema, { anything: 1 });
    assert.deepEqual(args, { anything: 1 });
    assert.deepEqual(dropped, []);
  }
});

test("a required key is never stripped, even if properties omit it", () => {
  // Malformed schema: required names a key that properties doesn't list. Surfacing it and
  // letting the harness complain beats silently sending an incomplete call.
  const schema = { type: "object", properties: { a: {} }, required: ["b"] };
  const { args } = pruneToolArgs(schema, { a: 1, b: 2 });
  assert.deepEqual(args, { a: 1, b: 2 });
});

test("non-object arguments pass through unharmed", () => {
  for (const v of ["str", 5, null, [1, 2]]) {
    const { args } = pruneToolArgs(WORKFLOW_SCHEMA, v);
    assert.deepEqual(args, v);
  }
});

// ---------- thinking must not starve small-budget calls ----------

test("reasoning is only requested when the token budget can afford it", () => {
  // Reasoning shares max_output_tokens with the answer. The app's background title call
  // (max_tokens=64) returned 0 characters four times in a row with reasoning enabled.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /out\.max_output_tokens >= THINKING_MIN_BUDGET/,
    "the reasoning param must be gated on the requested budget");
  assert.match(src, /OPENAI_THINKING_MIN_BUDGET/, "the threshold must be configurable");
  assert.match(src, /retrying without reasoning/, "a starved response must be retried without reasoning");
});
