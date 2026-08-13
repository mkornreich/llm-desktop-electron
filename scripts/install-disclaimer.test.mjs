// node --test scripts/install-disclaimer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  LEGACY_COMMENTED,
  LEGACY_MINIMAL,
  installDisclaimer,
} from "./install-disclaimer.mjs";

const SOURCE_HELPER = new URL("./claude-code-disclaimer.sh", import.meta.url);
const INTERNAL_MODEL = "claude-opus-4-8[1m]";

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "disclaimer-test-"));
  const scripts = path.join(repo, "scripts");
  const helpersDir = path.join(repo, "Electron.app", "Contents", "Helpers");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(SOURCE_HELPER, path.join(scripts, "claude-code-disclaimer.sh"));
  const installed = installDisclaimer({ repo, helpersDir });
  return {
    repo,
    helpersDir,
    helper: installed.destination,
    target(version = "9.9.999") {
      return path.join(
        repo,
        "user-data",
        "claude-code",
        version,
        "claude.app",
        "Contents",
        "MacOS",
        "claude",
      );
    },
    cleanup() {
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

function writeRecorder(command) {
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.RECORDER_EXIT || 0));
`,
    { mode: 0o755 },
  );
}

// Subagents have no argv of their own, so their model arrives through the environment. This
// recorder reports the env the CLI would actually see, not just the command line.
function writeEnvRecorder(command) {
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
  exploreCap: process.env.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP ?? null,
}));
`,
    { mode: 0o755 },
  );
}

function runEnv(helper, command, args, openai = true, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (openai) env.LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL = INTERNAL_MODEL;
  else delete env.LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL;
  const result = spawnSync(helper, [command, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function run(helper, command, args, openai = true, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (openai) env.LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL = INTERNAL_MODEL;
  else delete env.LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL;
  const result = spawnSync(helper, [command, ...args], {
    encoding: "utf8",
    env,
  });
  return {
    ...result,
    argv: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

function makeUninstalledFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "disclaimer-install-"));
  const scripts = path.join(repo, "scripts");
  const helpersDir = path.join(repo, "Electron.app", "Contents", "Helpers");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(SOURCE_HELPER, path.join(scripts, "claude-code-disclaimer.sh"));
  return { repo, helpersDir, destination: path.join(helpersDir, "disclaimer") };
}

test("rewrites every split Claude identity and preserves ordering", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeRecorder(command);
    for (const model of [
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-future-model",
    ]) {
      const args = [
        "--bare",
        "--model",
        model,
        "--resume",
        "session-123",
        "--permission-mode",
        "bypassPermissions",
      ];
      const result = run(f.helper, command, args);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.argv, [
        "--bare",
        "--model",
        INTERNAL_MODEL,
        "--resume",
        "session-123",
        "--permission-mode",
        "bypassPermissions",
      ]);
    }
  } finally {
    f.cleanup();
  }
});

test("rewrites every joined Claude identity", () => {
  const f = fixture();
  try {
    const command = f.target("2.2.300");
    writeRecorder(command);
    for (const model of [
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-future-model",
    ]) {
      const result = run(f.helper, command, [
        `--model=${model}`,
        "--resume",
        "kept",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.argv, [
        `--model=${INTERNAL_MODEL}`,
        "--resume",
        "kept",
      ]);
    }
  } finally {
    f.cleanup();
  }
});

test("preserves the configured identity and OpenAI model ids", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeRecorder(command);
    for (const model of [
      INTERNAL_MODEL,
      "gpt-5.6-sol",
      "gpt-5.4",
      "gpt-4.1-mini",
    ]) {
      const split = run(f.helper, command, ["--model", model]);
      assert.equal(split.status, 0, split.stderr);
      assert.deepEqual(split.argv, ["--model", model]);

      const joined = run(f.helper, command, [`--model=${model}`]);
      assert.equal(joined.status, 0, joined.stderr);
      assert.deepEqual(joined.argv, [`--model=${model}`]);
    }
  } finally {
    f.cleanup();
  }
});

// Subagents (Task/Explore/teammate spawns) run inside the session process and so never get an
// argv of their own. Claude Code reads CLAUDE_CODE_SUBAGENT_MODEL before the Task tool's own
// `model` argument and before an agent definition's frontmatter, so it is the only lever that
// gives them the same 1M capability as the main loop.
test("gives subagents the configured 1M identity", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeEnvRecorder(command);
    const seen = runEnv(f.helper, command, ["--model", "claude-opus-5"]);
    assert.equal(seen.subagentModel, INTERNAL_MODEL);
    assert.deepEqual(seen.argv, ["--model", INTERNAL_MODEL]);
  } finally {
    f.cleanup();
  }
});

// The desktop bundle composes the agent env itself and sets CLAUDE_CODE_SUBAGENT_MODEL from
// getDefaultSubagentModel(), which is where claude-sonnet-5 came from. This process is the
// CLI's direct parent, so its assignment must be the one that survives — otherwise subagents
// keep resolving Sonnet's ordinary window and compact early.
test("overrides a subagent model the desktop already chose", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeEnvRecorder(command);
    for (const desktopChoice of [
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "inherit",
    ]) {
      const seen = runEnv(f.helper, command, ["--model", "claude-opus-5"], true, {
        CLAUDE_CODE_SUBAGENT_MODEL: desktopChoice,
      });
      assert.equal(seen.subagentModel, INTERNAL_MODEL);
    }
  } finally {
    f.cleanup();
  }
});

// The Explore cap only engages for a first-party base URL, so it is already inert behind a
// localhost proxy and CLAUDE_CODE_SUBAGENT_MODEL outranks it regardless. Setting it would be an
// unnecessary behaviour change, so assert we leave it alone.
test("does not set the explore inherit cap", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeEnvRecorder(command);
    const seen = runEnv(f.helper, command, ["--model", "claude-opus-5"]);
    assert.equal(seen.exploreCap, null);
  } finally {
    f.cleanup();
  }
});

// Anthropic mode must stay stock: no argv rewrite AND no environment injection, so a real
// Claude subagent keeps whichever model Desktop picked for it.
test("leaves the subagent model untouched in Anthropic mode", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeEnvRecorder(command);
    const bare = runEnv(f.helper, command, ["--model", "claude-opus-5"], false);
    assert.equal(bare.subagentModel, null);
    assert.deepEqual(bare.argv, ["--model", "claude-opus-5"]);

    const preset = runEnv(f.helper, command, ["--model", "claude-opus-5"], false, {
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5",
    });
    assert.equal(preset.subagentModel, "claude-sonnet-5");
  } finally {
    f.cleanup();
  }
});

// A subprocess that is not the bundled/cached Claude executable exits before the rewrite, so it
// must not inherit an injected model either.
test("does not inject a subagent model into unrelated subprocesses", () => {
  const f = fixture();
  try {
    const command = path.join(f.repo, "some-other-tool");
    writeEnvRecorder(command);
    const seen = runEnv(f.helper, command, ["--model", "claude-opus-5"]);
    assert.equal(seen.subagentModel, null);
    assert.deepEqual(seen.argv, ["--model", "claude-opus-5"]);
  } finally {
    f.cleanup();
  }
});

test("passes unrelated subprocesses through in OpenAI mode", () => {
  const f = fixture();
  try {
    const command = path.join(f.repo, "shell-path-probe");
    writeRecorder(command);
    const args = ["--model", "claude-opus-4-8", "literal argument"];
    const result = run(f.helper, command, args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.argv, args);
  } finally {
    f.cleanup();
  }
});

test("Anthropic mode is an exact argv passthrough even for cached Claude Code", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeRecorder(command);
    const args = [
      "--model",
      "claude-opus-4-8",
      "--resume",
      "session-abc",
      "argument with spaces",
    ];
    const result = run(f.helper, command, args, false);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.argv, args);
  } finally {
    f.cleanup();
  }
});

test("exec preserves the target exit status", () => {
  const f = fixture();
  try {
    const command = f.target();
    writeRecorder(command);
    const result = run(
      f.helper,
      command,
      ["--model", "claude-opus-4-8"],
      true,
      { RECORDER_EXIT: "37" },
    );
    assert.equal(result.status, 37);
  } finally {
    f.cleanup();
  }
});

test(
  "exec preserves the process identity and signal delivery",
  { timeout: 10_000 },
  async () => {
    const f = fixture();
    try {
      const command = f.target();
      const pidFile = path.join(f.repo, "pid");
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(
        command,
        `#!/usr/bin/env bash
printf '%s' "$$" > "$1"
trap 'exit 44' TERM
while :; do sleep 0.1; done
`,
        { mode: 0o755 },
      );
      const child = spawn(f.helper, [command, pidFile], {
        env: {
          ...process.env,
          LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL: INTERNAL_MODEL,
        },
        stdio: "ignore",
      });
      const deadline = Date.now() + 3_000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(fs.existsSync(pidFile), "target should record its pid");
      assert.equal(Number(fs.readFileSync(pidFile, "utf8")), child.pid);
      child.kill("SIGTERM");
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(result, { code: 44, signal: null });
    } finally {
      f.cleanup();
    }
  },
);

test("installer creates an absolute executable symlink and is idempotent", () => {
  const f = makeUninstalledFixture();
  try {
    const first = installDisclaimer(f);
    assert.equal(first.action, "installed");
    assert.ok(fs.lstatSync(f.destination).isSymbolicLink());
    assert.equal(
      fs.readlinkSync(f.destination),
      path.join(f.repo, "scripts", "claude-code-disclaimer.sh"),
    );
    fs.accessSync(first.source, fs.constants.X_OK);

    const second = installDisclaimer(f);
    assert.equal(second.action, "current");
    assert.equal(fs.readlinkSync(f.destination), first.source);
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

for (const [name, content] of [
  ["minimal", LEGACY_MINIMAL],
  ["commented", LEGACY_COMMENTED],
]) {
  test(`installer migrates the exact ${name} legacy passthrough`, () => {
    const f = makeUninstalledFixture();
    try {
      fs.mkdirSync(f.helpersDir, { recursive: true });
      fs.writeFileSync(f.destination, content, { mode: 0o755 });
      const result = installDisclaimer(f);
      assert.equal(result.action, "migrated legacy passthrough");
      assert.ok(fs.lstatSync(f.destination).isSymbolicLink());
      assert.equal(fs.readlinkSync(f.destination), result.source);
    } finally {
      fs.rmSync(f.repo, { recursive: true, force: true });
    }
  });
}

test("installer refuses to overwrite an unexpected regular helper", () => {
  const f = makeUninstalledFixture();
  try {
    fs.mkdirSync(f.helpersDir, { recursive: true });
    const unexpected = "#!/bin/sh\nprintf 'native or user-owned helper'\n";
    fs.writeFileSync(f.destination, unexpected, { mode: 0o755 });
    assert.throws(
      () => installDisclaimer(f),
      /refusing to overwrite unexpected disclaimer helper/,
    );
    assert.equal(fs.readFileSync(f.destination, "utf8"), unexpected);
    assert.ok(!fs.lstatSync(f.destination).isSymbolicLink());
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test("installer refuses to replace an unexpected symlink", () => {
  const f = makeUninstalledFixture();
  try {
    fs.mkdirSync(f.helpersDir, { recursive: true });
    const other = path.join(f.repo, "other-helper");
    fs.writeFileSync(other, "other");
    fs.symlinkSync(other, f.destination);
    assert.throws(
      () => installDisclaimer(f),
      /refusing to replace unexpected disclaimer symlink/,
    );
    assert.equal(fs.readlinkSync(f.destination), other);
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});
