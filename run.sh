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

exec "$ELECTRON" app \
  --user-data-dir="$PWD/user-data" \
  --enable-logging \
  "${EXTRA[@]+"${EXTRA[@]}"}" \
  "$@"
