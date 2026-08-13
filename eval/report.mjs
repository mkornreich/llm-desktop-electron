#!/usr/bin/env node
// Run the corpus, print what changed, and freeze a baseline when asked.
//
//   node eval/report.mjs                 run the corpus and compare against the frozen baseline
//   node eval/report.mjs --freeze        overwrite the baseline with what the code does NOW
//   node eval/report.mjs --json          the full observations, for a report file
//   node eval/report.mjs --live          refuses; see below
//
// --freeze IS THE DANGEROUS ONE, so it says what it is doing and why that matters. A baseline exists
// to make the next behaviour change visible as a difference. Freezing it at the same time as making
// that change destroys the only record of what came before — the diff becomes empty and the change
// becomes unreviewable. Freeze deliberately, in its own commit, with the reason written down.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, diff } from "./harness.mjs";
import { SLICES, CASES } from "./corpus.mjs";
import { RATE_TABLE_VERSION } from "../openai-proxy/model-registry.mjs";
import { codeVersion, configHash, provider } from "../openai-proxy/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "baseline.json");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

if (has("--live")) {
  process.stdout.write(
    "Live paired runs are not implemented here, on purpose.\n\n" +
    "This phase freezes the incumbent BEHAVIOUR baseline: which tools each route exposes, which\n" +
    "model it resolves to, whether hints and reasoning are attached, which pricing tier a request\n" +
    "lands in, what compaction keeps. All of that is decided before a token is generated, so a real\n" +
    "model would add cost and variance without adding information.\n\n" +
    "Model QUALITY is a different question. It needs paired runs on identical inputs with repetitions,\n" +
    "it costs real money, and it can only justify a change to a default — which is the phase that owns\n" +
    "changing defaults, not this one. Building the runner here would mean shipping an unused, untested\n" +
    "spend path.\n");
  process.exit(2);
}

// Everything needed to reproduce the run, because a result without its inputs is an anecdote.
//
// Captured BEFORE run(), which is not a detail: the harness points OPENAI_BASE_URL at a fake upstream
// on an ephemeral port, and that setting is part of the config hash. Computing the hash afterwards
// recorded a different value on every run — a version field that changes randomly is worse than an
// absent one, because it looks meaningful and defeats the "did the config move?" comparison it exists
// for. This is the repository's real configuration, which is what the reader wants to know.
const meta = {
  formatVersion: 1,
  corpusCases: CASES.length,
  slices: SLICES,
  proxyCodeVersion: codeVersion(),
  configHash: configHash(),
  provider: provider(),
  rateTableVersion: RATE_TABLE_VERSION,
  node: process.version,
};

const results = await run();

if (has("--json")) {
  process.stdout.write(JSON.stringify({ meta, results }, null, 2) + "\n");
  process.exit(0);
}

if (has("--freeze")) {
  fs.writeFileSync(BASELINE, JSON.stringify({ meta, results }, null, 2) + "\n");
  process.stdout.write(
    `froze ${results.length} cases into ${path.relative(process.cwd(), BASELINE)}\n` +
    `  proxy code ${meta.proxyCodeVersion}  config ${meta.configHash}  rates ${meta.rateTableVersion}\n` +
    `\nThis is now the "before" that later phases are measured against. Commit it on its own, and\n` +
    `say in the message what changed and why the previous baseline no longer applied.\n`);
  process.exit(0);
}

let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch { /* not frozen yet */ }

const w = (s) => process.stdout.write(s + "\n");
w(`corpus: ${results.length} cases across ${SLICES.length} slices`);
w(`proxy code ${meta.proxyCodeVersion}  config ${meta.configHash}  rates ${meta.rateTableVersion}\n`);

// The table people will actually read. One line per case, the fields that decide behaviour.
w("case".padEnd(46) + "model".padEnd(22) + "tools".padStart(6) + "  hints  reason   verbosity");
for (const r of results) {
  const o = r.observed || {};
  w(String(r.id).padEnd(46) + String(o.model ?? "-").padEnd(22) +
    String(o.toolCount ?? "-").padStart(6) +
    "  " + (o.hints ? "yes " : "no  ").padEnd(6) +
    " " + String(o.reasoning ?? "off").padEnd(8) +
    " " + String(o.verbosity ?? "-"));
}

if (!baseline) {
  w("\nNo frozen baseline. Run with --freeze to create one.");
  process.exit(0);
}

const changes = diff(baseline.results, results);
if (!changes.length) {
  w("\nno behaviour change against the frozen baseline");
  process.exit(0);
}
w(`\n${changes.length} DIFFERENCE(S) against the frozen baseline:`);
for (const c of changes) {
  if (c.kind) w(`  ${c.id}: ${c.kind}`);
  else w(`  ${c.id}: ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
}
w("\nA difference is not automatically wrong — it is a change that has to be explained. If it is\n" +
  "intended, re-freeze in its own commit and say why.");
process.exitCode = 1;
