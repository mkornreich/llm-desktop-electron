#!/usr/bin/env bash
#
# Open the settings window — a GUI for the launcher's config (config.jsonc).
#
# Default: a native Electron window. The blocker used to be that run.sh symlinks
# Resources/app.asar -> app/, which makes the shared Electron binary load Anthropic's app and
# ignore any CLI app path. settings/build-runtime.sh works around that with a shadow dist (a
# hard-linked binary + a clean resources/ with no app.asar), so `electron settings/` loads the
# settings app — reusing the already-downloaded binary at ~zero extra disk, no second ~200 MB
# runtime. settings/main.js embeds settings/server.js on an ephemeral token-guarded loopback port.
#
# Fallback: the same server as a local page opened in a Chromium --app window (or the default
# browser). Forced with SETTINGS_SERVER=1, or used automatically if the Electron runtime can't be
# built. Works in both provider modes and needs nothing else running.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

# ---- Fallback: local server + browser window (the pre-Electron path) --------------------------
run_server_mode() {
  local PORT LOG URL bin app
  PORT="${SETTINGS_PORT:-8765}"
  # Reuse an already-running server rather than fighting over the port. Match a LISTENING socket
  # specifically: plain `lsof -ti tcp:PORT` also matches the browser's own ESTABLISHED client
  # connections, so it reports "in use" when nothing is actually serving.
  if lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[settings] a settings server is already on :${PORT} — reusing it"
    echo "[settings] if the window didn't open, quit that server and rerun this script"
    exit 0
  fi
  LOG=settings/server.log
  SETTINGS_PORT="$PORT" nohup node settings/server.js > "$LOG" 2>&1 &
  disown
  for _ in $(seq 1 20); do
    # `|| true` matters: under `set -e` a failing command substitution in an assignment kills the
    # script, and grep fails on every iteration before the server writes its first line.
    URL="$(grep -aoE 'http://127\.0\.0\.1:[0-9]+/\?t=[0-9a-f]+' "$LOG" 2>/dev/null | head -1 || true)"
    [ -n "$URL" ] && break
    sleep 0.25
  done
  if [ -z "${URL:-}" ]; then
    echo "[settings] server failed to start — see $LOG" >&2
    exit 1
  fi
  echo "[settings] $URL"
  if [ "$(uname -s)" = "Darwin" ]; then
    for app in "Google Chrome Canary" "Google Chrome" "Microsoft Edge" "Brave Browser"; do
      if [ -d "/Applications/${app}.app" ]; then
        open -na "$app" --args --app="$URL" --window-size=920,940 && exit 0
      fi
    done
    open "$URL"; exit 0
  fi
  for bin in google-chrome-stable google-chrome chromium chromium-browser brave brave-browser microsoft-edge; do
    if command -v "$bin" >/dev/null 2>&1; then
      ( nohup "$bin" --app="$URL" --window-size=920,940 >/dev/null 2>&1 & )
      exit 0
    fi
  done
  if command -v xdg-open >/dev/null 2>&1; then
    ( nohup xdg-open "$URL" >/dev/null 2>&1 & ); exit 0
  fi
  echo "[settings] no browser launcher found — open this URL yourself: $URL"
}

# ---- Default: native Electron window ----------------------------------------------------------
SH="$ROOT/settings/.electron-runtime"
if [ "${SETTINGS_SERVER:-0}" != "1" ] && [ -x "$ROOT/node_modules/electron/dist/electron" ]; then
  # Already open? The window's process carries the shadow binary path on its command line.
  if pgrep -af "$SH/electron" >/dev/null 2>&1; then
    echo "[settings] a settings window is already open — reusing it"
    exit 0
  fi
  if bash "$ROOT/settings/build-runtime.sh"; then
    # --no-sandbox: the renderer only ever loads our own local, token-guarded page (no untrusted
    # web content), and it drops the setuid chrome-sandbox dependency so this works even when the
    # app itself has never been launched.
    nohup "$SH/electron" "$ROOT/settings" --no-sandbox >"$ROOT/settings/electron.log" 2>&1 &
    disown
    echo "[settings] opened the Electron settings window"
    exit 0
  fi
  echo "[settings] could not build the Electron runtime — falling back to a local page" >&2
fi
run_server_mode
