#!/usr/bin/env bash
#
# Launch with the agent sub-layer calling Anthropic directly with Claude — the stock
# behaviour of the shipped app. No proxy, no OpenAI settings.
# Thin wrapper: all the logic lives in run.sh, selected by PROVIDER. See .provider.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=anthropic exec ./run.sh "$@"
