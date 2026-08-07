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
#   openai     -> start the translation proxy and point the agent at it
#   anthropic  -> stock behaviour: the agent calls Anthropic directly with Claude
#
# Only the agent sub-layer is affected either way; the chat window is remote claude.ai.
# The bundle patches read PROXY_ANTHROPIC_BASE_URL, so leaving it unset restores the
# app's own Anthropic host — nothing needs un-patching for anthropic mode.
PROVIDER="${PROVIDER:-$(sed -n 's/^PROVIDER=//p' .provider 2>/dev/null | head -1)}"
PROVIDER="${PROVIDER:-openai}"
case "$PROVIDER" in
  openai|anthropic) ;;
  *) echo "[run] unknown PROVIDER='$PROVIDER' (expected openai|anthropic)"; exit 1 ;;
esac
echo "[run] provider: $PROVIDER"

# The app pins an RC Claude Code build whose download URL is not publicly fetchable, so it
# reports "binary missing or damaged". Point it at a locally-installed `claude`. This is
# provider-independent — it is about fetching the binary, not about which model answers.
if [ -z "${CLAUDE_CODE_LOCAL_BINARY:-}" ]; then
  CLAUDE_BIN="$(command -v claude || true)"
  [ -n "$CLAUDE_BIN" ] && export CLAUDE_CODE_LOCAL_BINARY="$CLAUDE_BIN"
fi
if [ -n "${CLAUDE_CODE_LOCAL_BINARY:-}" ]; then
  echo "[run] CLAUDE_CODE_LOCAL_BINARY=${CLAUDE_CODE_LOCAL_BINARY}"
else
  echo "[run] WARN: no 'claude' on PATH — the app will try to download its own agent binary"
fi

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

if [ "$PROVIDER" = "openai" ]; then
  PORT="${PORT:-8123}"
  PROXY_URL="http://127.0.0.1:${PORT}"
  if ! curl -sf "${PROXY_URL}/health" >/dev/null 2>&1; then
    echo "[run] starting translation proxy on ${PROXY_URL}"
    # APPEND, and rotate at 8MB. This used to be `> proxy.log`, which truncated the log on
    # every launch — so by the time a bug was reported the evidence for it was already gone.
    # That is exactly what happened with the auto-mode classifier failure in issue #6.
    # `if`, not `&&`: a false test as the last command of an && list returns non-zero, which
    # under `set -e` would kill the subshell before the proxy ever started.
    ( cd openai-proxy || exit 1
      if [ -f proxy.log ] && [ "$(wc -c < proxy.log)" -gt 8388608 ]; then mv -f proxy.log proxy.log.1; fi
      PORT="$PORT" nohup node proxy.mjs >> proxy.log 2>&1 & disown )
    for _ in $(seq 1 10); do curl -sf "${PROXY_URL}/health" >/dev/null 2>&1 && break; sleep 1; done
  fi
  curl -sf "${PROXY_URL}/health" >/dev/null 2>&1 \
    && echo "[run] proxy healthy: $(curl -s ${PROXY_URL}/health)" \
    || { echo "[run] proxy failed to start — see openai-proxy/proxy.log"; exit 1; }
  export PROXY_ANTHROPIC_BASE_URL="${PROXY_URL}"
  echo "[run] PROXY_ANTHROPIC_BASE_URL=${PROXY_ANTHROPIC_BASE_URL}"
  # OpenAI-only agent settings (classifier model, gateway model discovery for the picker).
  while IFS='=' read -r k v; do
    case "$k" in CLAUDE_CODE_*) export "$k=$v"; echo "[run] $k=$v" ;; esac
  done < <(grep -E '^CLAUDE_CODE_[A-Z_]+=' .openai-model 2>/dev/null)
else
  # Leave no trace of OpenAI mode in the environment. Unsetting the base URL is what makes
  # the env-gated patches fall back to the app's own Anthropic host.
  unset PROXY_ANTHROPIC_BASE_URL
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
if [ -n "${DISABLE_TELEMETRY_VAL:-}" ] && [ "${DISABLE_TELEMETRY_VAL}" != "0" ]; then
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
  local src="$HOME/Library/Application Support/Claude/$name"
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

SYNC_VAL=$(sed -n 's/^SYNC_CLAUDE_SESSIONS=//p' .sync 2>/dev/null | head -1)
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

  # ---- claude.ai UI state, which is where GROUPING lives (issue #3) ----
  # Sessions alone are not enough to make the sidebar look like Claude Desktop's. Group
  # definitions live in the claude.ai origin's Local Storage under
  # LSS-persisted.dframe-group-scopes (ids like cg-<uuid> with names, e.g. "App Analysis"),
  # alongside the groupBy mode ("custom"). None of that is in the session files — their 555
  # distinct key paths contain no group field at all, only chromeTabGroupId, which is
  # unrelated. So sessions were being refreshed every launch while the state that groups them
  # was copied once by hand and then went stale.
  #
  # This is a whole-directory copy because there is no way to write individual keys into a
  # Chromium LevelDB without a LevelDB library. That makes the guards below load-bearing.
  #
  # And it is a COPY rather than a symlink — unlike the sessions above — because LevelDB
  # allows exactly one process at a time. Both databases hold an exclusive whole-file
  # fcntl(F_WRLCK) on their LOCK file while their app runs, verified with F_GETLK. Point two
  # apps at one directory and the second to start cannot open its Local Storage at all. A
  # native binding does not help: it takes the same lock on the same inode.
  #
  # NOTE this block is deliberately OUTSIDE the session gate. It used to be nested inside it,
  # so SYNC_CLAUDE_UI_STATE=1 silently did nothing whenever SYNC_CLAUDE_SESSIONS was 0.
  SYNC_UI_VAL=$(sed -n 's/^SYNC_CLAUDE_UI_STATE=//p' .sync 2>/dev/null | head -1)
  if [ -n "${SYNC_UI_VAL:-}" ] && [ "${SYNC_UI_VAL}" != "0" ]; then
    SRC_LS="$HOME/Library/Application Support/Claude/Local Storage"
    DST_LS="$PWD/user-data/Local Storage"
    if pgrep -f "/Claude.app/Contents/MacOS/Claude" >/dev/null 2>&1; then
      # Copying an open LevelDB can capture a torn write and leave the destination unreadable,
      # which would lose this build's own UI state for no gain.
      echo "[run] NOTE: Claude Desktop is running — skipping UI-state sync. Quit it and relaunch to pick up grouping changes."
    elif [ -d "$SRC_LS" ]; then
      if [ -d "$DST_LS" ]; then
        rm -rf "$DST_LS.bak"
        cp -R "$DST_LS" "$DST_LS.bak"
      fi
      if rsync -a --delete "$SRC_LS/" "$DST_LS/" 2>/dev/null; then
        # Verify the copy actually carries the grouping keys; restore the backup if not.
        if grep -raq "dframe-group-scopes" "$DST_LS" 2>/dev/null; then
          groups=$(grep -raoh "cg-[0-9a-f-]\{36\}" "$DST_LS" 2>/dev/null | sort -u | wc -l | tr -d ' ')
          echo "[run] synced claude.ai UI state (grouping): ${groups} group definition(s); previous state kept at Local Storage.bak"
        else
          echo "[run] WARN: copied UI state has no grouping keys — restoring the previous state"
          rm -rf "$DST_LS"; [ -d "$DST_LS.bak" ] && cp -R "$DST_LS.bak" "$DST_LS"
        fi
      else
        echo "[run] WARN: UI-state sync failed — leaving this build's state untouched"
      fi
    fi
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

echo "[run] app exited (status ${STATUS})"
exit "$STATUS"
