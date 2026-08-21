#!/usr/bin/env bash
#
# Launch with the agent sub-layer routed to Cohere (api.cohere.ai/compatibility/v1) via the
# Anthropic->OpenAI translation proxy. Thin wrapper: all the logic lives in run.sh, selected by
# PROVIDER. Configure the model in .cohere-model and put your Cohere key in .openai-key.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=cohere exec ./run.sh "$@"
