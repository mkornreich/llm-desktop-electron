#!/usr/bin/env bash
#
# Launch the Claude Desktop app (unpacked from app.asar) under a stock Electron 43.
#
#   ./run.sh                 # normal launch (logging enabled; console goes to stderr)
#   ./run.sh <flags>         # extra flags are passed straight through to Electron
#
# Layout:
#   app/            the extracted app.asar with app.asar.unpacked's native
#                   binaries merged back in at their original relative paths
#   node_modules/   local Electron 43 runtime
#   user-data/      isolated profile — this build never touches the real
#                   Claude install's data in ~/Library/Application Support/Claude
#
set -euo pipefail
cd "$(dirname "$0")"

ELECTRON=./node_modules/.bin/electron
RES="node_modules/electron/dist/Electron.app/Contents/Resources"

# Self-heal the layout symlink. A handful of the app's worker paths are resolved
# as  <electron resourcesPath>/app.asar/...  with no unpacked fallback (e.g. the
# shell-PATH worker). Pointing Resources/app.asar at our app tree makes those
# resolve, and mirrors the real packaged layout. Recreated here so it survives an
# `npm install` / Electron reinstall that would wipe node_modules.
if [ ! -e "$RES/app.asar" ] || [ "$(readlink "$RES/app.asar" 2>/dev/null)" != "$PWD/app" ]; then
  ln -sfn "$PWD/app" "$RES/app.asar"
fi

# The app spawns every subprocess (shell-PATH probe, Claude Code, ...) through a
# "disclaimer" helper (Contents/Helpers/disclaimer) — a macOS TCC-attribution
# wrapper present in the signed Claude.app but absent from stock Electron. It is
# invoked as `disclaimer <cmd> <args...>`, so a passthrough shim restores spawns.
HELPERS="node_modules/electron/dist/Electron.app/Contents/Helpers"
if [ ! -x "$HELPERS/disclaimer" ]; then
  mkdir -p "$HELPERS"
  printf '#!/bin/sh\nexec "$@"\n' > "$HELPERS/disclaimer"
  chmod +x "$HELPERS/disclaimer"
fi

exec "$ELECTRON" app \
  --user-data-dir="$PWD/user-data" \
  --enable-logging \
  "$@"
