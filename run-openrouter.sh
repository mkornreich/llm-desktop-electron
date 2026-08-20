#!/usr/bin/env bash
#
# Launch with the agent sub-layer routed to OpenRouter (openrouter.ai) via the Anthropic->OpenAI
# translation proxy. Thin wrapper: all the logic lives in run.sh, selected by PROVIDER. Configure
# the model in .openrouter-model and put your sk-or- key in .openai-key.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=openrouter exec ./run.sh "$@"
