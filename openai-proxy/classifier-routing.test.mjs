// Classifier routing: which route, which model, and what that route is allowed to do.
//   node --test openai-proxy/classifier-routing.test.mjs
//
// This is the safety-critical path. Claude Code asks the proxy whether a risky action is allowed,
// gives the answer a 60-second budget, and DENIES the action if no parseable verdict arrives. So
// every failure here has the same two shapes: a verdict rendered by the wrong model, or no verdict
// at all. Both are covered below, and both used to be reachable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {
  ROUTE, routeFor, policyFor, modelForRoute, routeLabel, isClassifier, isSafety,
  SAFETY_NEEDLES, PREFIX_NEEDLES, SEVERITY_NEEDLES, BLOCK_NEEDLES,
} from "./routes.mjs";

// Built from the module's own needles rather than retyped, so a needle change cannot leave these
// tests quietly asserting against text the detector no longer looks for.
const STAGE2_OPENER = "You are a security monitor for autonomous AI coding agents.";
const STAGE2_CONTRACT = "Your ENTIRE response MUST begin with <block>.";
const STAGE1_CONTRACT = "Respond with <severity>N</severity> ONLY.";
const PREFIX_SYS = "You are analysing risk levels for actions that the Claude Code agent may take.";

// ---------- route detection ----------

test("a stage-2 safety prompt routes to the block stage", () => {
  const r = routeFor({ systemText: `${STAGE2_OPENER}\n${STAGE2_CONTRACT}`, tailText: "run: rm -rf /" });
  assert.equal(r, ROUTE.SAFETY_BLOCK);
  assert.equal(isSafety(r), true);
  assert.equal(isClassifier(r), true);
});

test("a stage-1 safety prompt routes to the severity stage", () => {
  const r = routeFor({ systemText: `Review the classification process. ${STAGE1_CONTRACT}`, tailText: "" });
  assert.equal(r, ROUTE.SAFETY_SEVERITY);
  assert.equal(isSafety(r), true);
});

test("a severity needle in the TRANSCRIPT does not turn a stage-2 prompt into stage 1", () => {
  // THE REASON THE STAGE CHECK IS SYSTEM-ANCHORED. All 13 real classifier prompts recovered from
  // the CLI's error dumps are stage 2, and three of them contain `<severity>N</severity>` at
  // fractions 0.21, 0.89 and 0.91 of the request — inside the USER transcript, where the
  // conversation happens to quote an earlier stage-1 exchange. Concatenating system and tail
  // before matching would label those three stage 1.
  const r = routeFor({
    systemText: `${STAGE2_OPENER}\n${STAGE2_CONTRACT}`,
    tailText: `earlier the assistant was asked to answer ${STAGE1_CONTRACT} and said <severity>3</severity>`,
  });
  assert.equal(r, ROUTE.SAFETY_BLOCK, "the system prompt decides the stage; the transcript cannot");
});

test("a safety prompt recognised only from the transcript is treated as the strict stage", () => {
  // Family matched on the tail, no stage evidence in the system text. Stage 2 is the conservative
  // label: it is the stage that can block, so an unknown safety call keeps the strictest handling.
  const r = routeFor({ systemText: "you are a helpful assistant", tailText: "Err on the side of blocking" });
  assert.equal(r, ROUTE.SAFETY_BLOCK);
});

test("a prefix-detection prompt routes to prefix, not safety", () => {
  const r = routeFor({ systemText: PREFIX_SYS, tailText: "git status" });
  assert.equal(r, ROUTE.PREFIX);
  assert.equal(isSafety(r), false, "prefix detection is low-stakes and must not use the safety model");
  assert.equal(isClassifier(r), true);
});

test("an ordinary agent turn is the main route", () => {
  const r = routeFor({ systemText: "You are Claude Code.", tailText: "fix the failing test", toolCount: 236 });
  assert.equal(r, ROUTE.MAIN);
  assert.equal(isClassifier(r), false);
});

test("a prompt that merely QUOTES the contract while carrying tools is an agent turn", () => {
  // Otherwise a session debugging this very file has its own turns misrouted: hints stripped,
  // tools removed, and the answer routed to a small classifier model.
  const vetoed = [];
  const r = routeFor({
    systemText: `${STAGE2_OPENER}\n${STAGE2_CONTRACT}`, tailText: "why does this match?",
    toolCount: 236, maxTools: 4, onVeto: (fam, n) => vetoed.push([fam, n]),
  });
  assert.equal(r, ROUTE.MAIN);
  assert.deepEqual(vetoed, [["safety", 236]], "and the veto is reported, not silent");
});

test("the tool-count veto is a threshold, not a cliff at zero", () => {
  const sys = `${STAGE2_OPENER}\n${STAGE2_CONTRACT}`;
  assert.equal(routeFor({ systemText: sys, toolCount: 4, maxTools: 4 }), ROUTE.SAFETY_BLOCK);
  assert.equal(routeFor({ systemText: sys, toolCount: 5, maxTools: 4 }), ROUTE.MAIN);
  assert.equal(routeFor({ systemText: sys, toolCount: 0, maxTools: 0 }), ROUTE.SAFETY_BLOCK);
});

test("a client compaction request is its own route", () => {
  const r = routeFor({ systemText: "summarise the conversation", tailText: "", isCompaction: true });
  assert.equal(r, ROUTE.COMPACTION);
  assert.equal(isClassifier(r), false);
  // Behaviour deliberately identical to MAIN for now: changing how a transcript is summarised is a
  // fact-retention question, which belongs to the phase that owns compaction.
  assert.deepEqual(policyFor(ROUTE.COMPACTION), policyFor(ROUTE.MAIN));
});

// ---------- policy ----------

test("no classifier route may have tools, hints, reasoning, continuation or compaction", () => {
  for (const r of [ROUTE.PREFIX, ROUTE.SAFETY_SEVERITY, ROUTE.SAFETY_BLOCK]) {
    const p = policyFor(r);
    assert.equal(p.tools, false, `${r} must not be offered tools`);
    assert.equal(p.hints, false, `${r} must not have agent hints injected into its prompt`);
    assert.equal(p.reasoning, false, `${r} must not spend its output budget on reasoning`);
    assert.equal(p.verbosity, false, `${r} has a fixed output shape and wants no padding`);
    assert.equal(p.continuation, false, `${r} is one turn; continuing it would re-ask the model`);
    assert.equal(p.compactOnOverflow, false, `${r} must never be judged on a shortened transcript`);
    assert.equal(p.reservedPool, true, `${r} needs the reserved pool to make the CLI's deadline`);
    assert.equal(p.failClosed, true, `${r} must fail closed`);
  }
});

test("an agent turn keeps every capability a classifier gives up", () => {
  const p = policyFor(ROUTE.MAIN);
  for (const k of ["tools", "hints", "reasoning", "verbosity", "continuation", "compactOnOverflow"])
    assert.equal(p[k], true, `an agent turn needs ${k}`);
  assert.equal(p.reservedPool, false, "the reserved pool exists so agent traffic cannot crowd it out");
});

test("an unknown route falls back to agent behaviour, not to classifier behaviour", () => {
  // Failing the other way would silently strip tools from a new route, and a tool-less agent turn
  // looks exactly like a model that chose not to act.
  const p = policyFor("some-future-route");
  assert.equal(p.tools, true);
  assert.equal(p.reservedPool, false);
});

test("every route has a label, and the two safety stages are distinguishable in a log", () => {
  assert.equal(routeLabel(ROUTE.PREFIX), "classifier=prefix");
  assert.equal(routeLabel(ROUTE.SAFETY_SEVERITY), "classifier=safety:severity");
  assert.equal(routeLabel(ROUTE.SAFETY_BLOCK), "classifier=safety:block");
  assert.equal(routeLabel(ROUTE.COMPACTION), "route=compaction");
  assert.equal(routeLabel(ROUTE.MAIN), "", "an agent turn is the default and needs no label");
  // The field this replaces was `classifier=yes`, which could not tell a prefix detection from a
  // safety verdict — and 47k log lines of it are the reason the two families were conflated.
  const labels = new Set([ROUTE.PREFIX, ROUTE.SAFETY_SEVERITY, ROUTE.SAFETY_BLOCK].map(routeLabel));
  assert.equal(labels.size, 3, "each classifier route must be separately identifiable");
});

// ---------- the real corpus ----------

test("the real classifier prompts all route to a safety stage", (t) => {
  // Ground truth: the prompts the CLI itself dumped when a verdict failed. Not committed — they
  // are real transcripts — so this checks them when they are present and says so when they are
  // not, rather than passing silently on a machine that has none.
  const DIR = "/private/tmp/claude-501/auto-mode-classifier-errors";
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith(".txt")); } catch { /* absent */ }
  if (!files.length) return t.skip(`no dumps in ${DIR}; nothing to check against`);

  const SNIFF = 4000;
  const ends = (s) => (s.length <= SNIFF * 2 ? s : `${s.slice(0, SNIFF)}\n${s.slice(-SNIFF)}`);
  const seen = { [ROUTE.SAFETY_BLOCK]: 0, [ROUTE.SAFETY_SEVERITY]: 0, [ROUTE.PREFIX]: 0, [ROUTE.MAIN]: 0 };
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), "utf8");
    // The dumps mark their sections; the system prompt and the transcript are separate, which is
    // exactly the split the router needs.
    const sysAt = raw.indexOf("=== SYSTEM PROMPT ===");
    const usrAt = raw.indexOf("=== USER PROMPT");
    const systemText = ends(sysAt >= 0 ? raw.slice(sysAt, usrAt > sysAt ? usrAt : undefined) : "");
    const tailText = ends(usrAt >= 0 ? raw.slice(usrAt) : raw);
    const r = routeFor({ systemText, tailText, toolCount: 0 });
    seen[r] = (seen[r] || 0) + 1;
    assert.ok(isSafety(r), `${f} routed to ${r}, expected a safety stage`);
  }
  // Every one is stage 2 — which is why a behavioural stage split is not yet justified: there is
  // no stage-1 corpus to validate one against.
  assert.equal(seen[ROUTE.SAFETY_SEVERITY], 0,
    "no real stage-1 prompt exists in the corpus; a stage split cannot be validated yet");
  assert.equal(seen[ROUTE.SAFETY_BLOCK], files.length);
  assert.equal(seen[ROUTE.MAIN], 0, "not one real verdict may be mistaken for an agent turn");
});

test("both safety stages resolve to the same model and policy", () => {
  // Because the stage split is diagnostic only, a mislabel must not be able to change behaviour.
  // That is what makes labelling them safe without a stage-1 corpus.
  const cfg = { main: "MAIN", prefixModel: "PFX", safetyModel: "SAFE" };
  assert.equal(modelForRoute(ROUTE.SAFETY_SEVERITY, cfg), modelForRoute(ROUTE.SAFETY_BLOCK, cfg));
  assert.deepEqual(policyFor(ROUTE.SAFETY_SEVERITY), policyFor(ROUTE.SAFETY_BLOCK));
});

test("startup and /health name BOTH classifier models", () => {
  // The safety model decides whether a risky action is allowed to run, and it did not appear in
  // the startup log at all — the single most consequential routing decision the proxy makes was
  // invisible in its own diagnostics. Reconstructing it afterwards meant re-deriving the config.
  const src = fs.readFileSync(new URL("./proxy.mjs", import.meta.url), "utf8");
  assert.match(src, /classifier routing: prefix=/);
  assert.match(src, /safety=\$\{OPENAI_CLASSIFIER_SAFETY_MODEL/);
  assert.match(src, /compaction=\$\{COMPACT_MODEL\}/);
  // A blank safety model must report the model that will actually judge, not `null` — which reads
  // as "unset" and hides the answer.
  assert.match(src, /safety_model_source/);
  assert.ok(!/safety_model: OPENAI_CLASSIFIER_SAFETY_MODEL \|\| null/.test(src),
    "blank must not be reported as null now that blank is a real choice");
});

// ---------- end to end ----------

process.env.PROXY_NO_LISTEN = "1";
process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_API = "responses";

let handler = () => {};
const upstream = http.createServer((req, res) => handler(req, res));
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
const { server } = await import("./proxy.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstream.close(); });

// Records what the proxy actually sent upstream, then answers with a verdict.
function recorder(bodies, reply) {
  return (req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      try { bodies.push(JSON.parse(raw || "{}")); } catch { bodies.push({ unparseable: raw }); }
      reply(res, bodies.length);
    });
  };
}
const verdict = (res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: "r", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "<block>no</block>" }] }],
    usage: { input_tokens: 10, output_tokens: 4 },
  }));
};
const askProxy = (body) => fetch(`${base}/v1/messages`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, text: await r.text() }));

const SAFETY_BODY = (extra = {}) => ({
  model: "claude-sonnet-5", max_tokens: 64, stream: false,
  system: `${STAGE2_OPENER}\n${STAGE2_CONTRACT}`,
  messages: [{ role: "user", content: "The agent wants to run: rm -rf /tmp/x" }],
  ...extra,
});

test("a safety verdict is sent with no tools and no tool_choice", async () => {
  // Neither encoder gated its tools block on the route, so a verdict carrying up to
  // OPENAI_CLASSIFIER_MAX_TOOLS (4) tools sent them upstream along with tool_choice. A verdict has
  // a rigid output contract; offering a tool invites a tool call INSTEAD of the verdict, which is
  // unparseable, which makes the CLI retry and then deny the action.
  const bodies = [];
  handler = recorder(bodies, verdict);
  const r = await askProxy(SAFETY_BODY({
    tools: [{ name: "Bash", input_schema: { type: "object", properties: {} } },
             { name: "Read", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "any" },
  }));
  assert.equal(r.status, 200);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tools, undefined, "a classifier must be offered no tools");
  assert.equal(bodies[0].tool_choice, undefined, "and no tool_choice");
  // The other classifier policies, on the same request.
  assert.equal(bodies[0].reasoning, undefined, "reasoning shares the output budget with the verdict");
  assert.equal(bodies[0].text?.verbosity, undefined, "a verdict has a fixed shape and wants no padding");
  assert.ok(!/render|widget|artifact|persistence/i.test(bodies[0].instructions || ""),
    "no agent hints may be appended to a prompt that forbids preamble");
});

test("an agent turn on the same wire still gets its tools", async () => {
  // The control: the restriction has to be route-scoped, not a blanket change.
  const bodies = [];
  handler = recorder(bodies, verdict);
  await askProxy({
    model: "claude-opus-4-8", max_tokens: 64, stream: false,
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "list the files" }],
    tools: [{ name: "Bash", input_schema: { type: "object", properties: {} } }],
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tools?.length, 1, "an agent turn keeps its tools");
});

test("a safety verdict that overflows the context fails closed on both surfaces", async () => {
  // The two paths disagreed. The streaming path refused to compact (it gates on allowContinue,
  // false for classifiers), while callResponses/callOpenAI compacted regardless — so an HTTP-path
  // overflow shortened the transcript and re-asked, rendering a verdict on evidence the proxy had
  // just discarded, with the dangerous part possibly among what was trimmed.
  for (const api of ["responses", "chat"]) {
    const bodies = [];
    handler = recorder(bodies, (res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: {
        message: "Your input exceeds the context window of this model. Please adjust your input.",
      } }));
    });
    const r = await askProxy(SAFETY_BODY({ model: api === "chat" ? "gpt-nonexistent-chat" : "claude-sonnet-5" }));
    assert.ok(r.status >= 400, `[${api}] the verdict must fail, not degrade (got ${r.status})`);
    assert.equal(bodies.length, 1,
      `[${api}] exactly one attempt: a shortened transcript must never be re-submitted, saw ${bodies.length}`);
  }
});

test("an agent turn that overflows is still compacted and retried", async () => {
  // The control again: failing closed is a CLASSIFIER rule. An agent turn overflowing is the case
  // the compaction ladder exists for, and breaking it would make long sessions unusable.
  const bodies = [];
  let n = 0;
  handler = recorder(bodies, (res) => {
    if (++n === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: {
        message: "Your input exceeds the context window of this model. Please adjust your input.",
      } }));
      return;
    }
    verdict(res);
  });
  // The compaction ladder trims TOOL RESULTS, keeping the last N items, and its first rung keeps
  // 96. A four-message fixture therefore has nothing to trim and the ladder correctly gives up —
  // which is what a smaller version of this test proved, misleadingly, about the wrong thing.
  // 60 call/result pairs is 120+ items, comfortably past the first rung.
  const messages = [{ role: "user", content: "do the thing" }];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { n: i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `output ${i} `.repeat(40) }] });
  }
  messages.push({ role: "user", content: "and now continue" });
  await askProxy({
    model: "claude-opus-4-8", max_tokens: 64, stream: false,
    system: "You are Claude Code.", messages,
  });
  assert.ok(bodies.length >= 2,
    `an agent turn must be compacted and retried, saw ${bodies.length} attempt(s)`);
});
