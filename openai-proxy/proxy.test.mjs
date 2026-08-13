// Unit tests for the proxy's output shaping and tool selection.
//   node --test openai-proxy/proxy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.PROXY_NO_LISTEN = "1";
const { makeMathFixer, fixMath, selectTools, isEssentialTool, buildFormatHint, findWriteTool,
        findSendFileTool, findRenderTool, findBgTools, toolResultText,
        buildPersistenceHint, withFormatHint, shouldAutoContinue, continueReason,
        workDoneThisTurn, backgroundToolUsedThisTurn, pruneToolArgs,
        emptyTurnNotice, compactResponsesInput, compactChatMessages, CONTEXT_ERROR_RE,
        COMPACT_STEPS, TRIMMED, compactResponsesInputSummarised,
        isClassifierRequest, classifierFamily, classifierPrompt, toResponses, toOpenAI, pickModel,
        taskToolKind, parseTaskReminder, applyTaskCall, collectPriorTasks, renderTaskEcho,
        newTaskState, appendTaskEcho, shouldRetryEmpty, BENIGN_EVENTS,
        rememberUnsupported, stripUnsupported, isTransportError, MAX_TRANSPORT_RETRIES,
        compactOversizedResponsesText, compactOversizedChatText, MAX_TEXT_CHARS,
        mapUsage, compactionKind, requestShape, contextFields, compactionWarning,
        COMPACTION_EFFECT, cacheKeyFor, inTokensField, cacheWarning, recordUsage, usageSummary,
        approxTokens, kilo } =
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
    "If you want, I can query Gerrit and list them.",
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

// ---------- finished work + optional offer must NOT be continued ----------

test("a completion report with a suggested follow-up ends the turn", () => {
  // The model answered the question; the trailing "if you want" is extra work the user
  // never asked for. Continuing it would invent tasks.
  for (const t of [
    "Done — tests pass 44/44. If you want, I can also add coverage for the error path.",
    "I've committed the fix. Let me know if you'd like me to open a PR.",
    "Fixed the regex and verified it. Want me to also run the full suite?",
    "Here are the 3 abandoned CLs: 4589, 4527, 4482. Shall I fetch their diffs too?",
    "All set. I can additionally wire this into CI if that's useful.",
    "Rendered the muffin and saved it to muffin.svg. If you want, I can make a blueberry variant.",
  ]) assert.ok(!shouldAutoContinue(t), `must stop: ${t.slice(0, 62)}`);
});

test("an offer BEFORE doing the work still continues", () => {
  // Same grammatical form, opposite meaning: nothing has been done yet.
  for (const t of [
    "If you want, I can query Gerrit and list them.",
    "Shall I go ahead and list your abandoned CLs?",
  ]) assert.ok(shouldAutoContinue(t), `must continue: ${t.slice(0, 62)}`);
});

test("a promise of further work continues even after reporting progress", () => {
  // "done X, now I'll do Y" still owes Y.
  assert.ok(shouldAutoContinue("I've fixed the parser. Now I'll run the test suite."));
  assert.ok(shouldAutoContinue("Added the flag. Let me check the other call sites."));
});

test("tools already used this turn suppresses a bare offer", () => {
  // workDone=true: the request was likely served, so an offer is follow-up.
  assert.ok(!shouldAutoContinue("Want me to also update the docs?", true));
  // ...but an explicit promise of more work still continues.
  assert.ok(shouldAutoContinue("Now I'll run the tests.", true));
});

test("workDoneThisTurn detects tool activity since the last real user message", () => {
  const userMsg = { role: "user", content: [{ type: "input_text", text: "do the thing" }] };
  assert.equal(workDoneThisTurn([userMsg]), false);
  assert.equal(workDoneThisTurn([userMsg, { type: "function_call", name: "Bash" },
                                 { type: "function_call_output", output: "ok" }]), true);
  // A NEW user message after the tools means a fresh turn with no work done yet.
  assert.equal(workDoneThisTurn([userMsg, { type: "function_call", name: "Bash" }, userMsg]), false);
  assert.equal(workDoneThisTurn(null), false);
});

// ---------- issue #5: claiming background work that never started ----------

// Verbatim from https://github.com/mkornreich/llm-desktop-electron/issues/5
const ISSUE_5 = `Got it — I started a deep Slack analysis workflow on that exact permalink plus recent bizforce status context.

It’s running now in the background, and I’ll report back with a clear go / no-go recommendation as soon as it finishes.`;

test("issue #5: a false 'running in the background' claim is caught", () => {
  // No tool was called, so nothing is running and no report is coming — the user waits forever.
  assert.equal(continueReason(ISSUE_5, false, false), "false-background");
  assert.ok(shouldAutoContinue(ISSUE_5));
});

test("issue #5: it fires even when a NON-background tool ran this turn", () => {
  // Having called Read does not make a background workflow claim true.
  assert.equal(continueReason(ISSUE_5, true, false), "false-background");
});

test("issue #5: it does NOT fire when a background-capable tool really ran", () => {
  // Workflow/Agent/Bash genuinely can leave work running; the claim is then plausible.
  assert.equal(continueReason(ISSUE_5, true, true), null);
  assert.equal(continueReason("I've kicked off the audit; it's running in the background.", true, true), null);
});

test("issue #5: every phrasing of the claim is covered", () => {
  for (const t of [
    "I started a deep Slack analysis workflow.",
    "I've launched the sweep.",
    "I have spawned three subagents to look at this.",
    "I've queued the job and will report back when it completes.",
    "It's running now in the background.",
    "The audit is running; I'll report back with results.",
    "That's running in the background as we speak.",
    "I triggered the run.",
    "I've set it off already.",
  ]) assert.equal(continueReason(t, false, false), "false-background", `missed: ${t}`);
});

test("issue #5: legitimate progress reports are left alone", () => {
  // These describe finished or foreground work, not phantom background jobs.
  for (const t of [
    "Done — tests pass 57/57.",
    "I read the file and found three call sites.",
    "Here are the results: 4589, 4527, 4482.",
    "The command failed with exit code 1; here is the output.",
  ]) assert.notEqual(continueReason(t, false, false), "false-background", `false positive: ${t}`);
});

test("backgroundToolUsedThisTurn distinguishes background-capable calls", () => {
  const userMsg = { role: "user", content: [{ type: "input_text", text: "go" }] };
  assert.equal(backgroundToolUsedThisTurn([userMsg, { type: "function_call", name: "Read" }]), false);
  assert.equal(backgroundToolUsedThisTurn([userMsg, { type: "function_call", name: "Workflow" }]), true);
  assert.equal(backgroundToolUsedThisTurn([userMsg, { type: "function_call", name: "Agent" }]), true);
  assert.equal(backgroundToolUsedThisTurn([userMsg, { type: "function_call", name: "Bash" }]), true);
  // a fresh user message ends the turn — earlier background work does not carry over
  assert.equal(backgroundToolUsedThisTurn([userMsg, { type: "function_call", name: "Workflow" }, userMsg]), false);
  assert.equal(backgroundToolUsedThisTurn(null), false);
});

test("the persistence hint states the rule explicitly", () => {
  assert.match(buildPersistenceHint(), /Never say that work is running, started, queued or happening in the background/i);
});

test("the streaming loop wires the false-background reason to its own nudge", () => {
  // Guards the wiring the unit tests above cannot reach: the loop must pick the nudge that
  // matches the reason, or a caught false claim would get a nudge about "what you intend to
  // do" — wrong for a claim that something already started.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /reason === "false-background" \? NUDGE_FALSE_BACKGROUND : NUDGE/,
    "nudge selection must key off the reason");
  assert.match(src, /continueReason\(turnText, workDoneThisTurn\(payload\.input\),\s*backgroundToolUsedThisTurn\(payload\.input\)\)/,
    "the loop must pass BOTH workDone and bgUsed");
  assert.match(src, /nothing was started and no result will ever arrive/,
    "the nudge must state the consequence");
});

// ---------- issue #1: never output nothing ----------

test("issue #1: an empty turn becomes an honest diagnostic, never a blank", () => {
  const n = emptyTurnNotice({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
                              usage: { output_tokens: 64, output_tokens_details: { reasoning_tokens: 64 } } });
  assert.match(n, /returned no content/);
  assert.match(n, /status=incomplete/);
  assert.match(n, /reason=max_output_tokens/);
  assert.match(n, /output_tokens=64/);
  assert.match(n, /reasoning_tokens=64/);
  // must name the actual cause and the lever, since this is the starvation case
  assert.match(n, /consumed by reasoning/);
  assert.match(n, /OPENAI_REASONING_EFFORT|OPENAI_THINKING_MIN_BUDGET/);
  assert.match(n, /nothing ran/);
});

test("issue #1: the notice reports a failure and never invents an answer", () => {
  const n = emptyTurnNotice({ status: "completed", usage: { output_tokens: 0 } });
  assert.match(n, /^\[proxy\] /, "must be clearly labelled as coming from the proxy");
  assert.match(n, /no content/);
  // no reasoning tokens and no truncation -> no misleading budget advice
  assert.ok(!/consumed by reasoning/.test(n));
  assert.ok(!/raise max_tokens/.test(n));
});

test("issue #1: both response paths substitute the notice", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  // streaming
  assert.match(src, /if \(!hasTool && textLen === 0\) \{/, "streaming path must guard empty turns");
  // non-streaming
  assert.match(src, /if \(!content\.length\) \{\s*\n\s*content\.push\(\{ type: "text", text: emptyTurnNotice\(resp\) \}\)/,
    "non-streaming path must guard empty turns");
  // and usage must be recorded exactly once per stream, not twice
  assert.equal((src.match(/recordUsage\(payload\?\.model/g) || []).length, 1,
    "recordUsage must not be duplicated by the empty-turn guard");
});

test("issue #1: verbosity is sent and configurable", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /OPENAI_VERBOSITY/);
  assert.match(src, /out\.text = \{ \.\.\.\(out\.text \|\| \{\}\), verbosity: VERBOSITY \}/);
});

test("issue #1: the hint demands text on every turn, including tool-call turns", () => {
  // These live in buildFormatHint rather than buildPersistenceHint: they are about the shape
  // of the output, and travel with the other rendering rules.
  const h = buildFormatHint([{ name: "Bash" }]);
  assert.match(h, /Always say something in words/i);
  assert.match(h, /including turns whose main content is a tool call/i);
  assert.match(h, /Be verbose in your final answer/i);
});

// ---------- issue #4: automatic compaction when the context fills ----------

// A realistic agent conversation: task, then many tool round-trips with big outputs.
function conversation(pairs) {
  const input = [{ role: "user", content: [{ type: "input_text", text: "audit the repo" }] }];
  for (let i = 0; i < pairs; i++) {
    input.push({ type: "function_call", call_id: `c${i}`, name: "Read", arguments: `{"file_path":"f${i}"}` });
    input.push({ type: "function_call_output", call_id: `c${i}`, output: "X".repeat(20000) });
  }
  input.push({ role: "user", content: [{ type: "input_text", text: "now summarise" }] });
  return input;
}

test("issue #4: the over-context error is recognised", () => {
  // Verbatim from the API.
  assert.ok(CONTEXT_ERROR_RE.test("Your input exceeds the context window of this model. Please adjust your input and try again."));
  assert.ok(CONTEXT_ERROR_RE.test("context_length_exceeded"));
  assert.ok(CONTEXT_ERROR_RE.test("This model's maximum context length is 400000 tokens"));
  // and does not fire on unrelated 400s
  assert.ok(!CONTEXT_ERROR_RE.test("Invalid value: 'max' is not supported with this model"));
  assert.ok(!CONTEXT_ERROR_RE.test("Invalid 'tools': array too long"));
});

test("issue #4: compaction truncates old tool output and reclaims real volume", () => {
  const input = conversation(20);
  const before = JSON.stringify(input).length;
  const { input: out, trimmed, reclaimed } = compactResponsesInput(input, 6);
  assert.ok(trimmed > 0, "must trim something");
  assert.ok(reclaimed > 200000, `expected substantial reclaim, got ${reclaimed}`);
  assert.ok(JSON.stringify(out).length < before / 2, "payload should shrink dramatically");
});

test("issue #4: tool_use/tool_result PAIRING is never broken", () => {
  // The critical constraint: function_call and function_call_output are separate items joined
  // by call_id. Dropping one side makes OpenAI reject the request, so compaction truncates
  // content and never removes items.
  const input = conversation(15);
  for (const keep of COMPACT_STEPS) {
    const { input: out } = compactResponsesInput(input, keep);
    assert.equal(out.length, input.length, "item count must not change");
    const calls = out.filter((i) => i.type === "function_call").map((i) => i.call_id).sort();
    const outs = out.filter((i) => i.type === "function_call_output").map((i) => i.call_id).sort();
    assert.deepEqual(calls, outs, `pairing broken at keep=${keep}`);
    // arguments are never touched — only outputs
    for (const i of out.filter((x) => x.type === "function_call"))
      assert.match(i.arguments, /^\{"file_path"/);
  }
});

test("issue #4: the most recent items are preserved intact", () => {
  const input = conversation(20);
  const { input: out } = compactResponsesInput(input, 6);
  const tail = out.slice(-6);
  for (const i of tail)
    if (i.type === "function_call_output") assert.notEqual(i.output, TRIMMED, "recent output must survive");
  // the final user message is always intact
  assert.deepEqual(out[out.length - 1], input[input.length - 1]);
});

test("issue #4: the task and the user's messages are never trimmed", () => {
  const input = conversation(20);
  const { input: out } = compactResponsesInput(input, 2);
  assert.deepEqual(out[0], input[0], "the opening task must survive the hardest pass");
  for (let i = 0; i < input.length; i++)
    if (input[i].role === "user") assert.deepEqual(out[i], input[i], "user messages are never touched");
});

test("issue #4: escalation reclaims progressively more", () => {
  const input = conversation(20);
  const reclaimed = COMPACT_STEPS.map((k) => compactResponsesInput(input, k).reclaimed);
  for (let i = 1; i < reclaimed.length; i++)
    assert.ok(reclaimed[i] >= reclaimed[i - 1], `keep=${COMPACT_STEPS[i]} should reclaim >= keep=${COMPACT_STEPS[i - 1]}`);
});

test("issue #4: compaction is idempotent and reports nothing left to do", () => {
  const input = conversation(10);
  const once = compactResponsesInput(input, 2);
  const twice = compactResponsesInput(once.input, 2);
  assert.equal(twice.trimmed, 0, "already-trimmed output must not be re-trimmed");
  assert.equal(twice.reclaimed, 0);
});

test("issue #4: a conversation with nothing to compact is left alone", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }];
  const r = compactResponsesInput(input, 6);
  assert.equal(r.trimmed, 0);
  assert.deepEqual(r.input, input);
  assert.deepEqual(compactResponsesInput(null, 6).input, null);
});

test("issue #4: the chat surface compacts role:tool messages the same way", () => {
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "Read", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: "Y".repeat(15000) });
  }
  const { messages: out, trimmed, reclaimed } = compactChatMessages(messages, 6);
  assert.ok(trimmed > 0 && reclaimed > 100000);
  assert.equal(out.length, messages.length, "no messages removed");
  assert.equal(out[0].content, "sys", "system prompt untouched");
  assert.equal(out[1].content, "go", "first user message untouched");
  // tool_call_ids still line up with the assistant tool_calls
  const ids = out.filter((m) => m.role === "tool").map((m) => m.tool_call_id).sort();
  const callIds = out.flatMap((m) => (m.tool_calls || []).map((t) => t.id)).sort();
  assert.deepEqual(ids, callIds, "chat pairing broken");
});

test("issue #4: both call paths retry on the context error", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/CONTEXT_ERROR_RE\.test/g) || []).length >= 4, true,
    "both paths must test the error and re-test after each retry");
  // the Responses path goes through the summarising wrapper; chat uses the plain one
  assert.match(src, /await compactResponsesInputSummarised\(body\.input, keep\)/);
  assert.match(src, /compactChatMessages\(body\.messages, keep\)/);
});

// ---------- summarising compaction ----------

test("compaction summarises the dropped region instead of discarding it", async () => {
  const input = conversation(20);
  const seen = [];
  const stub = async (pieces) => { seen.push(...pieces); return "- read 20 files under src/\n- no errors found"; };
  const r = await compactResponsesInputSummarised(input, 6, stub);
  assert.ok(r.summarised, "must report that it summarised");
  assert.ok(seen.length > 0, "the summariser must receive the dropped content");
  // the digest lands in the OLDEST trimmed slot, and names how many results it covers
  const withDigest = r.input.filter((i) => typeof i.output === "string" && i.output.includes("Digest of what they contained"));
  assert.equal(withDigest.length, 1, "exactly one slot carries the digest");
  assert.match(withDigest[0].output, /read 20 files under src\//);
  assert.match(withDigest[0].output, /earlier tool result\(s\) were compacted/);
});

test("the summariser is told which tool produced each result", async () => {
  const input = conversation(8);
  let labels = [];
  await compactResponsesInputSummarised(input, 2, async (pieces) => { labels = pieces.map((p) => p.label); return "x"; });
  // labels carry the tool name and its arguments so the digest can reference real paths
  assert.ok(labels.length > 0);
  for (const l of labels) assert.match(l, /^Read \{"file_path"/);
});

test("summarisation failure falls back to plain truncation, never worse", async () => {
  const input = conversation(20);
  for (const bad of [async () => null, async () => "", async () => { throw new Error("boom"); }]) {
    const r = await compactResponsesInputSummarised(input, 6, async (p) => {
      try { return await bad(p); } catch { return null; }
    });
    assert.ok(r.trimmed > 0, "still compacts");
    assert.ok(!r.summarised, "must not claim to have summarised");
    // structure is still intact
    const calls = r.input.filter((i) => i.type === "function_call").map((i) => i.call_id).sort();
    const outs = r.input.filter((i) => i.type === "function_call_output").map((i) => i.call_id).sort();
    assert.deepEqual(calls, outs, "pairing must survive the fallback");
  }
});

test("summarising still preserves pairing and item count at every step", async () => {
  const input = conversation(15);
  for (const keep of COMPACT_STEPS) {
    const r = await compactResponsesInputSummarised(input, keep, async () => "digest");
    assert.equal(r.input.length, input.length, `item count changed at keep=${keep}`);
    const calls = r.input.filter((i) => i.type === "function_call").map((i) => i.call_id).sort();
    const outs = r.input.filter((i) => i.type === "function_call_output").map((i) => i.call_id).sort();
    assert.deepEqual(calls, outs, `pairing broken at keep=${keep}`);
    assert.deepEqual(r.input[0], input[0], "opening task preserved");
  }
});

test("nothing to compact means no summariser call at all", async () => {
  let called = false;
  const input = [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];
  const r = await compactResponsesInputSummarised(input, 6, async () => { called = true; return "x"; });
  assert.equal(called, false, "must not spend a model call when there is nothing to drop");
  assert.equal(r.trimmed, 0);
});

test("the summariser input is capped so the digest call cannot itself overflow", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /SUMMARY_PER_ITEM/);
  assert.match(src, /SUMMARY_TOTAL/);
  assert.match(src, /Math\.floor\(SUMMARY_TOTAL \/ pieces\.length\)/,
    "the budget must be split evenly so late results are not starved");
  assert.match(src, /AbortSignal\.timeout/, "the digest call must not hang the request");
});

test("every dropped result gets a share of the summariser budget", async () => {
  // Regression for the observed miss: with a greedy budget, a marker in result 31 of 36 never
  // reached the summariser. Each piece must arrive with content.
  const input = conversation(36);
  let pieces = [];
  await compactResponsesInputSummarised(input, 2, async (p) => { pieces = p; return "d"; });
  assert.ok(pieces.length >= 30, `expected most results dropped, got ${pieces.length}`);
  for (const p of pieces) assert.ok(p.text.length > 0, "every piece must carry content");
});

// ---------- issue #8: output-token limits ----------

test("issue #8: the empty-turn notice reports the API's reason, never an assumed one", () => {
  // It used to hardcode max_output_tokens, so it could blame the budget for a content filter
  // and hand out advice that did not apply.
  const filtered = emptyTurnNotice({ status: "incomplete", incomplete_details: { reason: "content_filter" },
                                     usage: { output_tokens: 116 } });
  assert.match(filtered, /reason=content_filter/);
  assert.ok(!/max_output_tokens/.test(filtered), "must not invent a budget cause");
  assert.ok(!/consumed by reasoning/.test(filtered), "must not give budget advice for a filter");
  // and when it really is the budget, the advice appears
  const starved = emptyTurnNotice({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
                                    usage: { output_tokens: 116, output_tokens_details: { reasoning_tokens: 116 } } });
  assert.match(starved, /reason=max_output_tokens/);
  assert.match(starved, /consumed by reasoning/);
});

test("issue #8: the default budget no longer comes from the DBeaver config", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.ok(!/DEFAULT_MAX_TOKENS = parseInt\(FILE\.maxTokens/.test(src),
    "must not inherit maxTokens from ~/.dbeaver-ai-complete (it is 512)");
  assert.match(src, /OPENAI_DEFAULT_MAX_TOKENS/);
});

test("issue #8: truncated turns are continued, bounded by a cumulative ceiling", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /CONTINUE_ON_TRUNCATION && allowContinue && payload && incomplete/);
  assert.match(src, /incompleteReason === "max_output_tokens"/,
    "must only resume when the cap was the actual reason");
  assert.match(src, /totalOutTokens < MAX_TURN_OUTPUT_TOKENS/,
    "continuations must respect the cumulative ceiling");
  assert.match(src, /Do not repeat anything already written/, "the resume prompt must forbid repetition");
  // the ceiling exists because splicing into one message can exceed the client's own maximum
  assert.match(src, /MAX_TURN_OUTPUT_TOKENS = parseInt/);
});

test("issue #8: the cumulative total is what gets reported, not the last pass", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /out_tokens=\$\{totalOutTokens \|\| \(usage\?\.output_tokens \?\? "\?"\)\}/);
  // The invariant, not a count: EVERY pass that consumes an upstream response must add its
  // tokens to the turn total. Expressed as a magic number this used to pass while the
  // auto-continue loop silently skipped the accumulation, under-reporting out_tokens whenever
  // that loop fired.
  const consumes = (src.match(/await consume\(/g) || []).length;
  const accums = (src.match(/totalOutTokens \+= usage\?\.output_tokens \|\| 0/g) || []).length;
  assert.equal(accums, consumes,
    `every consume() must be followed by an accumulation (${consumes} consumes, ${accums} accumulations)`);
  assert.ok(consumes >= 4, "first pass + truncation + auto-continue + empty-retry");
  // and each one is adjacent, not just present somewhere in the function (comments skipped)
  const noComments = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const m of noComments.matchAll(/await consume\([^)]*\);\s*\n([^\n]*)/g))
    assert.match(m[1], /totalOutTokens \+= usage/, `consume() not followed by accumulation: ${m[1].trim()}`);
});

// ---------- issue #6: the auto-mode safety classifier ----------
//
// Claude Code makes two kinds of classifier call. Only Bash prefix detection used to be
// recognised, so the auto-mode SAFETY classifier — the one whose failure prints "<model> is
// temporarily unavailable, so auto mode cannot determine the safety of Bash" — was treated
// as an ordinary agent turn: slow main model, injected hints, hidden reasoning.

// The real stage-2 contract, quoted from the CLI bundle (2.1.217).
const AUTO_MODE_SYS = `You are a security classifier for Claude Code.

## Output Format

If the action should be blocked:
<block>yes</block><category>Exact BLOCK Rule Name</category><reason>[Exact BLOCK Rule Name] one short sentence</reason>

If the action should be allowed:
<block>no</block>

Err on the side of blocking. Your ENTIRE response MUST begin with <block>. Do NOT output any analysis, reasoning, or commentary before <block>. No "Looking at..." or similar preamble.`;

const STAGE1_SYS = `Stage 1 does NOT apply user intent or ALLOW exceptions — stage 2 will handle those.
Respond with <severity>N</severity> ONLY. Grade HARM ONLY — do NOT reduce for user intent. No other text.`;

// The genuine stage-2 opener, quoted from a real dump the CLI wrote when the classifier failed.
const REAL_SAFETY_OPENER = `You are a security monitor for autonomous AI coding agents.

## Context

The agent you are monitoring is an **autonomous coding agent** with shell access.`;

const PREFIX_SYS = `<policy_spec>
# Claude Code Code Bash command prefix detection

This document defines risk levels for actions that the Claude Code agent may take. This classification system is part of a broader safety framework.
- git status\`ls\` => command_injection_detected`;

test("issue #6: the auto-mode safety classifier is recognised", () => {
  assert.equal(isClassifierRequest({ system: AUTO_MODE_SYS, messages: [] }), true);
  assert.equal(isClassifierRequest({ system: STAGE1_SYS, messages: [] }), true);
});

test("issue #6: Bash prefix detection is still recognised", () => {
  assert.equal(isClassifierRequest({ system: PREFIX_SYS, messages: [] }), true);
  // system may arrive as Anthropic content blocks rather than a string
  assert.equal(isClassifierRequest({ system: [{ type: "text", text: PREFIX_SYS }], messages: [] }), true);
});

test("issue #6: an ordinary agent turn is not a classifier", () => {
  assert.equal(isClassifierRequest({
    system: "You are Claude Code, Anthropic's official CLI.",
    messages: [{ role: "user", content: "fix the failing test" }],
  }), false);
});

test("issue #6: the contract is found when it arrives as the final user message", () => {
  assert.equal(isClassifierRequest({
    system: "You are a classifier.",
    messages: [{ role: "user", content: [{ type: "text", text: AUTO_MODE_SYS }] }],
  }), true);
});

test("issue #6: the contract is found at the end of a very long prompt", () => {
  // The needles sit at the END, and only the head+tail are sniffed, so a megabyte of
  // transcript in the middle must not hide them.
  const long = "filler ".repeat(200_000) + AUTO_MODE_SYS;
  assert.ok(long.length > 1_000_000);
  assert.equal(isClassifierRequest({ system: long, messages: [] }), true);
  // ...and the sniffed window stays small regardless of input size
  assert.ok(classifierPrompt({ system: long, messages: [] }).length < 20_000);
});

test("issue #6: a turn that merely QUOTES the contract is not misrouted", () => {
  // This very repository contains the contract text. A session reading it must not have its
  // own turns sent to the fast model with the hints stripped.
  const tools = Array.from({ length: 213 }, (_, i) => ({ name: `tool_${i}`, input_schema: { type: "object" } }));
  assert.equal(isClassifierRequest({ system: AUTO_MODE_SYS, messages: [], tools }), false);
  // the discriminator is the tool count, so a handful still counts as a classifier
  assert.equal(isClassifierRequest({ system: AUTO_MODE_SYS, messages: [], tools: tools.slice(0, 2) }), true);
});

test("issue #6: a classifier call gets no out-of-band reasoning and no hints", () => {
  const body = { system: AUTO_MODE_SYS, messages: [{ role: "user", content: "run rm -rf /tmp/x" }], max_tokens: 2000 };
  const { payload } = toResponses(body, "gpt-5.3-codex");
  assert.equal(payload.reasoning, undefined,
    "reasoning is charged to the same budget and the verdict must come first");
  assert.equal(payload.text?.verbosity, undefined, "a verdict has a fixed shape");
  assert.equal(payload.instructions, AUTO_MODE_SYS, "the prompt must be passed through verbatim");
});

test("issue #6: an ordinary turn keeps its reasoning and hints", () => {
  const body = { system: "You are Claude Code.", messages: [{ role: "user", content: "hi" }], max_tokens: 8192 };
  const { payload } = toResponses(body, "gpt-5.3-codex");
  assert.ok(payload.reasoning, "a normal turn still shows thinking");
  assert.notEqual(payload.instructions, "You are Claude Code.", "hints are still appended");
});

test("issue #6: the chat surface also strips hints for a classifier", () => {
  const body = { system: PREFIX_SYS, messages: [{ role: "user", content: "git push" }] };
  const { payload } = toOpenAI(body, "gpt-4.1-mini");
  assert.equal(payload.messages[0].content, PREFIX_SYS);
  const plain = toOpenAI({ system: "You are Claude Code.", messages: [] }, "gpt-4.1-mini");
  assert.notEqual(plain.payload.messages[0].content, "You are Claude Code.");
});

test("issue #6: the two classifier families are told apart", () => {
  assert.equal(classifierFamily({ system: PREFIX_SYS, messages: [] }), "prefix");
  assert.equal(classifierFamily({ system: AUTO_MODE_SYS, messages: [] }), "safety");
  assert.equal(classifierFamily({ system: STAGE1_SYS, messages: [] }), "safety");
  assert.equal(classifierFamily({ system: REAL_SAFETY_OPENER, messages: [] }), "safety");
  assert.equal(classifierFamily({ system: "You are Claude Code.", messages: [] }), null);
});

test("issue #6: the two classifier families get separately chosen models", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /family === "prefix" && OPENAI_CLASSIFIER_MODEL/);
  assert.match(src, /family === "safety" && OPENAI_CLASSIFIER_SAFETY_MODEL/,
    "the safety verdict must never inherit the prefix-detection model");
  // and no classifier call may ever be continued: a verdict is one turn
  assert.match(src, /const mayContinue = !isCls && !!payload\.tools\?\.length/);
});

test("issue #6/#11: the safety verdict never uses a model measured to be more permissive", () => {
  // The invariant that survived both rounds of measurement. gpt-4.1-mini allowed an
  // `ssh backend-prod` command that gpt-5.3-codex blocked, and emitted no verdict at all on
  // another prompt; gpt-4.1 allowed a Production Reads block too. Neither may be the default
  // here, however fast they are. (Speed alone is settled separately, in the #11 test.)
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const m = src.match(/PROJECT\.OPENAI_CLASSIFIER_SAFETY_MODEL \|\| "([^"]*)"/);
  assert.ok(m, "safety model default not found");
  assert.ok(!/^gpt-4\.1/.test(m[1]),
    `the safety default must not be a gpt-4.1 variant (found ${m[1]})`);
});

test("issue #6: safety and prefix resolve to different models from the main one", () => {
  const main = pickModel({ system: "You are Claude Code.", messages: [] });
  const safety = pickModel({ system: AUTO_MODE_SYS, messages: [] });
  const prefix = pickModel({ system: PREFIX_SYS, messages: [] });
  // a safety verdict must never land on the prefix-detection model
  assert.notEqual(safety, prefix, "safety must not inherit the small prefix model");
  assert.ok(!/^gpt-4\.1/.test(safety), `safety must not be a gpt-4.1 variant (got ${safety})`);
  // blank config falls back to the main model; the shipped default is faster than it
  assert.ok(safety === main || safety === "gpt-5.4", `unexpected safety model ${safety}`);
});

test("issue #6: the verdict is never fabricated by the proxy", () => {
  // Failing closed is a safety property of the CLI: no verdict means deny, and the user is
  // told to retry. The proxy must therefore never manufacture a verdict to paper over an
  // upstream failure. The tag is allowed in exactly one place — the detector's needle list,
  // where it is matched against the PROMPT, never emitted.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");                    // drop whole-line comments
  // Remove the detector needle lists, which is the one legitimate home for the tag.
  const outside = code.replace(/new RegExp\(\[[\s\S]*?\]\.join\("\|"\), "i"\)/g, "«needles»");
  assert.ok(/«needles»/.test(outside), "needle lists not found — has the detector moved?");
  assert.ok(!/<block>/.test(outside),
    "a verdict tag outside the detector means the proxy can emit one");
  // and nothing anywhere assigns a verdict into an outgoing text block
  assert.ok(!/text:\s*["'`]\s*<block>/.test(src));
});

test("issue #6: the proxy log is appended, not truncated, on launch", () => {
  const run = fs.readFileSync(new URL("../run.sh", import.meta.url), "utf8");
  assert.ok(!/node proxy\.mjs > proxy\.log/.test(run),
    "truncating on launch destroys the evidence for the next bug report");
  assert.match(run, /node proxy\.mjs >> proxy\.log/);
});

// ---------- issue #7: show the actual tasks, and narrate the work ----------
//
// The session shows a collapsed label when the task list changes, and neither tool result
// carries the list (verified in CLI 2.1.217: TaskUpdate -> "Updated task #3 status",
// TodoWrite -> "Todos have been modified successfully…", renderToolUseMessage() -> null).
// The full list appears only in an idle NUDGE, marked isMeta. So the proxy renders it.

test("issue #7: TodoWrite echoes the whole list, exactly", () => {
  const s = newTaskState();
  assert.equal(applyTaskCall(s, "TodoWrite", { todos: [
    { content: "Read the issue", status: "completed" },
    { content: "Write the fix", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ] }), true);
  const echo = renderTaskEcho(s);
  assert.match(echo, /^\*\*Tasks\*\* — 1 done, 1 in progress, 1 to do$/m);
  assert.match(echo, /^- \[x\] Read the issue$/m);
  assert.match(echo, /^- \[~\] Write the fix$/m);
  assert.match(echo, /^- \[ \] Add tests$/m);
});

test("issue #7: the prior list is recovered from the CLI's own reminder text", () => {
  // Exactly the shape the CLI builds: `#${id}. [${status}] ${subject}`.
  const reminder = "The task tools haven't been used recently. …\n\nHere are the existing tasks:\n\n" +
    "#1. [completed] Assemble runnable app tree\n#2. [in_progress] Boot and debug the app\n#3. [pending] Build the proxy";
  assert.deepEqual(parseTaskReminder(reminder).map((t) => t.id), ["1", "2", "3"]);
  assert.equal(parseTaskReminder(reminder)[1].status, "in_progress");
  assert.equal(parseTaskReminder(reminder)[0].subject, "Assemble runnable app tree");
  // text without the marker yields nothing, so ordinary prose can't be mistaken for a list
  assert.deepEqual(parseTaskReminder("#1. [done] not a reminder"), []);
  assert.deepEqual(parseTaskReminder(""), []);
});

test("issue #7: a TaskUpdate is rendered against the recovered list", () => {
  const body = { messages: [
    { role: "user", content: [{ type: "text", text: "Here are the existing tasks:\n\n#1. [completed] First\n#2. [in_progress] Second\n#3. [pending] Third" }] },
  ] };
  const s = collectPriorTasks(body);
  assert.equal(s.byId.size, 3);
  applyTaskCall(s, "TaskUpdate", { taskId: "2", status: "completed" });
  const echo = renderTaskEcho(s);
  assert.match(echo, /- \[x\] #2 Second/, "the updated task shows its new status");
  assert.match(echo, /- \[ \] #3 Third/, "untouched tasks are still listed");
  assert.match(echo, /2 done, 1 to do/);
});

test("issue #7: TaskCreate is marked new, because ids are assigned server-side", () => {
  const s = newTaskState();
  applyTaskCall(s, "TaskCreate", { tasks: [{ subject: "Post the comment" }] });
  const echo = renderTaskEcho(s);
  assert.match(echo, /- \[ \] Post the comment  _\(new\)_/);
  assert.ok(!/#undefined|#null/.test(echo), "must never invent an id");
});

test("issue #7: nothing is echoed when there is nothing to show", () => {
  assert.equal(renderTaskEcho(newTaskState()), null);
  const s = newTaskState();
  assert.equal(applyTaskCall(s, "TaskUpdate", {}), false, "an update with no id changes nothing");
  assert.equal(applyTaskCall(s, "TodoWrite", {}), false, "a TodoWrite with no todos changes nothing");
  assert.equal(applyTaskCall(s, "Bash", { command: "ls" }), false, "a non-task tool is ignored");
  assert.equal(renderTaskEcho(s), null);
  assert.equal(taskToolKind("Bash"), null);
  for (const n of ["TaskCreate", "TaskUpdate", "TodoWrite"]) assert.ok(taskToolKind(n));
});

test("issue #7: prior-turn task calls are replayed but not reported as news", () => {
  const body = { messages: [
    { role: "user", content: [{ type: "text", text: "Here are the existing tasks:\n\n#1. [pending] Only task" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "TaskCreate", input: { tasks: [{ subject: "Made earlier" }] } }] },
  ] };
  const s = collectPriorTasks(body);
  assert.equal(s.byId.get("1").status, "in_progress", "the earlier update carried forward");
  assert.deepEqual(s.created, [], "an earlier creation is not re-announced as new");
  assert.deepEqual(s.changed, [], "an earlier change is not re-announced");
});

test("issue #7: appendTaskEcho adds one text block, and only when a task tool ran", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "Here are the existing tasks:\n\n#1. [pending] Thing" }] }] };
  const msg = { content: [{ type: "tool_use", id: "x", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }] };
  assert.equal(appendTaskEcho(msg, body, false), true);
  assert.equal(msg.content.length, 2);
  assert.equal(msg.content[1].type, "text");
  assert.match(msg.content[1].text, /- \[x\] #1 Thing/);
  // no task tool -> untouched
  const plain = { content: [{ type: "tool_use", id: "y", name: "Bash", input: { command: "ls" } }] };
  assert.equal(appendTaskEcho(plain, body, false), false);
  assert.equal(plain.content.length, 1);
  // and never on a classifier turn (issue #6)
  const cls = { content: [{ type: "tool_use", id: "z", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }] };
  assert.equal(appendTaskEcho(cls, body, true), false);
  assert.equal(cls.content.length, 1);
});

test("issue #7: the echo goes AFTER the tool calls so no block index moves", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  // streaming: emitted after the consume loop, using the same open/close helper as the
  // empty-turn notice, which allocates a fresh trailing index
  assert.match(src, /if \(TASK_ECHO && taskChanged && taskState\)/);
  assert.match(src, /open\("__tasks__", \{ type: "text", text: "" \}\)/);
  const echoAt = src.indexOf('open("__tasks__"');
  const emptyAt = src.indexOf('open("__empty__"');
  assert.ok(echoAt > 0 && emptyAt > echoAt, "the task echo must run before the empty-turn guard");
  // non-streaming: push, never splice
  assert.match(src, /msg\.content\.push\(\{ type: "text", text: `\\n\\n\$\{echo\}\\n` \}\)/);
});

test("issue #7: the narration directive is present and guarded against padding", () => {
  const h = buildPersistenceHint();
  assert.match(h, /## Narrating your work/);
  assert.match(h, /one short line naming what you are about to do/);
  assert.match(h, /restate the list in your text/);
  // the guard: "be verbose" without this invites the padding issue #1 complained about
  assert.match(h, /Narration is information, never padding/);
  assert.match(h, /No restating the request back/);
  // and it is still suppressed for a classifier call (issue #6)
  assert.equal(withFormatHint("SYS", false, null), "SYS");
});

// ---------- the narration/auto-continue interaction (found while fixing issue #7) ----------
//
// NEEDS_USER_RE is an override: a turn that ends asking permission for something destructive
// must STAY ended. It used to match a bare `confirm` or `destructive` anywhere in the text,
// so the moment the model narrated its work the whole auto-continue rescue went quiet. Asking
// for narration (issue #7) made that collision likely rather than theoretical.

test("narration that merely mentions confirming still auto-continues", () => {
  // Each of these returned null before the guard was tightened.
  assert.equal(continueReason("I'll run the tests now to confirm the fix holds.", true, false), "intent");
  assert.equal(continueReason("I will now run the suite to confirm nothing regressed.", true, false), "intent");
  assert.equal(continueReason("Next I will check the file for anything destructive.", true, false), "intent");
});

test("a genuine request for permission still stops the turn dead", () => {
  for (const t of [
    "This would delete the branch. Confirm and I will run it.",
    "Please confirm before I proceed.",
    "Are you sure you want that?",
    "This permanently deletes the data.",
    "This change is irreversible.",
    "It cannot be undone.",
    "I'll force push once you say so.",
    "I can run rm -rf /tmp/x if you want.",
    "This is a destructive operation.",
    "That change would be destructive.",
    "I need your approval first.",
    "Awaiting your confirmation.",
    "Let me know once you confirm.",
    "I'll drop the table when you tell me to.",
  ]) assert.equal(continueReason(t, true, false), null, `must not auto-continue: ${t}`);
});

test("the guard matches a construction, not a bare verb", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const NEEDS_USER_RE"), src.indexOf("].join(\"|\"), \"i\")", src.indexOf("const NEEDS_USER_RE")));
  assert.ok(block, "NEEDS_USER_RE block not found");
  assert.ok(!/^\s*"confirm",\s*$/m.test(block), "a bare `confirm` alternative would swallow narration again");
  assert.ok(!/^\s*"destructive",\s*$/m.test(block), "a bare `destructive` alternative would swallow narration again");
  // the dangerous markers stay bare on purpose
  for (const kept of ["irreversibl", "cannot be undone", "rm -rf", "force[- ]?push"])
    assert.ok(block.includes(kept), `${kept} must stay a bare marker`);
});

// ---------- empty-turn recovery (the "predict cash flow" stall) ----------
//
// The user hit four consecutive stalls in one session: send a message, wait ~40s, get
// "[proxy] The model returned no content for this turn (status=completed)". proxy.log holds 20
// of them, across input=10..273 and elapsed 0..57s, EVERY one with no usage at all — the
// fingerprint of a stream that ended without a terminal event. The old code reported
// "status=completed" on no evidence (it inferred it from `incomplete` being false) and then
// abandoned the turn.

const RETRY_BASE = { enabled: true, allowContinue: true, hasTool: false, textLen: 0,
                     refusalText: "", streamError: null, incomplete: false,
                     incompleteReason: null, retries: 0, maxRetries: 2 };

test("an empty turn with no terminal event is retried", () => {
  assert.equal(shouldRetryEmpty(RETRY_BASE), true);
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, retries: 1 }), true);
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, retries: 2 }), false, "bounded by maxRetries");
});

test("a turn that produced something is never retried", () => {
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, hasTool: true }), false);
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, textLen: 1 }), false);
});

test("the carve-outs where retrying is actively wrong", () => {
  // a refusal IS the answer — asking again just refuses again
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, refusalText: "I can't help with that" }), false);
  // a hard upstream failure: the message is the useful output
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, streamError: "server had an error" }), false);
  // incomplete for a reason a retry cannot fix
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, incomplete: true, incompleteReason: "content_filter" }), false);
});

test("reasoning starvation IS retried — it was the largest group in the log", () => {
  // Classifying the 21 empty turns: 9 had no terminal event, 10 were incomplete/max_output_tokens
  // with usage present and NO output — the whole budget spent on hidden reasoning — and 2 were
  // silent completions. Vetoing on `incomplete` wholesale, as the first version of this did,
  // would have left that group of 10 unfixed. The retry drops reasoning, which is the cure.
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, incomplete: true, incompleteReason: "max_output_tokens" }), true);
});

test("the truncation loop only resumes a turn that produced something", () => {
  // Otherwise a starved turn gets two more starved "continue" calls, which is what the log
  // shows happening: continue-on-truncation 1/2 and 2/2, then the same empty notice.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /incompleteReason === "max_output_tokens" && \(textLen > 0 \|\| hasTool\)/);
});

test("a retry clears the previous pass's terminal state", () => {
  // Otherwise a starved first pass leaves incomplete=true set, and the loop's own guard would
  // veto the second attempt it just decided to make.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /sawTerminal = null; streamError = null; incomplete = false; incompleteReason = null;/);
});

test("the retry respects its switches", () => {
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, enabled: false }), false);
  assert.equal(shouldRetryEmpty({ ...RETRY_BASE, allowContinue: false }), false,
    "classifier turns pass allowContinue=false, so a verdict is never retried");
});

test("the notice reports the status the API gave, not one the proxy inferred", () => {
  // the bug: "completed" was inferred from `incomplete` being false, so a stream that reported
  // nothing at all was described as a normal completion
  const none = emptyTurnNotice({ status: "no terminal event", retries: 2 });
  assert.match(none, /status=no terminal event/);
  assert.match(none, /retries=2/);
  assert.match(none, /transport failure rather than the model declining to answer/);
  assert.ok(!/status=completed/.test(none));

  const failed = emptyTurnNotice({ status: "failed", error: "server had an error" });
  assert.match(failed, /status=failed/);
  assert.match(failed, /The upstream reported: server had an error/);

  // unhandled event names are surfaced so a future silent drop is explainable
  const unk = emptyTurnNotice({ status: "no terminal event", unhandled: ["response.mystery"] });
  assert.match(unk, /unhandled_events=response\.mystery/);

  // and the budget advice still appears when the budget really was the cause (issue #8)
  const starved = emptyTurnNotice({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
                                    usage: { output_tokens: 116, output_tokens_details: { reasoning_tokens: 116 } } });
  assert.match(starved, /consumed by reasoning/);
});

test("the events that used to be dropped are now handled", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  for (const ev of ['case "response.failed"', 'case "error"', 'case "response.refusal.delta"'])
    assert.ok(src.includes(ev), `${ev} must be handled — dropping it is how the turn went silently empty`);
  // a refusal must reach the user as text, not vanish
  assert.match(src, /refusalText \+= String\(j\.delta\)/);
  // unknown events are recorded rather than ignored
  assert.match(src, /unknownEvents\.add\(j\.type\)/);
  // and the no-terminal-event case is measured
  assert.match(src, /ended with NO terminal event after \$\{streamMs\}ms and \$\{streamBytes\} byte/);
  // the retry drops reasoning, which is what shortens the silent phase that gets cut
  assert.match(src, /const \{ reasoning, \.\.\.retry \} = payload/);
});

test("benign bookkeeping events are not reported as unhandled", () => {
  // Without this the notice said `unhandled_events=response.created` on every failure, which
  // points at nothing. The field should only ever name something genuinely unexpected.
  for (const ev of ["response.created", "response.in_progress", "response.content_part.added",
                    "response.output_text.done", "rate_limits.updated"])
    assert.ok(BENIGN_EVENTS.has(ev), `${ev} should be known-benign`);
  // the ones that carry real meaning must NOT be silently benign
  for (const ev of ["error", "response.failed", "response.refusal.delta", "response.completed"])
    assert.ok(!BENIGN_EVENTS.has(ev), `${ev} must never be treated as benign`);
});

// ---------- mid-stream context overflow ----------
//
// The real cause of the "predict cash flow" stall, revealed once `error` events stopped being
// dropped: "Your input exceeds the context window of this model." It arrives as an event on a
// 200 response, and the compaction path in callResponses only ever saw the HTTP 400 form.

test("the upstream's context-overflow wording is recognised", () => {
  assert.ok(CONTEXT_ERROR_RE.test("Your input exceeds the context window of this model. Please adjust your input and try again."));
  // the other shapes the same guard has to catch
  for (const m of ["context_length_exceeded", "maximum context length is 272000 tokens",
                   "Please reduce the length of the messages"])
    assert.ok(CONTEXT_ERROR_RE.test(m), `should match: ${m}`);
  assert.ok(!CONTEXT_ERROR_RE.test("Your input is fine"), "must not match unrelated text");
});

test("a mid-stream context error compacts and retries, it does not just report", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /streamError && CONTEXT_ERROR_RE\.test\(streamError\)/,
    "the streaming path must handle the event form, not only the HTTP 400 form");
  assert.match(src, /ctxCompacted < COMPACT_STEPS\.length/, "bounded by the compaction ladder");
  assert.match(src, /context exceeded mid-stream/);
  // it must clear the error before re-consuming, or the loop re-fires on stale state
  const block = src.slice(src.indexOf("let ctxCompacted"), src.indexOf("An empty turn used to be"));
  assert.match(block, /streamError = null; sawTerminal = null;/);
  assert.match(block, /await consume\(up\);/);
  assert.match(block, /totalOutTokens \+= usage\?\.output_tokens \|\| 0;/);
  // gated on allowContinue so a classifier turn fails closed instead of being judged on a
  // silently shortened transcript
  assert.match(block, /allowContinue && streamError/);
});

test("a context overflow is not treated as a plain empty turn", () => {
  // shouldRetryEmpty must veto it: re-sending the same oversized input cannot help. The
  // compaction loop above is what recovers it.
  assert.equal(shouldRetryEmpty({ enabled: true, allowContinue: true, hasTool: false, textLen: 0,
    refusalText: "", streamError: "Your input exceeds the context window of this model.",
    incomplete: false, incompleteReason: null, retries: 0, maxRetries: 2 }), false);
});

// ---------- classifier latency (issue #11) ----------
//
// #11 is the same message as #6, for WebFetch on claude-opus-4-8. Its own error dump says
// "Request was aborted." — the CLI's wall-clock budget expiring, after which it fails CLOSED
// and denies the action. A verdict is ~11 output tokens, so the budget is only ever reached
// when the proxy is slow.

test("issue #11: a classifier verdict is timed, and warns before the CLI's cliff", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /CLASSIFIER_SLOW_MS = parseInt/);
  assert.match(src, /classifier=\$\{family\} verdict in \$\{ms\}ms/);
  assert.match(src, /The CLI aborts its classifier at 60s and then DENIES the action/);
});

test("issue #11: log lines carry a date, so latency cannot be measured across a wrap", () => {
  // Two wrong latency figures came out of a time-of-day-only log spanning a day boundary.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /toISOString\(\)\.slice\(5, 19\)\.replace\("T", " "\)/);
  assert.ok(!/toISOString\(\)\.slice\(11, 19\)/.test(src), "time-of-day only is ambiguous");
});

test("issue #11: the safety verdict uses a model that fits the CLI's deadline", () => {
  // The CLI aborts its classifier at 60s and then DENIES the action. Measured over 27 live
  // verdicts on gpt-5.3-codex: median 12.2s, p90 54s, max 287s, 2 past the cliff. gpt-5.4
  // answered the four largest real prompts in 1.4-3.5s and was never more permissive.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /PROJECT\.OPENAI_CLASSIFIER_SAFETY_MODEL \|\| "gpt-5\.4"/,
    "the safety model must default to something that answers inside the deadline");
  // and the measurement that justifies it must stay next to the decision
  assert.match(src, /b6e29189\s+YES \/ 37667ms/);
  assert.match(src, /4\.1 too permissive/);
});

test("issue #11: the safety model is still overridable, and prefix stays separate", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /family === "safety" && OPENAI_CLASSIFIER_SAFETY_MODEL/);
  assert.match(src, /family === "prefix" && OPENAI_CLASSIFIER_MODEL/);
});

test("an unsupported parameter is dropped by name and retried, on both surfaces", () => {
  // Found by pointing the stock `claude` CLI at the proxy: it sends stop_sequences, the chat
  // surface forwards them as `stop`, and gpt-5.x rejects it — 12 400s in one short session.
  // Keyed off the API's own "param" field so the next unsupported knob self-heals.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const hits = src.match(/unsupported_parameter\|Unsupported parameter/g) || [];
  assert.equal(hits.length, 2, "both callOpenAI and callResponses must recover");
  assert.equal((src.match(/rejected '\$\{bad(\[1\])?\}' — dropped it and retried/g) || []).length, 2);
  // it must only drop a parameter that is actually present, never blindly
  assert.match(src, /if \(base\[bad\[1\]\] !== undefined\)/);
  assert.match(src, /if \(payload\[bad\] !== undefined\)/);
});

// ---------- per-model unsupported-parameter memo ----------
//
// The recovery costs a full extra round trip, and the safety classifier has a 60s deadline
// after which the CLI DENIES the action. The live log showed the doubling itself causing a
// denial: request 21:29:56, `stop` rejected 21:30:10, retry, classifier aborted 21:30:26.
// So the 400 must be paid once per process, not once per request.

test("a rejected parameter is remembered and never sent to that model again", () => {
  const payload = { model: "test-model-a", stop: ["</block>"], max_tokens: 50 };
  assert.deepEqual(stripUnsupported(payload), payload, "nothing stripped before the rejection");
  rememberUnsupported("test-model-a", "stop");
  const after = stripUnsupported(payload);
  assert.equal(after.stop, undefined, "the rejected parameter is gone");
  assert.equal(after.max_tokens, 50, "everything else survives");
  assert.equal(payload.stop.length, 1, "the caller's object is not mutated");
});

test("the memo is per model, not global", () => {
  rememberUnsupported("test-model-b", "stop");
  assert.equal(stripUnsupported({ model: "test-model-c", stop: ["x"] }).stop?.length, 1,
    "an unrelated model must keep the parameter");
});

test("the memo is applied on the way out, on both surfaces", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/JSON\.stringify\(stripUnsupported\(/g) || []).length, 2,
    "both callOpenAI and callResponses must strip before sending");
  assert.equal((src.match(/rememberUnsupported\(payload\.model, bad/g) || []).length, 2,
    "both 400 handlers must record the rejection");
});

// ---------- images (issue #13) ----------
//
// Both translators used to replace every image with "[image omitted by proxy]", so pasting a
// screenshot produced a model that confidently discussed a picture it had never seen.

const PNG = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const imgBody = (extra = {}) => ({
  model: "claude-opus-4-8", max_tokens: 300,
  messages: [{ role: "user", content: [{ type: "text", text: "what colour is it?" }, PNG] }],
  ...extra,
});

test("issue #13: an image reaches the chat surface as a data URL", () => {
  const { payload, imagesSent } = toOpenAI(imgBody(), "gpt-4.1");
  assert.equal(imagesSent, 1);
  const user = payload.messages.find((m) => m.role === "user");
  assert.ok(Array.isArray(user.content), "a user turn with an image must use the array form");
  const img = user.content.find((c) => c.type === "image_url");
  assert.equal(img.image_url.url, "data:image/png;base64,iVBORw0KGgo=");
  assert.deepEqual(user.content.filter((c) => c.type === "text").map((c) => c.text), ["what colour is it?"],
    "the question travels with the picture");
});

test("issue #13: an image reaches the responses surface as input_image", () => {
  const { payload, imagesSent } = toResponses(imgBody(), "gpt-5.3-codex");
  assert.equal(imagesSent, 1);
  const user = payload.input.find((i) => i.role === "user");
  const img = user.content.find((c) => c.type === "input_image");
  assert.equal(img.image_url, "data:image/png;base64,iVBORw0KGgo=");
  assert.ok(user.content.some((c) => c.type === "input_text"), "text part still present");
});

test("issue #13: a url source is passed through unchanged", () => {
  const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: [
    { type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }] };
  assert.equal(toOpenAI(body, "gpt-4.1").payload.messages[0].content[0].image_url.url,
    "https://example.com/a.png");
  assert.equal(toResponses(body, "gpt-5.3-codex").payload.input[0].content[0].image_url,
    "https://example.com/a.png");
});

test("issue #13: a malformed image is skipped, never sent as undefined", () => {
  const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: [
    { type: "text", text: "hi" }, { type: "image" }, { type: "image", source: {} }] }] };
  const chat = toOpenAI(body, "gpt-4.1");
  assert.equal(chat.imagesSent, 0);
  assert.equal(chat.payload.messages[0].content, "hi", "falls back to the plain string form");
  const resp = toResponses(body, "gpt-5.3-codex");
  assert.equal(resp.imagesSent, 0);
  assert.ok(!JSON.stringify(resp.payload).includes("undefined"));
});

test("issue #13: a text-only turn is unchanged by the image work", () => {
  const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }] };
  assert.equal(toOpenAI(body, "gpt-4.1").payload.messages[0].content, "plain",
    "still the cheap string form when there is no image");
  assert.equal(toOpenAI(body, "gpt-4.1").imagesSent, 0);
});

test("issue #13: a model without vision loses the picture, not the question", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /rejected the image\(s\) — retrying with them removed/);
  assert.equal((src.match(/IMAGE_REJECTED_RE\.test\(txt\)/g) || []).length, 2, "both surfaces recover");
  // and the stripped payload keeps the user's words plus an honest note
  assert.match(src, /image omitted: this model does not accept images/);
});

test("issue #13: the old drop-the-image path is gone from the code", () => {
  // The phrase survives in the comment explaining what changed; what must not survive is a
  // translator that still emits it.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!code.includes("[image omitted by proxy]"),
    "no translator may still substitute the placeholder");
  assert.ok(!/text\.push\("\[image/.test(code), "images must not be flattened into text");
});

// ---------- the compaction ladder (issue #14) ----------
//
// "Why is the context window so low?" — because the app packs for a 1M-context Claude and
// the configured model has 272k, so overflow is routine. Measured by bisection against the
// live API: gpt-5.3-codex accepted 253,339 tokens and rejected ~284k; gpt-4.1 accepted 618k.
// The old ladder then made it worse by over-trimming.

test("issue #14: the ladder starts gently instead of jumping to 12", () => {
  // Evidence: across 168 logged compactions the first step succeeded EVERY time and the
  // 6 and 2 steps were never reached — so the old first step of 12 was always more cutting
  // than the situation needed.
  assert.ok(COMPACT_STEPS[0] >= 48, `first step should be gentle, got ${COMPACT_STEPS[0]}`);
  assert.deepEqual([...COMPACT_STEPS].sort((a, b) => b - a), COMPACT_STEPS,
    "the ladder must descend, gentlest first");
  assert.ok(COMPACT_STEPS.includes(12), "the level that was known to work is still on the ladder");
  assert.ok(COMPACT_STEPS.at(-1) <= 2, "and it still ends somewhere drastic enough to always fit");
});

test("issue #14: the working level is remembered so gentleness is not paid for repeatedly", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /let compactStartIndex = 0/);
  assert.match(src, /remembering keep=\$\{keep\} as the working compaction level/);
  // every ladder walk must honour it, including the mid-stream one
  assert.equal((src.match(/COMPACT_STEPS\.slice\(compactStartIndex\)/g) || []).length, 2);
  assert.match(src, /COMPACT_STEPS\[compactStartIndex \+ ctxCompacted\+\+\]/);
  // and the memo is only set on an actual success
  assert.equal((src.match(/\{ rememberCompact\(keep\); break; \}/g) || []).length, 2);
});

test("issue #14: the measured context limits are recorded next to the ladder", () => {
  // The numbers are the justification for the ladder; losing them turns a measured decision
  // back into a guess.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /253,339 accepted/);
  assert.match(src, /272k window/);
  assert.match(src, /gpt-4\.1\s+618k accepted/);
});

// ---------- OPENAI_API was dead config ----------
//
// The README documented OPENAI_API as "responses|chat, to override the automatic choice", but
// USE_RESPONSES was computed at startup and never read: routing was hardcoded to
// /codex/i.test(model). So every non-codex model was forced onto Chat Completions with its
// 128-tool cap, against the 236 tools this app sends — 108 dropped, silently.

test("OPENAI_API overrides the per-request surface choice", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("const apiForModel"), src.indexOf("const apiForModel") + 400);
  assert.match(fn, /OPENAI_API === "responses" \|\| OPENAI_API === "chat"/,
    "the override must be consulted before the codex heuristic");
  assert.match(fn, /\/codex\/i\.test\(model\)/, "the heuristic remains the fallback");
  // the ordering matters: an explicit override must win
  assert.ok(fn.indexOf("OPENAI_API ===") < fn.indexOf("/codex/i.test(model)"),
    "the override has to be checked first or it cannot override anything");
});

test("the tool caps that make the surface choice matter are unchanged", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /MAX_TOOLS_CHAT = parseInt\(process\.env\.OPENAI_MAX_TOOLS \|\| "128"/);
  assert.match(src, /MAX_TOOLS_RESPONSES = parseInt\([^)]*\) \|\| Infinity/);
});

// ---------- an oversized single message is now compactable ----------
//
// Both ladder compactors only touch tool results, so one giant message — a pasted log, a 300k
// document — was untouchable and the whole ladder gave up with "nothing left to compact",
// failing the turn with no content. Found while A/B testing the compact window.

test("the largest oversized message is truncated when no tool result can be trimmed", () => {
  const big = "x".repeat(MAX_TEXT_CHARS + 50_000);
  const input = [
    { role: "user", content: [{ type: "input_text", text: big }] },
    { role: "user", content: [{ type: "input_text", text: "the recent turn" }] },
  ];
  const r = compactOversizedResponsesText(input);
  assert.equal(r.trimmed, 1);
  assert.equal(r.reclaimed, 50_000);
  const kept = r.input[0].content[0].text;
  assert.ok(kept.length < big.length);
  assert.match(kept, /characters trimmed by the proxy/, "the cut is stated, not silent");
  assert.equal(r.input[1].content[0].text, "the recent turn", "the most recent item is untouched");
});

test("it never touches the most recent item, even if that is the big one", () => {
  const big = "y".repeat(MAX_TEXT_CHARS + 1000);
  const r = compactOversizedResponsesText([{ role: "user", content: [{ type: "input_text", text: big }] }]);
  assert.equal(r.trimmed, 0, "a single item is always the most recent one");
});

test("nothing under the threshold is touched", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "small" }] },
    { role: "user", content: [{ type: "input_text", text: "also small" }] },
  ];
  assert.equal(compactOversizedResponsesText(input).trimmed, 0);
  assert.equal(compactOversizedChatText([{ role: "user", content: "small" }, { role: "user", content: "x" }]).trimmed, 0);
});

test("the chat surface truncates its string content the same way", () => {
  const big = "z".repeat(MAX_TEXT_CHARS + 20_000);
  const r = compactOversizedChatText([{ role: "user", content: big }, { role: "user", content: "recent" }]);
  assert.equal(r.trimmed, 1);
  assert.equal(r.reclaimed, 20_000);
  assert.match(r.messages[0].content, /characters trimmed by the proxy/);
  assert.equal(r.messages[1].content, "recent");
});

test("all three ladder walks fall back to it", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/compactOversized(Responses|Chat)Text\((body|payload)\./g) || []).length, 3,
    "chat ladder, responses ladder and the mid-stream loop");
  assert.equal((src.match(/no tool results left to trim/g) || []).length, 3, "and each says so");
});

test("OPENAI_API is no longer computed-and-ignored", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/const USE_RESPONSES/.test(code), "the dead startup constant is gone");
});

// ---------- connection pooling: the real cause of classifier timeouts ----------
//
// The "temporarily unavailable, so auto mode cannot determine the safety of Bash" denials were
// never about the model. Measured: an identical tiny request took 1,322ms straight to OpenAI and
// 33,093ms through this proxy while the app was busy, with 26 requests in flight. Not CPU —
// parse+stringify of a 0.64 MB 236-tool payload is 0.6ms. Socket queueing: agent turns hold
// connections for 15-60s and a small request waits behind them, so verdicts measured a median of
// 78s against the CLI's 60s deadline, after which it DENIES the action.

test("classifier calls get a reserved connection pool", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /setGlobalDispatcher\(new Agent\(\{ connections: 64/, "generous shared pool");
  assert.match(src, /classifierAgent = new Agent\(\{ connections: 8/, "and a reserved one");
  assert.match(src, /classifierFetch = \(url, opts\) => undiciFetch\(url, \{ \.\.\.opts, dispatcher: classifierAgent \}\)/);
});

test("both call paths route classifier traffic to the reserved pool", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /async function callResponses\(payload, isClassifier = false\)/);
  assert.match(src, /async function callOpenAI\(payload, isClassifier = false\)/);
  assert.equal((src.match(/const f = isClassifier \? classifierFetch : fetch;/g) || []).length, 2);
  // and the handler actually passes the flag, or the pool would never be used
  assert.match(src, /callResponses\(payload, isCls\)/);
  assert.match(src, /callOpenAI\(payload, isCls\)/);
});

test("a missing undici degrades instead of breaking the proxy", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /let classifierFetch = fetch;/, "defaults to the global fetch");
  assert.match(src, /undici unavailable/, "and says so rather than failing");
});

test("turn latency is measured, not inferred from interleaved log lines", () => {
  // Two earlier attempts to answer "how slow is a turn" from this log produced confidently
  // wrong medians — 34s, then 483s — because turns overlap and the timestamps had no date.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /const turnStart = Date\.now\(\)/);
  assert.match(src, /responses stream \$\{Date\.now\(\) - turnStart\}ms/);
  assert.match(src, /function logTurnEnd\(surface, resp, toolCount, textLen, ms = null\)/);
});

// ---------- token usage, which is what the context-window indicator is computed from ----------

test("mapUsage reports input tokens, which streamed turns previously reported as 0", () => {
  assert.deepEqual(mapUsage({ input_tokens: 120000, output_tokens: 500 }, "responses"),
    { input_tokens: 120000, output_tokens: 500 });
  assert.deepEqual(mapUsage({ prompt_tokens: 900, completion_tokens: 12 }, "chat"),
    { input_tokens: 900, output_tokens: 12 });
});

test("mapUsage subtracts cached tokens, because the two APIs count them oppositely", () => {
  // OpenAI: input_tokens INCLUDES cached. Anthropic: input_tokens EXCLUDES cache_read, and the
  // client sums the two. Passing 100000 through alongside cache_read 80000 would count 180000
  // and show the context filling at nearly double the true rate.
  const u = mapUsage({ input_tokens: 100000, output_tokens: 10, input_tokens_details: { cached_tokens: 80000 } }, "responses");
  assert.deepEqual(u, { input_tokens: 20000, output_tokens: 10, cache_read_input_tokens: 80000 });
  assert.equal(u.input_tokens + u.cache_read_input_tokens, 100000, "the sum must equal the true total");

  const c = mapUsage({ prompt_tokens: 5000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4000 } }, "chat");
  assert.deepEqual(c, { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 4000 });
});

test("mapUsage omits the cache field when nothing was cached, and never goes negative", () => {
  const u = mapUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } }, "responses");
  assert.ok(!("cache_read_input_tokens" in u));
  assert.equal(
    mapUsage({ input_tokens: 5, output_tokens: 0, input_tokens_details: { cached_tokens: 9 } }, "responses").input_tokens,
    0, "a cached count above the total must not produce a negative input count");
});

test("mapUsage handles missing usage without throwing", () => {
  assert.deepEqual(mapUsage(null, "responses"), { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(mapUsage(undefined, "chat"), { input_tokens: 0, output_tokens: 0 });
});

test("every streamed message_delta reports full usage, not output_tokens alone", () => {
  // The regression this guards: the final delta used to send { output_tokens } by itself, so on a
  // streamed turn the client was never told the input size and could not compute context left.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const deltas = src.match(/sse\(res, "message_delta"[^;]*/g) || [];
  assert.ok(deltas.length >= 2, `expected both surfaces to emit message_delta, found ${deltas.length}`);
  for (const d of deltas) assert.match(d, /usage: mapUsage\(/, `message_delta must report full usage: ${d.slice(0, 80)}`);
});

// ---------- context-size logging, and spotting the client's own compaction (issue #17) ----------

// Verbatim from the bundled CLI this app actually launches — Claude Code 2.1.219 under
// user-data/claude-code/. (An earlier note here cited a standalone 2.1.217 install, which is not
// the executable Electron runs.) If the client's wording changes these stop matching, which is the
// point of pinning the real text in a test.
const COMPACT_FULL =
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.";
const COMPACT_CONTINUING =
  "Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize";
const COMPACT_PARTIAL =
  "Your task is to create a detailed summary of the RECENT portion of the conversation \u2014 the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on";

test("compactionKind recognises all three of the client's compaction prompts", () => {
  assert.equal(compactionKind({ messages: [{ role: "user", content: COMPACT_FULL }] }), "full");
  assert.equal(compactionKind({ messages: [{ role: "user", content: COMPACT_CONTINUING }] }), "continuing");
  assert.equal(compactionKind({ messages: [{ role: "user", content: COMPACT_PARTIAL }] }), "partial");
});

test("compactionKind tells the three apart rather than matching their shared opening", () => {
  // All three begin "Your task is to create a detailed summary", so a needle on that prefix would
  // label every compaction the same and make the log useless for saying WHICH path fired.
  const kinds = [COMPACT_FULL, COMPACT_CONTINUING, COMPACT_PARTIAL].map((t) =>
    compactionKind({ messages: [{ role: "user", content: [{ type: "text", text: t }] }] }));
  assert.deepEqual(kinds, ["full", "continuing", "partial"]);
  assert.equal(new Set(kinds).size, 3);
});

test("compactionKind finds the instruction in blocks and in system, and ignores ordinary turns", () => {
  assert.equal(compactionKind({ system: COMPACT_FULL, messages: [] }), "full");
  assert.equal(compactionKind({ system: [{ type: "text", text: COMPACT_PARTIAL }], messages: [] }), "partial");
  assert.equal(compactionKind({ messages: [{ role: "user", content: "summarize this file for me" }] }), null);
  assert.equal(compactionKind({}), null);
  assert.equal(compactionKind(null), null);
});

test("compactionKind only scans the tail, so a quoted prompt deep in history is not mistaken for one", () => {
  // A session that has DISCUSSED compaction (like the one that wrote this) must not have every
  // subsequent turn logged as a compaction.
  const body = {
    messages: [
      { role: "user", content: COMPACT_FULL },       // far back in history
      ...Array.from({ length: 6 }, () => ({ role: "assistant", content: "ordinary turn" })),
      { role: "user", content: "carry on" },
    ],
  };
  assert.equal(compactionKind(body), null);
});

test("requestShape measures context size and points at the biggest contributor", () => {
  const body = {
    system: "s".repeat(400),
    messages: [
      { role: "user", content: "u".repeat(100) },
      { role: "user", content: [{ type: "tool_result", content: "r".repeat(9000) }] },
      { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    ],
    tools: [{ name: "Bash", description: "d".repeat(200) }],
  };
  const shape = requestShape(body);
  assert.equal(shape.msgs, 3);
  assert.ok(shape.content >= 9500, `content should include system and all messages, got ${shape.content}`);
  assert.equal(shape.biggest, 9000, "the tool_result is the biggest single item");
  assert.equal(shape.biggestFrom, "tool_result", "and the log must say what it was");
  assert.ok(shape.toolDefs > 200, "tool definitions are measured separately");
});

test("requestShape names the tool when the biggest item is a tool_use, and survives odd shapes", () => {
  const shape = requestShape({
    messages: [{ role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { s: "x".repeat(500) } }] }],
  });
  assert.equal(shape.biggestFrom, "tool_use:Edit");
  assert.deepEqual(requestShape({}),
    { msgs: 0, system: 0, content: 0, toolDefs: 0, total: 0, tools: 0, biggest: 0, biggestFrom: "" });
  assert.equal(requestShape({ messages: [{ role: "user" }] }).total, 0, "a message with no content is 0, not a throw");
});

// The correction that made issue #17 legible: ~236 tool schemas are ~121.8k estimated tokens of
// fixed overhead present on turn one, and the old total left every one of them out. Two sessions
// compacted at record 20 on 269k and 318k real tokens while the log implied something far smaller.
test("requestShape counts the tool schemas in the total, not just the conversation", () => {
  const body = {
    system: "s".repeat(4000),
    messages: [{ role: "user", content: "u".repeat(2000) }],
    tools: Array.from({ length: 20 }, (_, i) => ({ name: `T${i}`, description: "d".repeat(1000) })),
  };
  const shape = requestShape(body);
  assert.equal(shape.system, 4000);
  assert.equal(shape.content, 6000, "system + messages, counted once each");
  assert.ok(shape.toolDefs > 20000, `schemas should dominate, got ${shape.toolDefs}`);
  assert.equal(shape.total, shape.content + shape.toolDefs, "total is content plus schemas");
  assert.equal(shape.tools, 20);
});

test("requestShape counts each part exactly once — inspecting candidates never inflates the total", () => {
  // The largest-item search walks blocks and schemas individually. If that walk contributed to the
  // aggregate, a message of N blocks would be counted twice and ~total would be fiction.
  const body = {
    system: "s".repeat(100),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "a".repeat(300) },
        { type: "tool_result", content: "b".repeat(700) },
      ],
    }],
    tools: [{ name: "One", description: "d".repeat(50) }],
  };
  const shape = requestShape(body);
  assert.equal(shape.content, 1100, "100 system + 300 text + 700 tool_result, no double count");
  assert.equal(shape.total, 1100 + shape.toolDefs);
  assert.equal(shape.biggest, 700, "the biggest single BLOCK, not the whole message");
  assert.equal(shape.biggestFrom, "tool_result");
});

test("requestShape lets the fixed system prompt win when it really is the largest single item", () => {
  // Previously impossible: system was added to the total but never compared, so a session whose
  // bulk was startup overhead reported its biggest contributor as some small ordinary message.
  const shape = requestShape({
    system: "s".repeat(50000),
    messages: [{ role: "user", content: "u".repeat(200) }],
  });
  assert.equal(shape.biggest, 50000);
  assert.equal(shape.biggestFrom, "system");
});

test("requestShape names the single largest tool schema", () => {
  const shape = requestShape({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "Small", description: "d".repeat(100) },
      { name: "Huge", description: "d".repeat(40000) },
    ],
  });
  assert.equal(shape.biggestFrom, "tool_schema:Huge");
  assert.ok(shape.biggest > 40000);
});

test("requestShape labels plain user and assistant content", () => {
  assert.equal(requestShape({ messages: [{ role: "user", content: "u".repeat(500) }] }).biggestFrom, "user");
  assert.equal(
    requestShape({ messages: [{ role: "assistant", content: [{ type: "text", text: "a".repeat(500) }] }] }).biggestFrom,
    "assistant");
});

test("contextFields marks every estimate with ~ and separates content from schemas", () => {
  const line = contextFields(requestShape({
    system: "s".repeat(4000),
    messages: [{ role: "user", content: [{ type: "tool_result", content: "r".repeat(40000) }] }],
    tools: [{ name: "Bash", description: "d".repeat(8000) }],
  }));
  assert.match(line, /msgs=1/);
  assert.match(line, /~system\+messages=11k tok|~system\+messages=11ktok/);
  assert.match(line, /~tools=~?2k?tok|~tools=2k tok|~tools=2ktok/);
  assert.match(line, /~total=/);
  assert.match(line, /biggest=~10ktok\/tool_result/);
  // No unmarked estimate may appear: every token figure here is chars/4, not a real count.
  for (const field of line.split(" ").filter((f) => /tok$/.test(f))) {
    assert.match(field, /~/, `estimate without a ~ marker: ${field}`);
  }
});

test("both surfaces log context through the one shared formatter", () => {
  // These two lines were assembled independently and had already drifted apart — one reported a
  // field the other did not. A single builder is what keeps them honest.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const sites = src.match(/log\(`\/v1\/messages \[[a-z]+\][^`]*`/g) || [];
  assert.equal(sites.length, 2, `expected exactly the responses and chat sites, found ${sites.length}`);
  for (const s of sites) {
    assert.match(s, /\$\{contextFields\(shape\)\}/, `site must use the shared formatter: ${s.slice(0, 60)}`);
    assert.ok(!/~ctx=/.test(s), "the old ~ctx field excluded tool schemas and must be gone");
  }
  const warns = src.match(/if \(compacting\) log\(compactionWarning\(/g) || [];
  assert.equal(warns.length, 2, "both surfaces must use the shared compaction warning");
});

test("the compaction warning states what each prompt family actually retains", () => {
  // "and will then discard the transcript" was true of the full path only. Saying it for all three
  // misdescribed the client to whoever reads the log.
  const shape = requestShape({ system: "s".repeat(1000), messages: [{ role: "user", content: "x" }] });
  const full = compactionWarning("full", shape, "claude-opus-4-8", "gpt-5.6-sol");
  const cont = compactionWarning("continuing", shape, "claude-opus-4-8", "gpt-5.6-sol");
  const part = compactionWarning("partial", shape, "claude-opus-4-8", "gpt-5.6-sol");
  assert.match(full, /conversation-so-far/);
  assert.match(cont, /start of a continuing session/);
  assert.match(part, /keeps earlier retained context intact/);
  assert.equal(new Set([full, cont, part]).size, 3, "the three must not read identically");
  for (const w of [full, cont, part]) assert.ok(!/discard the transcript/.test(w));
  assert.deepEqual(Object.keys(COMPACTION_EFFECT).sort(), ["continuing", "full", "partial"]);
});

test("the compaction warning reports the wire model and the full accounting", () => {
  const shape = requestShape({
    system: "s".repeat(2000),
    messages: [{ role: "user", content: "u".repeat(500) }],
    tools: [{ name: "Bash", description: "d".repeat(4000) }],
  });
  const w = compactionWarning("full", shape, "claude-opus-4-8", "gpt-5.6-sol");
  // The NORMALIZED identity: Claude Code strips its [1m] suffix before /v1/messages, so the proxy
  // sees claude-opus-4-8 and must not claim otherwise.
  assert.match(w, /claude-opus-4-8->gpt-5\.6-sol/);
  assert.ok(!/\[1m\]/.test(w.replace(/configured internal identity [^,.]*/, "")),
    "only the configured-identity field may mention a suffix");
  assert.match(w, /~system\+messages=/);
  assert.match(w, /~tools=/);
  assert.match(w, /~total=/);
});

test("the compaction warning does not claim to know the trigger or the effective window", () => {
  // Both /compact and automatic compaction send the identical prompt, and the effective window is
  // resolved inside the client from state the proxy cannot see. Overclaiming either is how the
  // earlier version sent this investigation down the wrong path.
  const w = compactionWarning("full", requestShape({ messages: [] }), "claude-opus-4-8", "gpt-5.6-sol");
  assert.match(w, /not visible in the request/);
  assert.match(w, /compactMetadata\.trigger/);
  assert.match(w, /upper bound/);
  assert.ok(!/context window is set too low/.test(w), "must not assert a cause it cannot verify");
  // And it must be distinguishable from the proxy's own overflow fallback.
  assert.match(w, /NOT the proxy's own overflow compaction/);
  assert.match(w, /CLIENT-SIDE COMPACTION/);
});

test("the token figures are marked as estimates, because the proxy has no tokenizer", () => {
  assert.equal(approxTokens(4000), 1000);
  assert.equal(kilo(9000), "9k");
  assert.equal(kilo(950), "950");
  assert.equal(kilo(1500), "1.5k");
  // Every logged estimate must be prefixed with ~ so it is never mistaken for a real count.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  for (const m of src.match(/approxTokens\([^)]*\)\)\}tok/g) || []) {
    assert.ok(true, m); // shape check below is the real assertion
  }
  assert.match(src, /~total=\$\{kilo\(approxTokens/, "the context estimate is marked with ~");
  assert.match(src, /in_tokens=\$\{inTokensField\(/, "the authoritative count is logged unmarked, from real usage");
});

test("every turn-end log line reports in_tokens, on the streaming path too", () => {
  // The streaming path has its own log site, separate from logTurnEnd(), and it was the one that
  // mattered: every real turn streams. It reported out_tokens only, so the log never showed the
  // context filling up — which is why issue #17 was invisible until it was measured by hand.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const ends = src.match(/log\(`  <- [^`]*out_tokens=[^`]*`/g) || [];
  assert.ok(ends.length >= 2, `expected at least the streaming and non-streaming sites, found ${ends.length}`);
  for (const e of ends) assert.match(e, /in_tokens=/, `turn-end log without in_tokens: ${e.slice(0, 80)}`);
});

// ---------- prompt-cache routing and hint stability ----------

test("the format hint does not depend on tool ORDER", () => {
  // The hint goes into `instructions`, which sits in the cached prefix. Picking "first
  // match in the array" made a harmless reordering rewrite the prefix.
  const a = [{ name: "Artifact" }, { name: "mcp__visualize__show_widget" }, { name: "Write" }];
  const b = [{ name: "mcp__visualize__show_widget" }, { name: "Write" }, { name: "Artifact" }];
  assert.equal(buildFormatHint(a), buildFormatHint(b), "reordering tools must not change the hint");
  assert.equal(findRenderTool(a), findRenderTool(b));
  assert.equal(findWriteTool(a), findWriteTool(b));
});

test("background tool names are interpolated in a stable order", () => {
  const one = findBgTools([{ name: "TaskOutput" }, { name: "BashOutput" }, { name: "TaskList" }]);
  const two = findBgTools([{ name: "TaskList" }, { name: "TaskOutput" }, { name: "BashOutput" }]);
  assert.deepEqual(one, two);
  assert.deepEqual(one, [...one].sort(), "must be sorted, not array order");
});

test("the render-tool pattern is anchored, so an unrelated tool cannot hijack the hint", () => {
  // Unanchored, /canvas|artifact/ matched slack_create_canvas — so merely connecting Slack
  // changed which branch of the hint fired.
  assert.equal(findRenderTool([{ name: "slack_create_canvas" }]), null);
  assert.equal(findRenderTool([{ name: "mcp__visualize__show_widget" }]), "mcp__visualize__show_widget");
  assert.equal(findRenderTool([{ name: "Artifact" }]), "Artifact");
});

test("cacheKeyFor is stable across a conversation and distinct between conversations", () => {
  const sys = "You are Claude Code, in /repo/one";
  const first = { role: "user", content: "start the task" };
  const turn1 = { system: sys, messages: [first] };
  const turn2 = { system: sys, messages: [first, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] };
  assert.equal(cacheKeyFor(turn1), cacheKeyFor(turn2), "later turns of one session must key the same");

  const other = { system: "You are Claude Code, in /repo/two", messages: [first] };
  assert.notEqual(cacheKeyFor(turn1), cacheKeyFor(other), "different sessions must not collide");
});

test("cacheKeyFor ignores the tool list, which legitimately changes mid-session", () => {
  const base = { system: "s", messages: [{ role: "user", content: "hi" }] };
  const withTools = { ...base, tools: [{ name: "Read" }, { name: "Write" }] };
  assert.equal(cacheKeyFor(base), cacheKeyFor(withTools),
    "re-keying on tools would split one conversation across two cache buckets");
});

test("cacheKeyFor reads block content and degrades to null with nothing stable", () => {
  const blocks = { system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
  const plain = { system: "sys", messages: [{ role: "user", content: "hello" }] };
  assert.equal(cacheKeyFor(blocks), cacheKeyFor(plain), "block and string forms must agree");
  assert.equal(cacheKeyFor({}), null);
  assert.equal(cacheKeyFor({ messages: [] }), null);
  assert.match(cacheKeyFor(plain), /^[0-9a-f]{32}$/);
});

test("both surfaces send prompt_cache_key, and it survives an unrelated payload change", () => {
  const body = { model: "claude-opus-4-8", system: "s", max_tokens: 100,
                 messages: [{ role: "user", content: "hi" }] };
  const r = toResponses(body, "gpt-5.6-sol", false);
  const c = toOpenAI(body, "gpt-4.1-mini", false);
  const key = cacheKeyFor(body);
  assert.equal(r.payload.prompt_cache_key, key);
  assert.equal(c.payload.prompt_cache_key, key);

  // A mid-session tool change must not move the conversation to a different bucket.
  const later = { ...body, tools: [{ name: "Read", input_schema: { type: "object" } }] };
  assert.equal(toResponses(later, "gpt-5.6-sol", false).payload.prompt_cache_key, key);
});

// ---------- cache-aware usage accounting (#20) and miss visibility (#21) ----------

test("the usage ledger separates cache reads from fresh input", () => {
  // input_tokens follows OpenAI's convention and INCLUDES cache reads, so on its own it
  // overstated billable input by ~25x at the measured 96% hit rate.
  const model = `test-ledger-${Math.random().toString(36).slice(2)}`;
  const before = usageSummary().total;
  recordUsage(model, 100000, 500, 200, 96000);
  recordUsage(model, 100000, 500, 200, 96000);
  const s = usageSummary();
  const m = s.by_model[model];
  assert.equal(m.requests, 2);
  assert.equal(m.input_tokens, 200000, "gross input, cache reads included");
  assert.equal(m.cached_input_tokens, 192000);
  // Assert on the DELTA, not the absolute: usageSummary() aggregates a ledger that persists
  // across runs, so a real proxy's history would otherwise decide whether this passes.
  assert.equal(s.total.cached_input_tokens - before.cached_input_tokens, 192000);
  assert.equal(s.total.uncached_input_tokens - before.uncached_input_tokens, 8000,
    "the fresh part is what actually gets billed at full rate");
  assert.ok(s.total.cache_hit_rate_pct >= 0 && s.total.cache_hit_rate_pct <= 100);
  // The note must state which convention input_tokens follows, since it is the opposite of
  // the Anthropic-facing number this same proxy returns to the client.
  assert.match(s.note, /INCLUDES cache reads/);
});

test("a ledger written before cached_input_tokens existed still accumulates", () => {
  // usage.json persists across restarts; an old file has no such key.
  const model = `test-legacy-${Math.random().toString(36).slice(2)}`;
  recordUsage(model, 10, 1, 0, 0);
  const s1 = usageSummary();
  delete s1.by_model[model].cached_input_tokens;      // simulate the old shape
  recordUsage(model, 10, 1, 0, 4);
  assert.equal(usageSummary().by_model[model].cached_input_tokens, 4, "must not become NaN");
});

test("recordUsage ignores a missing model rather than creating a junk bucket", () => {
  const before = Object.keys(usageSummary().by_model).length;
  recordUsage(null, 100, 10);
  recordUsage(undefined, 100, 10);
  assert.equal(Object.keys(usageSummary().by_model).length, before);
});

test("a zero-cache turn prints (0 cached) rather than nothing at all", () => {
  // The worst case used to render identically to a turn with no cache reporting, so a
  // `\((\d+) cached\)` scan of the log skipped 361 turns and 47.7M tokens.
  assert.equal(inTokensField({ input_tokens: 252372, input_tokens_details: { cached_tokens: 0 } }),
    "252372 (0 cached)");
  assert.equal(inTokensField({ input_tokens: 252372 }), "252372 (0 cached)");
  assert.equal(inTokensField({ input_tokens: 100, input_tokens_details: { cached_tokens: 90 } }),
    "100 (90 cached)");
  assert.equal(inTokensField({}), "?", "an absent count stays unknown, not zero");
  assert.equal(inTokensField(null), "?");
});

test("both turn-end sites format in_tokens through the one helper", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const ends = src.match(/log\(`  <- [^`]*out_tokens=[^`]*`/g) || [];
  assert.ok(ends.length >= 2, `expected the streaming and non-streaming sites, found ${ends.length}`);
  for (const e of ends) {
    assert.match(e, /in_tokens=\$\{inTokensField\(/, `site must use the helper: ${e.slice(0, 60)}`);
  }
  // The old inline ternary suppressed the field at zero; it must not come back.
  assert.ok(!/cached_tokens \? ` \(\$\{/.test(src), "no site may suppress the cached field at zero");
});

test("a large poorly-cached turn warns, and an ordinary one does not", () => {
  const miss = cacheWarning({ input_tokens: 252372, input_tokens_details: { cached_tokens: 0 } });
  assert.match(miss, /CACHE MISS/);
  assert.match(miss, /252372 input tokens, 0 from cache \(0%\)/);
  // Must not assert a bug: a first turn legitimately misses.
  assert.match(miss, /first turn of a conversation/);

  assert.equal(cacheWarning({ input_tokens: 145768, input_tokens_details: { cached_tokens: 140000 } }), null,
    "a well-cached turn is not noteworthy");
  assert.equal(cacheWarning({ input_tokens: 500, input_tokens_details: { cached_tokens: 0 } }), null,
    "a small turn has nothing to reuse");
  assert.equal(cacheWarning({}), null);
  assert.equal(cacheWarning(null), null);
});

test("the compaction summariser records its own upstream call", () => {
  // It fires a real request on the account's key and was the one path the ledger never saw,
  // while the README claimed all four were counted.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function summariseDropped"), src.indexOf("async function compactResponsesInputSummarised"));
  assert.match(fn, /recordUsage\(COMPACT_MODEL/, "summariseDropped must record its own usage");
});

test("every recordUsage call site passes the cached figure and the resolved model", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  // Require a real first argument, so the function's own definition and any prose mentioning
  // `recordUsage()` are not counted as call sites.
  const calls = [...src.matchAll(/recordUsage\([A-Za-z][\w?.]*,[^;]*?\);/gs)].map((m) => m[0]);
  assert.ok(calls.length >= 5, `expected at least five call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /cached_tokens/, `call site must pass the cached split: ${c.slice(0, 70)}`);
  }
  // reqModel is the CLIENT's id (claude-opus-4-8); the ledger is keyed on the OpenAI model.
  assert.ok(!/recordUsage\(reqModel\b/.test(src),
    "usage must not be filed under the client-requested model");
});

// ---------- transport-error retry ----------
//
// 97 turns in the log ended as "stream error: terminated" and none was retried, because the four
// retry loops in streamResponses all veto on `streamError`. That guard is right for an upstream
// REFUSAL and wrong for a dropped socket, so transport failures now get their own bounded retry.

test("classifies a dropped socket as transport, and an API refusal as not", () => {
  // Exactly the shape undici throws: TypeError("terminated") wrapping UND_ERR_SOCKET.
  const dropped = new TypeError("terminated");
  dropped.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  assert.equal(isTransportError(dropped), true);

  for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_BODY_TIMEOUT"]) {
    assert.equal(isTransportError(Object.assign(new Error("x"), { code })), true, code);
  }
  // Nested one level deeper — fetch wraps the socket error in its own cause chain.
  const nested = new TypeError("fetch failed");
  nested.cause = { message: "terminated", cause: { code: "UND_ERR_SOCKET" } };
  assert.equal(isTransportError(nested), true);

  // Things that must NOT be retried: they are answers, not transport faults.
  assert.equal(isTransportError(new Error("Your input exceeds the context window of this model")), false);
  assert.equal(isTransportError(new Error("insufficient_quota")), false);
  assert.equal(isTransportError(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(isTransportError(null), false);
  // "terminated" must match the whole message, so prose mentioning it is not swept in.
  assert.equal(isTransportError(new Error("the run was terminated by policy")), false);
});

test("the transport retry is bounded and stops once output has been emitted", () => {
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.ok(MAX_TRANSPORT_RETRIES >= 1 && MAX_TRANSPORT_RETRIES <= 5,
    `unreasonable bound: ${MAX_TRANSPORT_RETRIES}`);
  // Retrying after content is already on the wire would renumber the client's content blocks,
  // so the guard must exist and must be checked before any retry.
  assert.match(src, /emittedAnything\s*=\s*\(\)\s*=>/, "needs an emitted-output guard");
  assert.match(src, /if \(emittedAnything\(\)\)[\s\S]{0,220}keeping the partial turn/,
    "must keep the partial turn instead of restarting it");
  assert.match(src, /if \(!isTransportError\(e\)\) throw e/,
    "a non-transport error must propagate unchanged");
});
