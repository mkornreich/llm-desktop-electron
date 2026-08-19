#!/usr/bin/env bash
#
# Launch with the agent sub-layer routed to a local, on-device model running on this machine's
# GPU (via the Anthropic->OpenAI translation proxy pointed at a local OpenAI-compatible server,
# Ollama by default). Thin wrapper: all the logic lives in run.sh, selected by PROVIDER.
# Configure the endpoint/model in .local-model.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=local exec ./run.sh "$@"
