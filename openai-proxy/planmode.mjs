// Withhold EnterPlanMode once a session is already in plan mode.
//
// Claude Code keeps `EnterPlanMode` in the offered tool list on EVERY turn, including turns where the
// session is already in plan mode. A model that doesn't reliably track its own mode state — small
// local models especially — then calls EnterPlanMode again, re-entering a mode it is already in and
// looping on "start planning" instead of actually planning. (Observed: gemma4 entered plan mode, ran a
// research sub-agent, then called EnterPlanMode a second time and stalled without ever producing a
// result.) The CLI is bundled and cannot be patched, so the proxy drops EnterPlanMode from the tools
// whenever the incoming request is already in plan mode — re-entry becomes impossible. ExitPlanMode is
// deliberately left in place: exiting is the correct next move, and a model can't get stuck on it.

const PLAN_ENTER = "EnterPlanMode";
const PLAN_EXIT = "ExitPlanMode";

// Flatten an Anthropic `system` field (string | {type,text}[]) to a string.
function systemText(body) {
  const s = body?.system;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
  return "";
}

// Text of the last user message — where the CLI appends its <system-reminder> blocks.
function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
    return "";
  }
  return "";
}

// Signal 1 — model-initiated. Walk assistant tool_use blocks in order; the session is in plan mode if
// the most recent plan toggle was EnterPlanMode (entered and not yet exited). Keys on tool NAMES, so it
// is stable across prompt/wording changes and covers the exact loop seen in the wild.
function planModeFromToolUse(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let inPlan = false;
  for (const m of msgs) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_use") continue;
      if (b.name === PLAN_ENTER) inPlan = true;
      else if (b.name === PLAN_EXIT) inPlan = false;
    }
  }
  return inPlan;
}

// Signal 2 — user-initiated (the user toggled plan mode, so there is no EnterPlanMode tool_use). The
// CLI injects a persistent reminder; require BOTH substrings so a documentation mention alone cannot
// trigger it. Scans only system + the last user turn — never body.tools — so EnterPlanMode's own schema
// description can never match.
function planModeFromReminder(body) {
  const t = (systemText(body) + "\n" + lastUserText(body)).toLowerCase();
  return t.includes("plan mode is active") && t.includes("do not want you to execute");
}

export function planModeActive(body) {
  return planModeFromToolUse(body) || planModeFromReminder(body);
}

// If the request is already in plan mode, withhold EnterPlanMode so the model cannot re-enter and loop.
// Idempotent; no-op when not in plan mode or when the tool is not offered. Mutates and returns body.
export function dropRedundantPlanTool(body, { log = () => {} } = {}) {
  if (!Array.isArray(body?.tools)) return body;
  if (!body.tools.some((t) => t?.name === PLAN_ENTER)) return body;
  if (!planModeActive(body)) return body;
  body.tools = body.tools.filter((t) => t?.name !== PLAN_ENTER);
  log(`  plan mode active — withholding ${PLAN_ENTER} (prevents re-entry loop)`);
  return body;
}
