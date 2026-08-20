import { test } from "node:test";
import assert from "node:assert/strict";
import { planModeActive, dropRedundantPlanTool } from "./planmode.mjs";

const TOOLS = () => [
  { name: "Bash" },
  { name: "EnterPlanMode" },
  { name: "ExitPlanMode" },
  { name: "Read" },
];
const names = (body) => body.tools.map((t) => t.name);
const enter = { role: "assistant", content: [{ type: "tool_use", name: "EnterPlanMode", input: {} }] };
const exit = { role: "assistant", content: [{ type: "tool_use", name: "ExitPlanMode", input: {} }] };
const REMINDER = "<system-reminder>Plan mode is active. The user indicated that they do not want you to execute yet.</system-reminder>";

test("model-initiated: EnterPlanMode with no later ExitPlanMode is active -> tool dropped", () => {
  const body = { tools: TOOLS(), messages: [{ role: "user", content: "do it" }, enter] };
  assert.equal(planModeActive(body), true);
  dropRedundantPlanTool(body);
  assert.deepEqual(names(body), ["Bash", "ExitPlanMode", "Read"]);
});

test("ExitPlanMode after EnterPlanMode is NOT active -> EnterPlanMode kept", () => {
  const body = { tools: TOOLS(), messages: [{ role: "user", content: "do it" }, enter, exit] };
  assert.equal(planModeActive(body), false);
  dropRedundantPlanTool(body);
  assert.ok(names(body).includes("EnterPlanMode"));
});

test("no plan context -> EnterPlanMode kept", () => {
  const body = { tools: TOOLS(), messages: [{ role: "user", content: "hi" }] };
  assert.equal(planModeActive(body), false);
  dropRedundantPlanTool(body);
  assert.ok(names(body).includes("EnterPlanMode"));
});

test("user-initiated: persistent reminder in last user message is active -> tool dropped", () => {
  const body = {
    tools: TOOLS(),
    messages: [{ role: "user", content: [{ type: "text", text: "build a scraper\n" + REMINDER }] }],
  };
  assert.equal(planModeActive(body), true);
  dropRedundantPlanTool(body);
  assert.ok(!names(body).includes("EnterPlanMode"));
});

test("reminder in system field (array form) is detected", () => {
  const body = {
    tools: TOOLS(),
    system: [{ type: "text", text: "You are Claude." }, { type: "text", text: REMINDER }],
    messages: [{ role: "user", content: "go" }],
  };
  assert.equal(planModeActive(body), true);
});

test("false-positive guard: reminder-ish text ONLY in a tool description does not trigger", () => {
  const body = {
    tools: [
      { name: "Bash" },
      { name: "EnterPlanMode", description: "Plan mode is active while planning; the user may not want you to execute yet." },
    ],
    messages: [{ role: "user", content: "hi" }],
  };
  // body.tools is never scanned, so the description can't flip detection.
  assert.equal(planModeActive(body), false);
  dropRedundantPlanTool(body);
  assert.ok(names(body).includes("EnterPlanMode"));
});

test("false-positive guard: only ONE of the two required substrings is not enough", () => {
  const body = {
    tools: TOOLS(),
    messages: [{ role: "user", content: "Plan mode is active somewhere but nothing else here." }],
  };
  assert.equal(planModeActive(body), false);
});

test("ExitPlanMode is always preserved when in plan mode", () => {
  const body = { tools: TOOLS(), messages: [enter] };
  dropRedundantPlanTool(body);
  assert.ok(names(body).includes("ExitPlanMode"));
});

test("idempotent and safe on odd inputs", () => {
  const body = { tools: TOOLS(), messages: [enter] };
  dropRedundantPlanTool(body);
  dropRedundantPlanTool(body); // second call is a no-op, no throw
  assert.ok(!names(body).includes("EnterPlanMode"));
  // missing tools / messages must not throw
  assert.doesNotThrow(() => dropRedundantPlanTool({}));
  assert.doesNotThrow(() => dropRedundantPlanTool({ tools: [{ name: "EnterPlanMode" }] }));
  assert.equal(planModeActive({}), false);
});

test("logs once when it drops the tool", () => {
  const body = { tools: TOOLS(), messages: [enter] };
  const lines = [];
  dropRedundantPlanTool(body, { log: (m) => lines.push(m) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /withholding EnterPlanMode/);
});
