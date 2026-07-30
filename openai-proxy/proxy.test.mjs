// Unit tests for the proxy's output shaping and tool selection.
//   node --test openai-proxy/proxy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.PROXY_NO_LISTEN = "1";
const { makeMathFixer, fixMath, selectTools, isEssentialTool, buildFormatHint, findWriteTool } =
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

test("hint falls back to a fenced svg block when no write tool is available", () => {
  const h = buildFormatHint([{ name: "Read" }, { name: "Bash" }]);
  assert.match(h, /```svg/);
  assert.ok(!/MUST call/.test(h), "must not order a tool call that isn't available");
  assert.match(h, /Do NOT instruct the user to save/i);
});
