#!/usr/bin/env node
// Install the repository-owned disclaimer helper into stock Electron. npm install replaces
// Electron.app, so run.sh calls this on every launch. The destination is an absolute symlink:
// that keeps the executable source under version control and lets the helper derive the repo
// whose Claude Code cache it is allowed to recognize.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LEGACY_MINIMAL = '#!/bin/sh\nexec "$@"\n';
export const LEGACY_COMMENTED = `#!/bin/sh
# Passthrough shim for the real Claude.app "disclaimer" helper (a macOS TCC
# attribution wrapper absent from stock Electron). The app invokes it as
#   disclaimer <realCmd> <realArgs...>
# so exec-ing the arguments reproduces the intended spawn (minus TCC attribution).
exec "$@"
`;

export function installDisclaimer({ repo, helpersDir, io = fs } = {}) {
  if (!repo) throw new Error("repo is required");
  const source = path.join(repo, "scripts", "claude-code-disclaimer.sh");
  const directory =
    helpersDir ??
    path.join(
      repo,
      "node_modules/electron/dist/Electron.app/Contents/Helpers",
    );
  const destination = path.join(directory, "disclaimer");

  const sourceStat = io.statSync(source);
  if (!sourceStat.isFile()) {
    throw new Error(`repository helper is not a file: ${source}`);
  }
  io.chmodSync(source, sourceStat.mode | 0o111);
  io.mkdirSync(directory, { recursive: true });

  let action = "installed";
  try {
    const current = io.lstatSync(destination);
    if (current.isSymbolicLink()) {
      const target = io.readlinkSync(destination);
      const resolved = path.resolve(directory, target);
      if (resolved === source) {
        return { action: "current", destination, source };
      }
      throw new Error(
        `refusing to replace unexpected disclaimer symlink: ${destination} -> ${target}`,
      );
    }
    if (!current.isFile()) {
      throw new Error(
        `refusing to replace unexpected disclaimer entry: ${destination}`,
      );
    }
    const text = io.readFileSync(destination, "utf8");
    if (text !== LEGACY_MINIMAL && text !== LEGACY_COMMENTED) {
      throw new Error(
        `refusing to overwrite unexpected disclaimer helper: ${destination}`,
      );
    }
    io.unlinkSync(destination);
    action = "migrated legacy passthrough";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  io.symlinkSync(source, destination);
  return { action, destination, source };
}

export function main(argv = process.argv.slice(2)) {
  const ownRepo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const repo = path.resolve(argv[0] ?? ownRepo);
  // The app resolves the helper as join(dirname(process.resourcesPath), "Helpers",
  // "disclaimer"). resourcesPath differs by platform, so the Helpers dir does too:
  //   macOS  <dist>/Electron.app/Contents/Resources -> <dist>/Electron.app/Contents/Helpers
  //   linux  <dist>/resources                        -> <dist>/Helpers
  //   win32  <dist>/resources                        -> <dist>/Helpers
  const dist = path.join(repo, "node_modules/electron/dist");
  const helpersDir =
    process.platform === "darwin"
      ? path.join(dist, "Electron.app/Contents/Helpers")
      : path.join(dist, "Helpers");
  const result = installDisclaimer({ repo, helpersDir });
  console.log(
    `[disclaimer] ${result.action}: ${result.destination} -> ${result.source}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
