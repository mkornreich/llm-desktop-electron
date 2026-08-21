#!/usr/bin/env bash
#
# Launch with the agent sub-layer routed through the Anthropic->OpenAI translation proxy.
# Which upstream backs the default turns is DEFAULT_PROVIDER (openai/local/openrouter/cohere/gemini)
# in .provider; each turn can still be routed to any provider you hold a key for by picking a
# "<provider>:<model>" from the Code-tab model dropdown. Thin wrapper: all the logic lives in run.sh,
# selected by PROVIDER. See .provider.
set -euo pipefail
cd "$(dirname "$0")"
PROVIDER=proxy exec ./run.sh "$@"
