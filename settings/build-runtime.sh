#!/usr/bin/env bash
#
# Build the shadow Electron dist the settings window runs on: settings/.electron-runtime.
#
# Why a shadow at all: run.sh symlinks node_modules/electron/dist/resources/app.asar -> app/ so a
# handful of the app's worker paths resolve, which makes the shared Electron binary ALWAYS load
# Anthropic's bundle and ignore any CLI app path. Electron derives its resources dir from
# /proc/self/exe, so we can't just symlink the binary elsewhere (the symlink resolves back to the
# real dist). Instead we HARD-LINK the binary into a new directory (same inode, ~0 extra disk, same
# filesystem) whose resources/ holds only default_app.asar — no app.asar. /proc/self/exe then lands
# in the shadow, resources/ is clean, and `electron settings/` loads settings/main.js.
#
# Idempotent: rebuilds only when Electron's version changed or the shadow is missing/broken.
set -euo pipefail
cd "$(dirname "$0")/.."                       # repo root
SRC="$PWD/node_modules/electron/dist"
SH="$PWD/settings/.electron-runtime"

[ -x "$SRC/electron" ] || { echo "[settings] no Electron binary at $SRC (run npm install)" >&2; exit 1; }
WANT="$(cat "$SRC/version" 2>/dev/null || echo unknown)"

# Up to date? Binary still hard-linked to the same inode, version matches, and no app.asar snuck in.
if [ -x "$SH/electron" ] && [ "$SH/electron" -ef "$SRC/electron" ] \
   && [ "$(cat "$SH/.built-version" 2>/dev/null || true)" = "$WANT" ] \
   && [ ! -e "$SH/resources/app.asar" ]; then
  exit 0
fi

rm -rf "$SH"
mkdir -p "$SH/resources"
# Hard-link the big binary so /proc/self/exe resolves inside the shadow; fall back to a copy if the
# dist lives on a different filesystem than the repo (hard links can't cross mounts).
ln "$SRC/electron" "$SH/electron" 2>/dev/null || cp -p "$SRC/electron" "$SH/electron"
# Symlink every other top-level entry (libs, paks, locales, snapshots, sandbox helper, …). Iterating
# the dir rather than a fixed list keeps this correct across Electron version bumps.
for e in "$SRC"/*; do
  b="$(basename "$e")"
  case "$b" in electron|resources) continue ;; esac
  ln -sfn "$e" "$SH/$b"
done
# The clean resources/: default_app.asar (the CLI-path loader) and deliberately NO app.asar.
ln -sfn "$SRC/resources/default_app.asar" "$SH/resources/default_app.asar"
printf '%s' "$WANT" > "$SH/.built-version"
echo "[settings] built Electron shadow runtime ($WANT) at settings/.electron-runtime"
