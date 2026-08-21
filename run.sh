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
#   user-data/      isolated profile, with ONE deliberate exception: since issue #3
#                   claude-code-sessions is a symlink to the real install's store, so
#                   sessions are shared and written both ways. Everything else here
#                   (cookies, caches, Local Storage) stays private to this build.
#
set -euo pipefail
cd "$(dirname "$0")"

ELECTRON=./node_modules/.bin/electron

# Platform-specific layout. The macOS Electron nests everything under Electron.app/Contents;
# a stock Linux (or Windows) Electron uses a flat dist with a top-level resources/ dir, and
# the app resolves its Helpers dir as dirname(resourcesPath)/Helpers accordingly. The Claude
# Desktop profile that session-sync reads from also lives in a different place per OS.
case "$(uname -s)" in
  Darwin)
    RES="node_modules/electron/dist/Electron.app/Contents/Resources"
    CLAUDE_SUPPORT="$HOME/Library/Application Support/Claude"
    ;;
  *)  # Linux (and Windows via Git Bash/WSL): flat dist, XDG config dir
    RES="node_modules/electron/dist/resources"
    CLAUDE_SUPPORT="$HOME/.config/Claude"
    ;;
esac

# Self-heal the layout symlink. A handful of the app's worker paths are resolved
# as  <electron resourcesPath>/app.asar/...  with no unpacked fallback (e.g. the
# shell-PATH worker). Pointing Resources/app.asar at our app tree makes those
# resolve, and mirrors the real packaged layout. Recreated here so it survives an
# `npm install` / Electron reinstall that would wipe node_modules.
if [ ! -e "$RES/app.asar" ] || [ "$(readlink "$RES/app.asar" 2>/dev/null)" != "$PWD/app" ]; then
  ln -sfn "$PWD/app" "$RES/app.asar"
fi

# chrome-sandbox self-heal (Linux). Electron's renderer sandbox needs EITHER an unprivileged
# user-namespace (which modern Ubuntu disables via kernel.apparmor_restrict_unprivileged_userns=1)
# OR a setuid-root chrome-sandbox. The stock Electron we download ships chrome-sandbox owned by us,
# so on such a kernel Electron aborts: "SUID sandbox helper binary ... not configured correctly".
# The `.deb` of Claude Desktop already installed a setuid-root chrome-sandbox of the SAME Electron
# build (byte-identical), so borrow it via a symlink — this keeps the sandbox ON with no `sudo` and
# self-heals after an `npm install`. `find -L -perm -4000 -uid 0` is non-empty only for a working
# (directly-or-via-symlink) setuid-root binary, so an already-linked sandbox is left alone.
if [ "$(uname -s)" != "Darwin" ] && [ -e "$RES/../chrome-sandbox" ]; then
  SANDBOX="$RES/../chrome-sandbox"
  if [ -z "$(find -L "$SANDBOX" -perm -4000 -uid 0 2>/dev/null)" ]; then
    linked=0
    for stock in /usr/lib/claude-desktop/chrome-sandbox /opt/Claude/chrome-sandbox \
                 "$HOME/.local/share/claude-desktop/chrome-sandbox"; do
      if [ -n "$(find -L "$stock" -perm -4000 -uid 0 2>/dev/null)" ] && cmp -s "$SANDBOX" "$stock"; then
        mv -f "$SANDBOX" "$SANDBOX.orig" 2>/dev/null || true
        ln -sfn "$stock" "$SANDBOX"
        echo "[run] chrome-sandbox: linked to $stock (setuid-root; keeps the renderer sandbox, no sudo)"
        linked=1; break
      fi
    done
    if [ "$linked" = 0 ]; then
      echo "[run] WARNING: chrome-sandbox is not setuid-root and no matching system copy was found;"
      echo "[run]          Electron may abort. Fix it once with:"
      echo "[run]            sudo chown root:root '$PWD/$SANDBOX' && sudo chmod 4755 '$PWD/$SANDBOX'"
      echo "[run]          (or add --no-sandbox to ./run.sh — less secure for the remote web content)."
    fi
  fi
fi

# The app spawns every subprocess (shell-PATH probe, Claude Code, ...) through a
# "disclaimer" helper (Contents/Helpers/disclaimer) — a macOS TCC-attribution
# wrapper present in the signed Claude.app but absent from stock Electron. Install an
# absolute symlink to the repository-owned helper on every launch so npm/Electron
# replacement self-heals. The installer migrates only this repository's two known
# passthrough shims and refuses to overwrite anything unexpected.
node scripts/install-disclaimer.mjs 2>&1 | sed 's/^/[run] /'

# Two of the app's bundled helper binaries live in Contents/Helpers of the signed Claude.app
# and simply are not present in a stock Electron bundle, so the features that need them fail
# quietly. Both are already on this machine inside the real install, so link them into the
# paths this build actually looks in. Verified paths, taken from the bundle's own resolvers:
#
#   chrome-native-host  isPackaged ? <exe>/../Helpers/chrome-native-host
#                                  : <appPath>/../../packages/desktop/chrome-native-host/artifacts/
#   claude-ios-sim      isPackaged ? <resources>/../Helpers/Claude iOS Sim.app/...
#                                  : <appPath>/../../packages/desktop/claude-ios-sim/build/bin/...
#
# getAppPath() here is <electron>/Contents/Resources/app.asar, so ../../ is Contents/ — which is
# exactly the path the log complained about:
#   [Chrome Extension MCP] Skipping native host setup: binary not found at …/Contents/packages/…
REAL_HELPERS="$HOME/Applications/Claude.app/Contents/Helpers"
[ -d "$REAL_HELPERS" ] || REAL_HELPERS="/Applications/Claude.app/Contents/Helpers"
if [ -d "$REAL_HELPERS" ]; then
  CONTENTS="node_modules/electron/dist/Electron.app/Contents"
  if [ -x "$REAL_HELPERS/chrome-native-host" ]; then
    CNH_DIR="$CONTENTS/packages/desktop/chrome-native-host/artifacts"
    if [ ! -e "$CNH_DIR/chrome-native-host" ]; then
      mkdir -p "$CNH_DIR"
      ln -sfn "$REAL_HELPERS/chrome-native-host" "$CNH_DIR/chrome-native-host"
      echo "[run] linked chrome-native-host from the real install (Chrome extension bridge)"
    fi
  fi
  if [ -d "$REAL_HELPERS/Claude iOS Sim.app" ]; then
    SIM_DIR="$CONTENTS/packages/desktop/claude-ios-sim/build/bin"
    if [ ! -e "$SIM_DIR/Claude iOS Sim.app" ]; then
      mkdir -p "$SIM_DIR"
      ln -sfn "$REAL_HELPERS/Claude iOS Sim.app" "$SIM_DIR/Claude iOS Sim.app"
      echo "[run] linked Claude iOS Sim.app from the real install (iOS Simulator support)"
    fi
  fi
fi

# ---------------------------------------------------------------------------------------
# Provider selection (.provider dot file, or PROVIDER=… for one launch).
#
#   proxy      -> start the translation proxy (Anthropic Messages API in, OpenAI out) and point the
#                 agent at it. Which upstream backs the DEFAULT (un-picked) turns, the classifier and
#                 compaction is DEFAULT_PROVIDER below; a single turn can still route to any other
#                 provider you hold a key for by picking a "<provider>:<model>" from the Code-tab
#                 dropdown (the proxy routes that turn to the named provider's key).
#   anthropic  -> stock behaviour: the agent calls Anthropic directly with Claude
#
#   DEFAULT_PROVIDER (proxy mode only): openai | local | openrouter | cohere | gemini | mistral
#     openai     -> api.openai.com (model in .openai-model, key in .openai-key)
#     local      -> an on-device OpenAI-compatible server (Ollama by default) on THIS machine's GPU,
#                   no API key; endpoint/model in .local-model
#     openrouter -> OpenRouter (openrouter.ai), any model it serves; model in .openrouter-model, sk-or- key in .openai-key
#     cohere     -> Cohere's OpenAI-compatible endpoint; model in .cohere-model, Cohere key in .openai-key
#     gemini     -> Google Gemini's OpenAI-compatible endpoint; model in .gemini-model, Gemini key in .openai-key
#     mistral    -> Mistral's OpenAI-compatible endpoint; model in .mistral-model, Mistral key in .openai-key
#     groq       -> Groq's OpenAI-compatible endpoint (fast LPU inference, serves /responses); model in
#                   .groq-model, Groq key in .openai-key
#     ollama     -> Ollama Cloud (ollama.com) remote hosted models (serves /responses); model in
#                   .ollama-model, Ollama key in .openai-key. (DISTINCT from `local` = on-device Ollama.)
#
# Only the agent sub-layer is affected either way; the chat window is remote claude.ai.
# The bundle patches read PROXY_ANTHROPIC_BASE_URL, so leaving it unset restores the
# app's own Anthropic host — nothing needs un-patching for anthropic mode.
PROVIDER="${PROVIDER:-$(sed -n 's/^PROVIDER=//p' .provider 2>/dev/null | head -1)}"
PROVIDER="${PROVIDER:-proxy}"
DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-$(sed -n 's/^DEFAULT_PROVIDER=//p' .provider 2>/dev/null | head -1)}"
# Back-compat: the five non-anthropic modes were merged into one `proxy` mode with a configurable
# DEFAULT_PROVIDER. An old PROVIDER value (in .provider, or `PROVIDER=cohere ./run.sh`) still works —
# it selects proxy mode with that provider as the default upstream.
case "$PROVIDER" in
  openai|local|openrouter|cohere|gemini|mistral|groq|ollama) DEFAULT_PROVIDER="$PROVIDER"; PROVIDER="proxy" ;;
esac
DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-openai}"
case "$PROVIDER" in
  proxy|anthropic) ;;
  *) echo "[run] unknown PROVIDER='$PROVIDER' (expected proxy|anthropic)"; exit 1 ;;
esac
case "$DEFAULT_PROVIDER" in
  openai|local|openrouter|cohere|gemini|mistral|groq|ollama) ;;
  *) echo "[run] unknown DEFAULT_PROVIDER='$DEFAULT_PROVIDER' (expected openai|local|openrouter|cohere|gemini|mistral|groq|ollama)"; exit 1 ;;
esac
if [ "$PROVIDER" = "proxy" ]; then
  echo "[run] provider: proxy (default upstream: $DEFAULT_PROVIDER)"
else
  echo "[run] provider: $PROVIDER"
fi

# This packaged app resolves its pinned Claude Code executable from app resources or
# user-data/claude-code/<version>; its dormant CLAUDE_CODE_LOCAL_BINARY initializer is never
# called. Do not advertise a standalone `claude` that Electron will not actually launch.
# The model-aware disclaimer helper recognizes every pinned version under this profile.
unset CLAUDE_CODE_LOCAL_BINARY
echo "[run] Claude Code executable: bundled/cache under $PWD/user-data/claude-code"

# Maximum reasoning by default on the ANTHROPIC/Claude-CLI side. This is a different knob
# from the proxy's OPENAI_REASONING_EFFORT: the app reads CLAUDE_CODE_EFFORT_LEVEL in its own
# getDefaultEffort() —
#   loadUserEnvVars().CLAUDE_CODE_EFFORT_LEVEL ?? process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null
# — so this sets the default effort for NEW sessions. `max` is the app's own top value (56 of
# the synced sessions already use it). Exported in BOTH provider modes because it belongs to
# the app and the CLI, not to OpenAI.
#
# Not used: MAX_THINKING_TOKENS / thinking.budget_tokens. The CLI's own migration notes call
# that deprecated — "budget_tokens -> migrate to adaptive thinking on Opus 4.6 / Sonnet 4.6
# (still functional but deprecated)" — and effort level is the current mechanism.
# The client enforces its own per-response ceiling and says so when exceeded: "Claude's
# response exceeded the 64000 output token maximum. To configure this behavior, set the
# CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable." (issue #8). Set it explicitly so the
# limit is visible rather than implicit; the proxy keeps its spliced continuations below it via
# OPENAI_MAX_TURN_OUTPUT_TOKENS.
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-64000}"
export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-max}"
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT="${CLAUDE_CODE_ALWAYS_ENABLE_EFFORT:-1}"
echo "[run] CLAUDE_CODE_EFFORT_LEVEL=${CLAUDE_CODE_EFFORT_LEVEL} (always-enable=${CLAUDE_CODE_ALWAYS_ENABLE_EFFORT})"

# Diagnostics (.diagnostics dot file, edited by the settings window): the app's log level and the
# proxy's per-request tool dump. Both are read here and exported into the launch environment — the
# app reads DESKTOP_LOG_LEVEL, the proxy reads PROXY_DUMP_TOOLS (it inherits this env). An unset or
# blank value leaves the built-in default in place.
DESKTOP_LOG_LEVEL_VAL=$(sed -n 's/^DESKTOP_LOG_LEVEL=//p' .diagnostics 2>/dev/null | head -1)
[ -n "${DESKTOP_LOG_LEVEL_VAL}" ] && export DESKTOP_LOG_LEVEL="${DESKTOP_LOG_LEVEL_VAL}"
PROXY_DUMP_TOOLS_VAL=$(sed -n 's/^PROXY_DUMP_TOOLS=//p' .diagnostics 2>/dev/null | head -1)
[ "${PROXY_DUMP_TOOLS_VAL}" = "1" ] && export PROXY_DUMP_TOOLS=1
[ -n "${DESKTOP_LOG_LEVEL_VAL}" ] && echo "[run] DESKTOP_LOG_LEVEL=${DESKTOP_LOG_LEVEL_VAL}${PROXY_DUMP_TOOLS:+, PROXY_DUMP_TOOLS=1}"
# Ultracode default: force every Code-tab session into ultracode (xhigh effort + standing dynamic-
# workflow orchestration). There is no CLAUDE_CODE_* env hook for it, so the patched session-start
# settings-spread (app/.vite/build/index.chunk-DT0P6tKR.js) injects ultracode:true into the SDK query
# settings when LLMD_ULTRACODE=1 is in the app's environment. Toggled from the settings window.
ULTRACODE_DEFAULT_VAL=$(sed -n 's/^ULTRACODE_DEFAULT=//p' .diagnostics 2>/dev/null | head -1)
[ "${ULTRACODE_DEFAULT_VAL}" = "1" ] && export LLMD_ULTRACODE=1
[ -n "${LLMD_ULTRACODE:-}" ] && echo "[run] ULTRACODE default: ON — every Code-tab session runs in ultracode"

# Bring up a run.sh-managed Ollama on a side port with a big context and GPU tuning, sharing the
# system Ollama's models. Non-destructive by design: a system Ollama is usually pinned to a small
# context by its service unit and can't be rebound without root, so instead of fighting it we run
# our OWN second instance on OLLAMA_MANAGED_PORT with the context + tuning the agent needs. Reuses
# an already-running managed instance when its context still matches; restarts it when it changed.
# The tuning defaults matter on a laptop GPU: q8_0 KV cache roughly halves the context's VRAM,
# flash attention cuts memory further, and NUM_PARALLEL=1 gives the FULL context to the single
# agent request instead of Ollama splitting it across parallel slots.
#   ensure_ollama <port> <context-tokens> <models-dir-or-empty>
ensure_ollama() {
  local port="$1" ctx="$2" models_dir="$3"
  local baseu="http://127.0.0.1:${port}"
  local statefile="$PWD/user-data/ollama-managed"       # "<pid> <ctx>" of the instance we own
  local logfile="$PWD/user-data/ollama-managed.log"
  mkdir -p "$PWD/user-data"

  if [ -f "$statefile" ]; then
    local old_pid old_ctx
    read -r old_pid old_ctx < "$statefile" || true
    if [ -n "${old_pid:-}" ] && kill -0 "$old_pid" 2>/dev/null; then
      if [ "${old_ctx:-}" = "$ctx" ] && curl -sf --max-time 2 "${baseu}/api/version" >/dev/null 2>&1; then
        echo "[run] managed Ollama: reusing pid ${old_pid} on 127.0.0.1:${port} (context ${ctx})"
        return 0
      fi
      echo "[run] managed Ollama: context ${old_ctx:-?} -> ${ctx}; restarting"
      kill "$old_pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do if ! kill -0 "$old_pid" 2>/dev/null; then break; fi; sleep 1; done
    fi
  fi

  # Never stomp a foreign listener already on the port.
  if curl -sf --max-time 2 "${baseu}/api/version" >/dev/null 2>&1; then
    echo "[run] managed Ollama: 127.0.0.1:${port} already answering but not ours — using it as-is"
    return 0
  fi

  echo "[run] managed Ollama: starting on 127.0.0.1:${port} (context ${ctx}, kv ${OLLAMA_KV_CACHE_TYPE:-q8_0}, flash ${OLLAMA_FLASH_ATTENTION:-1}, parallel ${OLLAMA_NUM_PARALLEL:-1})"
  (
    export OLLAMA_HOST="127.0.0.1:${port}"
    if [ -n "$models_dir" ]; then export OLLAMA_MODELS="$models_dir"; fi
    export OLLAMA_CONTEXT_LENGTH="$ctx"
    export OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-q8_0}"
    export OLLAMA_FLASH_ATTENTION="${OLLAMA_FLASH_ATTENTION:-1}"
    export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
    export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
    nohup ollama serve > "$logfile" 2>&1 &
    echo "$! $ctx" > "$statefile"
  )
  local new_pid; read -r new_pid _ < "$statefile"
  local i
  for i in $(seq 1 30); do
    if curl -sf --max-time 2 "${baseu}/api/version" >/dev/null 2>&1; then
      echo "[run] managed Ollama: ready after ${i}s (pid ${new_pid})"; return 0
    fi
    if ! kill -0 "$new_pid" 2>/dev/null; then echo "[run] managed Ollama: FAILED to start — see ${logfile}"; return 1; fi
    sleep 1
  done
  echo "[run] managed Ollama: not ready in 30s — see ${logfile}"; return 1
}

# Evict every model resident in the managed Ollama so its VRAM is freed. keep_alive:0 unloads
# the model without stopping the server. Armed on an EXIT trap once the managed instance is up,
# so it fires when the app quits or is killed (run.sh does not exec, so it survives the app).
# No-ops when nothing answers the managed port (openai/anthropic modes, or Ollama already gone).
unload_managed_ollama() {
  local port="${OLLAMA_MANAGED_PORT:-11435}" m
  curl -sf --max-time 2 "http://127.0.0.1:${port}/api/version" >/dev/null 2>&1 || return 0
  for m in $(curl -s --max-time 3 "http://127.0.0.1:${port}/api/ps" 2>/dev/null \
             | grep -oE '"model":"[^"]+"' | sed 's/.*"model":"//; s/"$//' | sort -u); do
    echo "[run] unloading Ollama model ${m} from 127.0.0.1:${port}"
    curl -s --max-time 8 "http://127.0.0.1:${port}/api/generate" \
      -d "{\"model\":\"${m}\",\"keep_alive\":0}" >/dev/null 2>&1 || true
  done
}

if [ "$PROVIDER" = "proxy" ]; then
  PORT="${PORT:-8123}"
  PROXY_URL="http://127.0.0.1:${PORT}"

  # `local` provider: the SAME translation proxy, pointed at an on-device OpenAI-compatible
  # server (Ollama by default) instead of api.openai.com, so the agent runs on this machine's
  # GPU. Read the endpoint/model from .local-model and export them as OPENAI_* env vars, which
  # outrank .openai-model in the proxy's precedence — so ensure-proxy's config hash AND the
  # proxy both target the local server. No API key needed: the proxy treats a loopback
  # OPENAI_BASE_URL as keyless. Everything downstream (proxy start, PROXY_ANTHROPIC_BASE_URL,
  # the Claude Code identity) is shared with openai mode below; only CONF differs.
  CONF=".openai-model"
  if [ "$DEFAULT_PROVIDER" = "local" ]; then
    CONF=".local-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-qwen2.5:7b-instruct}"
    # OpenAI surface for the local server. Default chat/completions: every local server has it,
    # and its 128-tool cap helps a small model fit its context. Recent Ollama also serves
    # /responses — set OPENAI_API=responses in .local-model to use it.
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-chat}"

    # Per-model context (tokens). Drives BOTH the managed Ollama window AND the compaction window
    # below, so both track the model — different models have different context windows, and a
    # fixed compaction window would be wrong for all but one of them. Resolution: CONTEXT_<model>
    # if present, else the OLLAMA_CONTEXT_LENGTH default, else 32768. COMPACT_<model> optionally
    # overrides just the compaction window (otherwise it is derived from the context).
    if [ -z "${OLLAMA_CONTEXT_LENGTH:-}" ]; then OLLAMA_CONTEXT_LENGTH="$(sed -n 's/^OLLAMA_CONTEXT_LENGTH=//p' "$CONF" 2>/dev/null | head -1)"; fi
    DESIRED_CTX=""
    while IFS='=' read -r k v; do
      if [ "${k#CONTEXT_}" = "$OPENAI_MODEL" ]; then DESIRED_CTX="$v"; fi
    done < <(grep -E '^CONTEXT_' "$CONF" 2>/dev/null)
    DESIRED_CTX="${DESIRED_CTX:-${OLLAMA_CONTEXT_LENGTH:-32768}}"
    DESIRED_COMPACT=""
    while IFS='=' read -r k v; do
      if [ "${k#COMPACT_}" = "$OPENAI_MODEL" ]; then DESIRED_COMPACT="$v"; fi
    done < <(grep -E '^COMPACT_' "$CONF" 2>/dev/null)

    # Managed on-device Ollama (default on). Give the agent a big context the system Ollama
    # usually caps. Tuning knobs come from .local-model (env wins).
    OLLAMA_AUTOSTART="${OLLAMA_AUTOSTART:-$(sed -n 's/^OLLAMA_AUTOSTART=//p' "$CONF" 2>/dev/null | head -1)}"
    if [ "${OLLAMA_AUTOSTART:-1}" != "0" ] && command -v ollama >/dev/null 2>&1; then
      for k in OLLAMA_MANAGED_PORT OLLAMA_KV_CACHE_TYPE OLLAMA_FLASH_ATTENTION OLLAMA_NUM_PARALLEL OLLAMA_KEEP_ALIVE OLLAMA_MODELS; do
        if [ -z "${!k:-}" ]; then
          fv="$(sed -n "s/^${k}=//p" "$CONF" 2>/dev/null | head -1)"
          if [ -n "$fv" ]; then export "$k=$fv"; fi
        fi
      done
      # Models dir: explicit OLLAMA_MODELS, else the system Ollama's store if we can read it
      # (so models pulled via the normal `ollama` CLI are shared with our instance).
      MODELS_DIR="${OLLAMA_MODELS:-}"
      if [ -z "$MODELS_DIR" ] && [ -r /usr/share/ollama/.ollama/models ]; then MODELS_DIR=/usr/share/ollama/.ollama/models; fi
      if ensure_ollama "${OLLAMA_MANAGED_PORT:-11435}" "$DESIRED_CTX" "$MODELS_DIR"; then
        export OPENAI_BASE_URL="http://127.0.0.1:${OLLAMA_MANAGED_PORT:-11435}/v1"
        # Free the model's VRAM when this launcher exits (app quit or killed).
        trap unload_managed_ollama EXIT
      else
        echo "[run] managed Ollama unavailable; falling back to OPENAI_BASE_URL from .local-model"
      fi
    fi

    # Endpoint the proxy talks to: the managed instance above, or the configured/default server
    # when OLLAMA_AUTOSTART=0 (you run and size it yourself).
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(sed -n 's/^OPENAI_BASE_URL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:11434/v1}"
    echo "[run] local model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (on-device, api ${OPENAI_API}, no key)"
    if ! curl -sf --max-time 3 "${OPENAI_BASE_URL%/}/models" >/dev/null 2>&1; then
      echo "[run] WARNING: no OpenAI-compatible server answered at ${OPENAI_BASE_URL}"
      echo "[run]          is ollama installed and is '${OPENAI_MODEL}' pulled? ('ollama pull ${OPENAI_MODEL}')"
    fi
  fi

  # `openrouter` provider: the SAME translation proxy, pointed at OpenRouter's OpenAI-compatible
  # gateway instead of api.openai.com. Reads model/api from .openrouter-model; the base URL is
  # fixed; the sk-or- key resolves from .openai-key (the proxy's keyfile source) — NOT handled here.
  if [ "$DEFAULT_PROVIDER" = "openrouter" ]; then
    CONF=".openrouter-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-poolside/laguna-s-2.1:free}"
    # Chat Completions by default (broadest model coverage). OpenRouter also serves a stateless
    # /responses — set OPENAI_API=responses in .openrouter-model to use it (avoids the 128-tool cap).
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-chat}"
    export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
    # Optional OpenRouter attribution headers (HTTP-Referer / X-Title). Format: "Key:Value,Key:Value".
    OPENAI_EXTRA_HEADERS_VAL=$(sed -n 's/^OPENAI_EXTRA_HEADERS=//p' "$CONF" 2>/dev/null | head -1)
    [ -n "${OPENAI_EXTRA_HEADERS_VAL}" ] && export OPENAI_EXTRA_HEADERS="${OPENAI_EXTRA_HEADERS_VAL}"
    echo "[run] openrouter model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (api ${OPENAI_API}, key from .openai-key)"
    # The sk-or- key must resolve, from OPENAI_API_KEY in the environment or apiKey= in .openai-key.
    if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qE '^(openrouterApiKey|apiKey)=' .openai-key 2>/dev/null; then
      echo "[run] WARNING: no OpenRouter key found — put 'openrouterApiKey=sk-or-...' (or apiKey=) in .openai-key (cp .openai-key.example .openai-key)"
    fi
  fi

  # `cohere` provider: the SAME translation proxy, pointed at Cohere's OpenAI-compatible endpoint
  # instead of api.openai.com. Reads model/api from .cohere-model; the Cohere key resolves from
  # .openai-key (the proxy's keyfile source) — NOT handled here. Cohere's compatibility API exposes
  # Chat Completions only (no /responses), so api stays chat. Base URL is overridable from CONF for
  # the api.cohere.com alias; it defaults to the confirmed-working api.cohere.ai.
  if [ "$DEFAULT_PROVIDER" = "cohere" ]; then
    CONF=".cohere-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-command-a-03-2025}"
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-chat}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(sed -n 's/^OPENAI_BASE_URL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.cohere.ai/compatibility/v1}"
    echo "[run] cohere model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (api ${OPENAI_API}, key from .openai-key)"
    # The Cohere key must resolve, from OPENAI_API_KEY in the environment or apiKey= in .openai-key.
    if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qE '^(cohereApiKey|apiKey)=' .openai-key 2>/dev/null; then
      echo "[run] WARNING: no Cohere key found — put 'cohereApiKey=<your-cohere-key>' (or apiKey=) in .openai-key (cp .openai-key.example .openai-key)"
    fi
  fi

  # `gemini` provider: the SAME translation proxy, pointed at Google Gemini's OpenAI-compatible
  # endpoint instead of api.openai.com. Reads model/api from .gemini-model; the Gemini (AI Studio) key
  # resolves from .openai-key (the proxy's keyfile source) — NOT handled here. Gemini's compat surface
  # is Chat Completions only (no /responses — it 404s), so api stays chat. Base URL is overridable
  # from CONF but defaults to the v1beta/openai gateway.
  if [ "$DEFAULT_PROVIDER" = "gemini" ]; then
    CONF=".gemini-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-gemini-3-flash-preview}"
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-chat}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(sed -n 's/^OPENAI_BASE_URL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta/openai}"
    echo "[run] gemini model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (api ${OPENAI_API}, key from .openai-key)"
    # The Gemini key must resolve, from OPENAI_API_KEY in the environment or apiKey= in .openai-key.
    if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qE '^(googleApiKey|geminiApiKey|apiKey)=' .openai-key 2>/dev/null; then
      echo "[run] WARNING: no Gemini key found — put 'googleApiKey=<your-gemini-key>' (or apiKey=) in .openai-key (cp .openai-key.example .openai-key)"
    fi
  fi

  # `mistral` provider: the SAME translation proxy, pointed at Mistral's OpenAI-compatible endpoint
  # (api.mistral.ai/v1) instead of api.openai.com. Reads model/api from .mistral-model; the Mistral key
  # resolves from .openai-key (mistralApiKey=). Mistral's compat surface is Chat Completions only (no
  # /responses — it 404s), so api stays chat. Base URL is overridable from CONF but defaults to v1.
  if [ "$DEFAULT_PROVIDER" = "mistral" ]; then
    CONF=".mistral-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-mistral-large-latest}"
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-chat}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(sed -n 's/^OPENAI_BASE_URL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.mistral.ai/v1}"
    echo "[run] mistral model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (api ${OPENAI_API}, key from .openai-key)"
    if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qE '^(mistralApiKey|apiKey)=' .openai-key 2>/dev/null; then
      echo "[run] WARNING: no Mistral key found — put 'mistralApiKey=<your-mistral-key>' (or apiKey=) in .openai-key (cp .openai-key.example .openai-key)"
    fi
  fi

  # `groq` provider: the SAME translation proxy, pointed at Groq's OpenAI-compatible endpoint
  # (api.groq.com/openai/v1) — fast LPU inference, NOT xAI's Grok. Reads model/api from .groq-model; the
  # Groq key resolves from .openai-key (groqApiKey=). Groq serves BOTH /chat/completions and /responses,
  # so api defaults to responses (no 128-tool cap, reasoning). Base URL overridable from CONF.
  if [ "$DEFAULT_PROVIDER" = "groq" ]; then
    CONF=".groq-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-openai/gpt-oss-120b}"
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-responses}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(sed -n 's/^OPENAI_BASE_URL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.groq.com/openai/v1}"
    echo "[run] groq model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (api ${OPENAI_API}, key from .openai-key)"
    if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qE '^(groqApiKey|grokApiKey|apiKey)=' .openai-key 2>/dev/null; then
      echo "[run] WARNING: no Groq key found — put 'groqApiKey=<your-groq-key>' (or apiKey=) in .openai-key (cp .openai-key.example .openai-key)"
    fi
  fi

  # `ollama` provider: the SAME translation proxy, pointed at Ollama Cloud (ollama.com/v1) — REMOTE hosted
  # models, keyed. DISTINCT from `local` (on-device Ollama, keyless, loopback). Reads model/api from
  # .ollama-model; the Ollama key resolves from .openai-key (ollamaApiKey=). Serves /responses, so api
  # defaults to responses.
  if [ "$DEFAULT_PROVIDER" = "ollama" ]; then
    CONF=".ollama-model"
    export OPENAI_MODEL="${OPENAI_MODEL:-$(sed -n 's/^OPENAI_MODEL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_MODEL="${OPENAI_MODEL:-gpt-oss:120b}"
    export OPENAI_API="${OPENAI_API:-$(sed -n 's/^OPENAI_API=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_API="${OPENAI_API:-responses}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(sed -n 's/^OPENAI_BASE_URL=//p' "$CONF" 2>/dev/null | head -1)}"
    export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://ollama.com/v1}"
    echo "[run] ollama-cloud model: ${OPENAI_MODEL} via ${OPENAI_BASE_URL} (api ${OPENAI_API}, key from .openai-key)"
    if [ -z "${OPENAI_API_KEY:-}" ] && ! grep -qE '^(ollamaApiKey|apiKey)=' .openai-key 2>/dev/null; then
      echo "[run] WARNING: no Ollama Cloud key found — put 'ollamaApiKey=<your-ollama-key>' (or apiKey=) in .openai-key (cp .openai-key.example .openai-key)"
    fi
  fi

  # Local thinking models for the Code-tab dropdown. The picker is fed by the app bootstrap (the
  # renderer-unlock preload injects the model list), not by the proxy's /v1/models, and that sandboxed
  # preload cannot fetch localhost itself (claude.ai CORS/CSP). So discover the on-device Ollama
  # thinking models here and hand them to the page through the app environment: the preload reads
  # LLMD_LOCAL_MODELS (a JSON list) and injects them, and the proxy routes a picked "local:<model>" to
  # LLMD_LOCAL_BASE (the reachable Ollama /v1). Best-effort — empty when no Ollama or no thinking model
  # is installed — and set BEFORE ensure-proxy so a freshly-started proxy inherits the base for routing.
  if command -v node >/dev/null 2>&1; then
    LOCAL_INFO="$(node scripts/local-thinking-models.mjs 2>/dev/null || true)"
    LLMD_LOCAL_BASE_VAL="$(printf '%s\n' "$LOCAL_INFO" | sed -n '1p')"
    LLMD_LOCAL_MODELS_VAL="$(printf '%s\n' "$LOCAL_INFO" | sed -n '2p')"
    if [ -n "$LLMD_LOCAL_BASE_VAL" ] && [ -n "$LLMD_LOCAL_MODELS_VAL" ]; then
      export LLMD_LOCAL_BASE="$LLMD_LOCAL_BASE_VAL"
      export LLMD_LOCAL_MODELS="$LLMD_LOCAL_MODELS_VAL"
      echo "[run] local thinking models for the picker: ${LLMD_LOCAL_MODELS} via ${LLMD_LOCAL_BASE}"
    fi
  fi

  # Composite (fallback) model. OPENAI_COMPOSITE_MODELS (in .openai-model, or the env) is the ordered
  # member list; when non-empty, hand it to the preload as LLMD_COMPOSITE so it injects a "Composite" entry
  # FIRST in the Code-tab dropdown and makes it the default for new sessions. The proxy owns the actual
  # chain + failover (it reads OPENAI_COMPOSITE_MODELS itself); this only drives the picker entry. Built
  # via node to JSON-quote member ids safely (env-passed so members with odd characters can't break it).
  COMPOSITE_MODELS_VAL="${OPENAI_COMPOSITE_MODELS:-$(sed -n 's/^OPENAI_COMPOSITE_MODELS=//p' .openai-model 2>/dev/null | head -1)}"
  if [ -n "$COMPOSITE_MODELS_VAL" ] && command -v node >/dev/null 2>&1; then
    LLMD_COMPOSITE_VAL="$(OPENAI_COMPOSITE_MODELS="$COMPOSITE_MODELS_VAL" node -e 'const m=(process.env.OPENAI_COMPOSITE_MODELS||"").split(",").map(s=>s.trim()).filter(Boolean); if(m.length) process.stdout.write(JSON.stringify({members:m}))' 2>/dev/null || true)"
    if [ -n "$LLMD_COMPOSITE_VAL" ]; then
      export LLMD_COMPOSITE="$LLMD_COMPOSITE_VAL"
      echo "[run] composite model: ${COMPOSITE_MODELS_VAL} (first + default in the Code-tab picker)"
    fi
  fi

  # This used to be `curl -sf /health` — "something answered, good enough". It was not:
  #   * a model change did not take effect, because the OLD proxy answered /health and got
  #     reused while the launcher printed "proxy healthy";
  #   * a foreign listener on the port was indistinguishable from ours;
  #   * a crashed proxy's hand-started replacement ran as PPID 1, so nothing could tell whether
  #     it was ours to restart.
  # ensure-proxy.mjs decides from evidence — an instance nonce for identity, a config hash for
  # equivalence, a code hash for staleness — and starts the SUPERVISOR rather than the proxy, so
  # a crash is followed by a restart instead of by hours of a dead port. Its exit status is the
  # answer; there is no second opinion to take here.
  #
  # NOT piped through sed for a prefix: under a pipeline the exit status belongs to the last
  # command, so `node ... | sed` would report sed's success and the check would never fire. This
  # script does set `pipefail`, which happens to make it work — but a correctness guarantee that
  # depends on a `set` line a hundred lines away is one refactor from being silently wrong.
  if ! node scripts/ensure-proxy.mjs --port "$PORT"; then
    echo "[run] the translation proxy is not serving the configured settings — see the lines above"
    exit 1
  fi
  export PROXY_ANTHROPIC_BASE_URL="${PROXY_URL}"
  echo "[run] PROXY_ANTHROPIC_BASE_URL=${PROXY_ANTHROPIC_BASE_URL}"
  # Claude Code resolves context capacity from its INTERNAL model identity before it
  # normalizes that identity for /v1/messages. The repository helper ignores whichever
  # claude-* identity Desktop selected and gives bundled/cache Claude Code this supported
  # [1m] identity instead. Claude Code then sends claude-opus-4-8 on the wire, which the
  # proxy continues to map to OPENAI_MODEL.
  OPENAI_CLAUDE_CODE_MODEL=$(sed -n 's/^OPENAI_CLAUDE_CODE_MODEL=//p' "$CONF" 2>/dev/null | head -1)
  if [ -z "${OPENAI_CLAUDE_CODE_MODEL:-}" ]; then
    echo "[run] missing OPENAI_CLAUDE_CODE_MODEL in $CONF"
    exit 1
  fi
  export LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL="$OPENAI_CLAUDE_CODE_MODEL"
  echo "[run] Claude Code internal model: ${LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL} (${DEFAULT_PROVIDER} upstream)"
  # Other proxy-mode agent settings (classifier model, gateway model discovery, context cap).
  while IFS='=' read -r k v; do
    case "$k" in CLAUDE_CODE_*) export "$k=$v"; echo "[run] $k=$v" ;; esac
  done < <(grep -E '^CLAUDE_CODE_[A-Z_]+=' "$CONF" 2>/dev/null)
  # Gateway model discovery: let the app populate its model dropdown from the proxy's GET /v1/models,
  # so it lists the models the configured provider(s) actually serve. On in EVERY proxy mode — the loop
  # above only forwards it when it happens to sit in CONF (it lives in .openai-model), so default it on
  # here for local/openrouter/cohere/gemini too. The anthropic branch unsets it.
  export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:-1}"
  echo "[run] CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY}"
  # A local model's compaction window must track its real context: a fixed value can exceed a
  # small model's window (so compaction never fires and the prompt overflows) or waste a big
  # one. Derive it from the per-model context — 3/4, leaving headroom for the tools + reply —
  # unless a per-model COMPACT_<model> or an explicit CLAUDE_CODE_AUTO_COMPACT_WINDOW was given
  # (the latter is exported by the loop above, so gate on it being unset).
  if [ "$DEFAULT_PROVIDER" = "local" ] && [ -z "${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}" ]; then
    export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${DESIRED_COMPACT:-$(( DESIRED_CTX * 3 / 4 ))}"
    echo "[run] CLAUDE_CODE_AUTO_COMPACT_WINDOW=${CLAUDE_CODE_AUTO_COMPACT_WINDOW} (${OPENAI_MODEL}, ${DESIRED_CTX}-token context)"
  fi
else
  # Leave no trace of OpenAI mode in the environment. Unsetting the base URL is what makes
  # the env-gated patches fall back to the app's own Anthropic host.
  unset PROXY_ANTHROPIC_BASE_URL
  unset LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL
  # These carry OpenAI model ids in .openai-model; inherited from a shell they would send
  # e.g. gpt-4.1-mini to Anthropic and simply error, so drop them in this mode.
  for v in CLAUDE_CODE_BG_CLASSIFIER_MODEL CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY; do
    if [ -n "${!v:-}" ]; then echo "[run] unsetting $v (OpenAI-only)"; unset "$v"; fi
  done
  echo "[run] agent calls Anthropic directly with Claude (no proxy)"
fi

# Privacy toggle — read from the .privacy dot file so it applies to BOTH launchers
# (./run.sh and ./run-openai.sh, which execs this). See .privacy for what each lever
# does and ANTHROPIC_ENDPOINTS.md for the traffic it suppresses.
EXTRA=()
DISABLE_TELEMETRY_VAL=$(sed -n 's/^DISABLE_TELEMETRY=//p' .privacy 2>/dev/null | head -1)
# Telemetry is OFF BY DEFAULT. The kill switch engages unless .privacy explicitly opts back IN
# with DISABLE_TELEMETRY=0 — so a missing or blank .privacy still disables telemetry (the same
# default-on-unless-0 shape as .sync), rather than the old behaviour where deleting .privacy
# quietly re-enabled it.
if [ "${DISABLE_TELEMETRY_VAL:-1}" != "0" ]; then
  # 1. The bundled Claude Code agent reads these (its own "no-telemetry" mode).
  export DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  # 2. The desktop shell's OWN telemetry ignores those env vars — it gates on the
  #    managed config Me().telemetry.disable*, settable only via a root-owned MDM
  #    plist. The env-gated patches in app/.vite/build/index.chunk-CnWKsyE_.js read
  #    PRIVACY_DISABLE_TELEMETRY instead and force those gates on: they silence the
  #    [EventLogging] flusher, nonessential services, and Sentry, and cancel
  #    telemetry-path requests (/api/event_logging, the OTLP /v1/logs|traces|metrics
  #    exporter, and a.claude.ai/isolated-segment.html) — these ride first-party or
  #    admin-configured hosts, so they can't be blocked by hostname.
  export PRIVACY_DISABLE_TELEMETRY=1
  # 3. DNS-sinkhole the dedicated third-party telemetry hosts. This is what stops the
  #    remote claude.ai web app's own Datadog RUM / Sentry, which run in the renderer
  #    and don't consult any of the above. Patterns have NO leading dot on purpose:
  #    Datadog intake appears as both "browser-intake-us5-datadoghq.com" and
  #    "logs.browser-intake-us5-datadoghq.com", and "*.datadoghq.com" (literal dot)
  #    or "browser-intake-*" (start-anchored) each miss one form — a verified leak.
  #    Three of these are FIRST-PARTY-PROXIED analytics on anthropic.com subdomains,
  #    which is what defeats a vendor-domain blocklist: the web app loads Segment from
  #    a-cdn.anthropic.com (not cdn.segment.com) and posts events to a-api.anthropic.com
  #    (/v1/b batch, /v1/m), so "*segment.com" never matches. s-cdn.anthropic.com serves
  #    a tracker (/s.js) plus /images/<n>.gif pixel beacons. Verified with --log-net-log.
  #    These MUST be exact hostnames — a "*anthropic.com" pattern would also kill
  #    api.anthropic.com (model inference) and assets-proxy.anthropic.com (the web app's
  #    own JS), breaking the app.
  #    Deliberately NOT blocked: a.claude.ai/cdn-cgi/challenge-platform (Cloudflare bot
  #    management, i.e. security infrastructure — blocking it risks challenges/lockout)
  #    and api.github.com (the app's functional GitHub integration).
  EXTRA+=(--host-resolver-rules="MAP *datadoghq.com ^NOTFOUND,MAP *datadoghq.eu ^NOTFOUND,MAP *ddog-gov.com ^NOTFOUND,MAP *sentry.io ^NOTFOUND,MAP *segment.com ^NOTFOUND,MAP *segment.io ^NOTFOUND,MAP *google-analytics.com ^NOTFOUND,MAP *googletagmanager.com ^NOTFOUND,MAP s-cdn.anthropic.com ^NOTFOUND,MAP a-cdn.anthropic.com ^NOTFOUND,MAP a-api.anthropic.com ^NOTFOUND")
  echo "[run] telemetry DISABLED via .privacy (app EventLogging/Sentry off; datadog/sentry/segment/ga sinkholed)"
fi

# ---- the session store is SHARED, not copied (issue #3) ----
#
# This used to be a one-way `rsync --update` from Claude Desktop into this build's isolated
# profile. That gave sessions created here nowhere to go, so the two stores drifted apart in
# BOTH directions — by the time this changed, 13 sessions existed only in the real install,
# 64 only here, and 15 differed.
#
# So the directory is now literally shared: user-data/claude-code-sessions is a symlink to
# Claude Desktop's store. There is nothing to copy, nothing to merge and nothing to go stale;
# a session created or renamed in either app is immediately the other's too.
#
# Two consequences, both deliberate:
#   * This build now WRITES to the real install's data. The isolation that user-data/ gives
#     everything else no longer applies to this one directory.
#   * Deletion is global. `isArchived` is 0 across every session file on both sides, so the
#     UI removes a session by deleting its file — and it is now one file, not two.
#
# Safe because these are plain per-session JSON files with no lock and no database: both
# sides already use the identical <user>/<org> path, so the link needs no path translation.
# Local Storage canNOT be shared this way — see the UI-state block below.
#
# The agent's memory/config needs no sync at all: both apps resolve CLAUDE_CONFIG_DIR to
# $HOME/.claude and already share it. See .sync for the evidence.
# share_store <dir-name> <find-pattern> <label>
#   <find-pattern> is what counts as "content unique to this build" when deciding whether the
#   private directory can safely be replaced by a link. For the agent-mode store a session is
#   a whole workspace directory, not one json, so it matches every file.
share_store() {
  local name="$1" pattern="$2" label="$3"
  local src="$CLAUDE_SUPPORT/$name"
  local dst="$PWD/user-data/$name"
  if [ ! -d "$src" ]; then
    echo "[run] NOTE: no Claude Desktop $label store at $src — leaving this build's own alone"
  elif [ -L "$dst" ]; then
    # Already shared. Re-point if the target moved, the same way the app.asar symlink self-heals.
    if [ "$(readlink "$dst")" != "$src" ]; then
      ln -sfn "$src" "$dst"
      echo "[run] re-pointed the shared $label store at $src"
    fi
    local n; n=$(find -L "$dst" -name "$pattern" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "[run] ${label}: SHARED with Claude Desktop (${n} files, one copy, writes both ways)"
  elif [ -d "$dst" ]; then
    # A real directory. Replacing it with a link discards whatever it holds, so only do that
    # once nothing here is missing from the target. Never rm -rf a directory with unique data.
    local only_here
    only_here=$( { comm -23 \
        <(cd "$dst" && find . -name "$pattern" -type f 2>/dev/null | sort) \
        <(cd "$src" && find . -name "$pattern" -type f 2>/dev/null | sort) \
        | wc -l | tr -d ' '; } || echo "?" )
    if [ "$only_here" != "0" ]; then
      echo "[run] WARN: user-data/$name still holds ${only_here} file(s) the shared store does not have."
      echo "[run]       Merge them first, then relaunch:"
      echo "[run]         node scripts/merge-sessions.mjs --store $name --dry-run   # inspect"
      echo "[run]         node scripts/merge-sessions.mjs --store $name             # apply"
      echo "[run]       Launching with the private copy for now — nothing was changed."
    else
      local keep="$dst.replaced-$(date +%Y%m%d%H%M%S)"
      mv "$dst" "$keep"
      ln -s "$src" "$dst"
      echo "[run] ${label}: now SHARED with Claude Desktop; the old private copy is at $(basename "$keep")"
    fi
  else
    ln -s "$src" "$dst"
    echo "[run] ${label}: SHARED with Claude Desktop"
  fi
}

SYNC_VAL="${SYNC_CLAUDE_SESSIONS:-$(sed -n 's/^SYNC_CLAUDE_SESSIONS=//p' .sync 2>/dev/null | head -1)}"
if [ "${SYNC_VAL:-1}" != "0" ]; then
  share_store "claude-code-sessions" "local_*.json" "sessions"
  # The cowork / agent-mode store: same <user>/<org> layout, but a session is a whole
  # local_<uuid>/ workspace directory alongside its json, plus the skills-plugin payload and
  # server-refreshed cowork-*-cache.json files. Its .lock files are per-task files inside
  # those workspaces, not a database lock, so sharing is safe the same way.
  share_store "local-agent-mode-sessions" "*" "agent-mode sessions"
  # Installed extensions (DXT / MCP servers). This build reports
  #   isDesktopExtensionEnabled: true, isDesktopExtensionSignatureRequired: false
  #   Extensions: No extensions directory found
  # so nothing blocks them here — the directory simply was never copied, and the install the
  # real app has was invisible. Plain files, so sharing works the same way.
  share_store "Claude Extensions" "*" "extensions"
  share_store "Claude Extensions Settings" "*" "extension settings"
fi

# ---- claude.ai SIDEBAR GROUPING, merged both ways (issue #3) ----
# Sessions alone are not enough to make the sidebar look like Claude Desktop's. The groups, and
# which session belongs to which group, live in the claude.ai origin's Local Storage under
# LSS-persisted.dframe-group-scopes — ids like cg-<uuid> with names, an `assignments` map and a
# per-group `order`, alongside the groupBy mode in dframe-store. None of that is in the session
# files: their 555 distinct key paths contain no group field at all, only the unrelated
# chromeTabGroupId. So sessions were shared while the state that groups them was not.
#
# Local Storage cannot be symlinked the way the session store above is: LevelDB allows exactly
# one process at a time (each app holds an exclusive fcntl(F_WRLCK) on its LOCK file while it
# runs, verified with F_GETLK), so the second app to start could not open it at all.
#
# This used to be a whole-directory copy, which was wrong twice over. It replaced all ~371 of the
# destination's claude.ai keys to fix 3 — hence its default-off knob — and being one-way it threw
# away whatever the destination had done itself; both profiles held groups and assignments the
# other lacked. scripts/sync-grouping.mjs instead merges the union of the two, key by key, and
# writes only the profiles whose app is closed. At this point in the launch that is always at
# least this build, and Claude Desktop too if it happens to be shut.
SYNC_GROUPING="${SYNC_CLAUDE_GROUPING:-$(sed -n 's/^SYNC_CLAUDE_GROUPING=//p' .sync 2>/dev/null | head -1)}"
if [ "${SYNC_GROUPING:-1}" != "0" ] && command -v node >/dev/null 2>&1; then
  node scripts/sync-grouping.mjs --launch 2>&1 | sed 's/^/[run] /'
fi

# Not `exec`. Replacing the shell would leave no way to do anything after the app quits, and
# the one moment a Local Storage write-back is possible is exactly when the app has released
# its LevelDB lock. Sessions need no write-back at all now that the directory is shared.
"$ELECTRON" app \
  --user-data-dir="$PWD/user-data" \
  --enable-logging \
  "${EXTRA[@]+"${EXTRA[@]}"}" \
  "$@"
STATUS=$?

# Push grouping changes made in this session back out. This is the reason the launch does not
# `exec`: the build's LevelDB lock is only free once the app has quit, so this is the one moment
# a write to it is possible — and the merge is symmetric, so if Claude Desktop is closed too it
# receives everything done here. If it is open, the write is skipped and the next launch does it.
if [ "${SYNC_GROUPING:-1}" != "0" ] && command -v node >/dev/null 2>&1; then
  node scripts/sync-grouping.mjs --launch 2>&1 | sed 's/^/[run] /'
fi

echo "[run] app exited (status ${STATUS})"
exit "$STATUS"
