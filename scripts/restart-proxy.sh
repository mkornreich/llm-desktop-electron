#!/usr/bin/env bash
# Restart the local Anthropic->OpenAI translation proxy.
#
#   scripts/restart-proxy.sh
#
# The proxy runs as a child of openai-proxy/supervise.mjs, which respawns it whenever it exits. So the
# normal restart is simply: kill the CHILD and let the supervisor bring a fresh one up. Do this to pick
# up edits to openai-proxy/*.mjs, or a config.jsonc change (the proxy reads its config once at startup).
#
# If the supervisor itself is gone (it was killed, or the app was closed), fall back to ensure-proxy,
# reconstructing the launch environment from the running desktop app (which inherited run.sh's exports).
# If neither is available, relaunch the app with ./run.sh instead.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

PORT="$(node -e 'try{console.log(require("./openai-proxy/jsonc.cjs").readConfig().advanced.port||8123)}catch{console.log(8123)}' 2>/dev/null || echo 8123)"
HEALTH="http://127.0.0.1:${PORT}/health"

# The pid the proxy currently reports as healthy (empty if nothing is serving).
health_pid() {
  curl -s -m 3 "$HEALTH" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).pid||""))}catch{}})' 2>/dev/null
}

# The proxy.mjs process whose parent is the supervisor (the one to kill for a respawn).
supervised_child() {
  local p ppid pcmd
  for p in $(pgrep -f "openai-proxy/proxy.mjs" 2>/dev/null); do
    ppid="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    pcmd="$(ps -o args= -p "$ppid" 2>/dev/null)"
    case "$pcmd" in *supervise.mjs*) echo "$p"; return 0 ;; esac
  done
  return 1
}

before="$(health_pid)"
child="$(supervised_child)"

if [ -n "$child" ]; then
  echo "[restart] killing proxy child $child on port $PORT — the supervisor will respawn it"
  kill "$child" 2>/dev/null || true
else
  echo "[restart] no supervised proxy child — the supervisor is down; using ensure-proxy"
  # The desktop app was launched by run.sh AFTER all the proxy env was exported, so its environment
  # is the source of truth for OPENAI_BASE_URL (managed Ollama port), keys, LLMD_*, OLLAMA_*, etc.
  app=""
  for p in $(pgrep -f "electron" 2>/dev/null); do
    if [ -r "/proc/$p/environ" ] && grep -qz "^OPENAI_BASE_URL=" "/proc/$p/environ" 2>/dev/null; then app="$p"; break; fi
  done
  if [ -n "$app" ]; then
    echo "[restart] reusing the app's launch environment (pid $app)"
    while IFS= read -r -d '' kv; do
      case "$kv" in OPENAI_*=*|LLMD_*=*|OLLAMA_*=*|PROXY_ANTHROPIC_BASE_URL=*) export "${kv?}" ;; esac
    done < "/proc/$app/environ"
  else
    echo "[restart] no running app found to borrow env from — deriving from config.jsonc"
    echo "[restart] (if the proxy's upstream is a managed Ollama, relaunch with ./run.sh instead)"
    eval "$(node openai-proxy/config.mjs --env 2>/dev/null)" || true
  fi
  if ! node scripts/ensure-proxy.mjs --port "$PORT"; then
    echo "[restart] ensure-proxy could not start the proxy — see the lines above" >&2
    exit 1
  fi
fi

# Wait for a fresh, healthy proxy (a NEW pid, since the old one just died).
for _ in $(seq 1 25); do
  now="$(health_pid)"
  if [ -n "$now" ] && [ "$now" != "$before" ]; then
    echo "[restart] proxy healthy — pid $now on port $PORT"
    exit 0
  fi
  sleep 1
done
echo "[restart] proxy did not come back healthy on port $PORT within 25s" >&2
exit 1
