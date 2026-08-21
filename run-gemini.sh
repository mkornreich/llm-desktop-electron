#!/usr/bin/env bash
#
# Launch with the agent sub-layer routed to Google Gemini (generativelanguage.googleapis.com) via the
# Anthropic->OpenAI translation proxy. Thin wrapper: all the logic lives in run.sh, selected by
# PROVIDER. Configure the model in .gemini-model and put your Gemini key in .openai-key.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=gemini exec ./run.sh "$@"
