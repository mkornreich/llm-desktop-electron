#!/usr/bin/env bash
#
# Open the settings window — a GUI for the launcher's dot files (.provider, .openai-model,
# .privacy, .sync).
#
# It runs as a tiny local page rather than an Electron window on purpose: run.sh symlinks
# Resources/app.asar -> app/, which makes Electron load Anthropic's app and ignore any CLI
# app path (verified with both `electron settings` and `electron --app=settings`). A separate
# Electron would mean a second ~200 MB runtime.
#
# Works in both provider modes and needs nothing running.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${SETTINGS_PORT:-8765}"
# Reuse an already-running server rather than fighting over the port. Match a LISTENING
# socket specifically: plain `lsof -ti tcp:PORT` also matches the browser's own ESTABLISHED
# client connections, so it reports "in use" when nothing is actually serving.
if lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[settings] a settings server is already on :${PORT} — reusing it"
  echo "[settings] if the window didn't open, quit that server and rerun this script"
  exit 0
fi

LOG=settings/server.log
SETTINGS_PORT="$PORT" nohup node settings/server.js > "$LOG" 2>&1 &
disown
for _ in $(seq 1 20); do
  # `|| true` matters: under `set -e` a failing command substitution in an assignment kills
  # the script, and grep fails on every iteration before the server writes its first line.
  URL="$(grep -aoE 'http://127\.0\.0\.1:[0-9]+/\?t=[0-9a-f]+' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.25
done
if [ -z "${URL:-}" ]; then
  echo "[settings] server failed to start — see $LOG" >&2
  exit 1
fi
echo "[settings] $URL"

# Prefer a chrome-less app window; fall back to the default browser. macOS drives it with
# `open`; Linux has no `open`, so try a Chromium-family browser in --app mode and finally
# xdg-open — without this the server started but the window never opened on Linux.
if [ "$(uname -s)" = "Darwin" ]; then
  for app in "Google Chrome Canary" "Google Chrome" "Microsoft Edge" "Brave Browser"; do
    if [ -d "/Applications/${app}.app" ]; then
      open -na "$app" --args --app="$URL" --window-size=920,940 && exit 0
    fi
  done
  open "$URL"
  exit 0
fi
# Linux: a Chromium-family browser gives the same chrome-less window; else the default handler.
for bin in google-chrome-stable google-chrome chromium chromium-browser brave brave-browser microsoft-edge; do
  if command -v "$bin" >/dev/null 2>&1; then
    ( nohup "$bin" --app="$URL" --window-size=920,940 >/dev/null 2>&1 & )
    exit 0
  fi
done
if command -v xdg-open >/dev/null 2>&1; then
  ( nohup xdg-open "$URL" >/dev/null 2>&1 & )
  exit 0
fi
echo "[settings] no browser launcher found — open this URL yourself: $URL"
