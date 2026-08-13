// The frozen baseline, checked on every run of the suite.
//   node --test eval/baseline.test.mjs
//
// This is the guard that makes the later phases reviewable. They change tool exposure, effort,
// continuity, compaction and model defaults — each of which can only be stated as a difference from
// what came before, so the "before" has to be captured and then defended. A baseline nobody checks
// is a file; a baseline the suite checks is a constraint.
//
// A difference here is NOT automatically a failure of the code. It is a change that has to be
// explained and then re-frozen deliberately, in its own commit. What it prevents is a behaviour
// change arriving unnoticed inside a commit about something else.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, diff } from "./harness.mjs";
import { CASES, SLICES } from "./corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "baseline.json");

const frozen = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const results = await run();

test("the corpus still behaves exactly as the frozen baseline recorded", () => {
  const changes = diff(frozen.results, results);
  const readable = changes.map((c) => c.kind
    ? `  ${c.id}: ${c.kind}`
    : `  ${c.id}: ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join("\n");
  assert.deepEqual(changes, [],
    `behaviour changed against eval/baseline.json:\n${readable}\n\n` +
    `If this is intended, run \`node eval/report.mjs --freeze\` in its own commit and say why.`);
});

test("every case reached the upstream and was observed", () => {
  // A case that silently stopped reaching the proxy would freeze as "no observation" and then agree
  // with itself forever, which is worse than a missing case.
  for (const r of results) {
    assert.equal(r.status, 200, `${r.id} returned ${r.status}${r.error ? `: ${r.error}` : ""}`);
    assert.ok(r.observed, `${r.id} produced no upstream payload to observe`);
    assert.ok(r.observed.model, `${r.id} recorded no resolved model`);
  }
});

// ---------- the invariants the baseline is not allowed to encode away ----------
//
// The baseline records what the code does. These record what it must NEVER do, whatever the baseline
// says — so a wrong behaviour cannot be legitimised simply by freezing it.

test("no classifier case is ever given tools, hints, reasoning or verbosity", () => {
  const classifiers = results.filter((r) => r.id.startsWith("classifier/") &&
                                            !r.id.includes("contract-quoted"));
  assert.ok(classifiers.length >= 4, "the corpus must cover prefix and both safety stages");
  for (const r of classifiers) {
    const o = r.observed;
    assert.equal(o.toolCount, 0, `${r.id} was offered ${o.toolCount} tools`);
    assert.equal(o.toolChoice, null, `${r.id} was sent a tool_choice`);
    assert.equal(o.hints, false, `${r.id} had agent hints injected into a prompt that forbids preamble`);
    assert.equal(o.reasoning, null, `${r.id} requested reasoning, which shares the verdict's budget`);
    assert.equal(o.verbosity, null, `${r.id} requested verbosity for a fixed-shape answer`);
  }
});

test("a safety verdict never resolves to the main model or the prefix model", () => {
  const safety = results.filter((r) => r.id.startsWith("classifier/safety"));
  const main = results.find((r) => r.id === "agent/tool-selection").observed.model;
  const prefix = results.find((r) => r.id === "classifier/prefix").observed.model;
  for (const r of safety) {
    assert.notEqual(r.observed.model, prefix,
      `${r.id} inherited the small prefix model, which was measured to be more permissive`);
    assert.notEqual(r.observed.model, main, `${r.id} fell back to the main model`);
  }
});

test("an agent turn that merely quotes the contract keeps its tools and its hints", () => {
  // Otherwise a session debugging the router has its own turns misrouted — tools stripped, hints
  // removed, answer routed to a classifier model.
  const r = results.find((r) => r.id === "classifier/contract-quoted-by-an-agent-turn");
  assert.ok(r.observed.toolCount > 100, `expected a full catalogue, got ${r.observed.toolCount}`);
  assert.equal(r.observed.hints, true);
  assert.equal(r.observed.model, results.find((x) => x.id === "agent/tool-selection").observed.model);
});

test("a tool at the very end of a 238-tool catalogue still reaches the model", () => {
  // The historical failure is a silent drop: the model then "chooses" not to use a tool it was never
  // shown, and the symptom looks like a model problem.
  for (const id of ["agent/tool-selection", "agent/renderer-tool-last-in-catalogue"]) {
    const r = results.find((x) => x.id === id);
    assert.equal(r.observed.hasRendererTool, true,
      `${id} dropped the renderer tool, which sits last in the catalogue`);
  }
});

test("an explicit tool_choice survives translation", () => {
  const r = results.find((x) => x.id === "agent/renderer-tool-last-in-catalogue");
  assert.equal(r.observed.toolChoice, "mcp__visualize__show_widget",
    "a tool_choice naming a specific tool must round-trip to that tool");
});

test("the corpus covers every slice the phase asked for", () => {
  // A slice quietly dropped from the corpus is a blind spot that the baseline would then defend.
  const required = [
    "agent tool selection", "utility / structured helpers", "prefix classifier",
    "safety stage 1", "safety stage 2", "renderer/file tools late in the catalogue",
    "long tool loops", "forks / concurrency", "client compaction", "media / document tasks",
    "representative coding task",
  ];
  for (const s of required) assert.ok(SLICES.includes(s), `the corpus is missing the "${s}" slice`);
  assert.equal(CASES.length, results.length);
});

test("the baseline records the versions needed to reproduce it", () => {
  // A result without its inputs is an anecdote. If the proxy code or the config moved, a comparison
  // is between two different systems and the reader has to know that.
  for (const k of ["proxyCodeVersion", "configHash", "rateTableVersion", "provider", "corpusCases"])
    assert.ok(frozen.meta[k] !== undefined, `the baseline must record ${k}`);
  assert.equal(frozen.meta.formatVersion, 1);
});

test("the corpus contains no real transcript, prompt or path from this machine", () => {
  // Fixtures are synthesised precisely so a checked-in corpus carries none of the user's code, file
  // paths or commands. This is a cheap standing check, not a proof.
  const src = fs.readFileSync(path.join(HERE, "corpus.mjs"), "utf8");
  assert.ok(!/\/Users\//.test(src), "no absolute home paths");
  assert.ok(!/sk-[A-Za-z0-9]{8}/.test(src), "no key material");
  assert.ok(!/\bmenachem\b/i.test(src), "no personal identifiers");
  const baselineText = fs.readFileSync(BASELINE, "utf8");
  assert.ok(!/\/Users\//.test(baselineText), "and none leaked into the frozen observations");
  assert.ok(!/sk-[A-Za-z0-9]{8}/.test(baselineText));
});
