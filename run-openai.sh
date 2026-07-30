#!/usr/bin/env bash
#
# Launch with the agent sub-layer routed through the Anthropic->OpenAI translation proxy.
# Thin wrapper: all the logic lives in run.sh, selected by PROVIDER. See .provider.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=openai exec ./run.sh "$@"
