#!/usr/bin/env bash
#
# Launch the desktop app with its Claude Code / agent sub-layer routed through
# the Anthropic->OpenAI translation proxy (openai-proxy/proxy.mjs).
#
# This ONLY affects the bundled Anthropic SDK calls the app makes from its agent
# child process (Claude Code). The main chat window is the remote claude.ai web
# app and is unaffected — it still talks to Anthropic. See openai-proxy/README.md.
#
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8123}"
PROXY_URL="http://127.0.0.1:${PORT}"

# Start the proxy if it isn't already listening.
if ! curl -sf "${PROXY_URL}/health" >/dev/null 2>&1; then
  echo "[run-openai] starting translation proxy on ${PROXY_URL}"
  ( cd openai-proxy && PORT="$PORT" nohup node proxy.mjs > proxy.log 2>&1 & disown )
  for _ in $(seq 1 10); do curl -sf "${PROXY_URL}/health" >/dev/null 2>&1 && break; sleep 1; done
fi
curl -sf "${PROXY_URL}/health" >/dev/null 2>&1 \
  && echo "[run-openai] proxy healthy: $(curl -s ${PROXY_URL}/health)" \
  || { echo "[run-openai] proxy failed to start — see openai-proxy/proxy.log"; exit 1; }

# The env-gated patch in app/.vite/build/index.chunk-CnWKsyE_.js reads this var
# and, when set, uses it as ANTHROPIC_BASE_URL for the agent child process.
export PROXY_ANTHROPIC_BASE_URL="${PROXY_URL}"
echo "[run-openai] PROXY_ANTHROPIC_BASE_URL=${PROXY_ANTHROPIC_BASE_URL}"

# The app pins a specific RC Claude Code build and tries to download it; that URL
# isn't publicly fetchable, so it reports "binary missing or damaged". Point it at
# a locally-installed `claude` instead (CLAUDE_CODE_LOCAL_BINARY is the app's own
# override: it just access(X_OK)-checks the path and uses it, skipping download).
if [ -z "${CLAUDE_CODE_LOCAL_BINARY:-}" ]; then
  CLAUDE_BIN="$(command -v claude || true)"
  if [ -n "$CLAUDE_BIN" ]; then export CLAUDE_CODE_LOCAL_BINARY="$CLAUDE_BIN"; fi
fi
if [ -n "${CLAUDE_CODE_LOCAL_BINARY:-}" ]; then
  echo "[run-openai] CLAUDE_CODE_LOCAL_BINARY=${CLAUDE_CODE_LOCAL_BINARY}"
else
  echo "[run-openai] WARN: no 'claude' on PATH — in-app Claude Code will fail to download its binary"
fi

# Forward CLAUDE_CODE_* settings from the dotfile into the environment, e.g.
# CLAUDE_CODE_BG_CLASSIFIER_MODEL and CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
# (the latter makes the app list the proxy's /v1/models in the picker). The desktop
# reads its own env so these reach it; the curated agent-child env may drop some —
# the proxy-side routing/discovery is the reliable path.
while IFS='=' read -r k v; do
  case "$k" in
    CLAUDE_CODE_*) export "$k=$v"; echo "[run-openai] $k=$v" ;;
  esac
done < <(grep -E '^CLAUDE_CODE_[A-Z_]+=' .openai-model 2>/dev/null)

# The privacy/telemetry toggle lives in run.sh (driven by the .privacy dot file), so
# it applies to this launcher too — nothing to do here.
exec ./run.sh "$@"
