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

# Ask the agent to use a distinct model for its background safety classifier (from
# the .openai-model dotfile). Best-effort: the desktop curates the agent env, so
# this may not propagate in-app — the proxy detects the classifier and routes it to
# OPENAI_CLASSIFIER_MODEL regardless. (Does reach the CLI agent.)
BG_CLASSIFIER=$(sed -n 's/^CLAUDE_CODE_BG_CLASSIFIER_MODEL=//p' .openai-model 2>/dev/null | head -1)
if [ -n "${BG_CLASSIFIER:-}" ]; then
  export CLAUDE_CODE_BG_CLASSIFIER_MODEL="$BG_CLASSIFIER"
  echo "[run-openai] CLAUDE_CODE_BG_CLASSIFIER_MODEL=${CLAUDE_CODE_BG_CLASSIFIER_MODEL}"
fi

exec ./run.sh "$@"
