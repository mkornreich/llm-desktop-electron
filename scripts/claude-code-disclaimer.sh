#!/usr/bin/env bash
# Stock Electron does not include Claude Desktop's TCC-attribution helper. The app invokes
# that helper as `disclaimer <command> <args...>`, making this the supported process boundary
# at which this repository can select Claude Code's internal model identity without modifying
# either the proprietary app bundle or the cached Claude Code executable.

# Anthropic mode does not set this private handoff. Preserve the old passthrough byte-for-byte
# at the argv level in that mode, and for every subprocess unrelated to Claude Code.
if [[ -z ${LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL:-} ]]; then
  exec "$@"
fi

# The installer links this repository-owned file into Electron.app. Resolve that link so the
# cache match stays scoped to this repository while accepting future Claude Code versions.
source_path=${BASH_SOURCE[0]}
while [[ -L $source_path ]]; do
  source_dir=$(CDPATH= cd -- "$(dirname -- "$source_path")" && pwd)
  link=$(readlink "$source_path")
  if [[ $link = /* ]]; then
    source_path=$link
  else
    source_path=$source_dir/$link
  fi
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$source_path")" && pwd)
repo=$(CDPATH= cd -- "$script_dir/.." && pwd)
command=${1:-}

if [[ $command != "$repo"/user-data/claude-code/*/claude.app/Contents/MacOS/claude ]]; then
  exec "$@"
fi

# Desktop owns this transport-facing identity and may advance it independently of this
# repository. In OpenAI mode it must not choose Claude Code's context capability: normalize any
# current or future Claude identity to the configured [1m] identity before the proxy sees it.
# OpenAI ids remain meaningful upstream model selections and must pass through unchanged.
is_desktop_claude_identity() {
  [[ $1 == claude-* ]]
}

# Subagents (Task/Explore/teammate spawns) never reach the rewrite below: they run INSIDE the
# session process, so they have no argv of their own. Claude Code resolves their model from
# CLAUDE_CODE_SUBAGENT_MODEL first, ahead of the tool's own `model` argument and an agent
# definition's `model:` frontmatter, so this is where a subagent's capability is decided.
#
# It has to be set HERE rather than in run.sh: the desktop bundle composes the agent env
# itself and sets `CLAUDE_CODE_SUBAGENT_MODEL: getDefaultSubagentModel()`, which would
# overwrite an exported value. This process is the CLI's direct parent, so it assigns the
# variable last and wins.
#
# Measured: subagent turns went out as claude-sonnet-5, resolved Sonnet's ordinary window and
# produced 344 of 402 client-side compactions, never exceeding ~299k tokens, while the main
# loop ran to ~883k. `[1m]` is only honoured for a 1M-capable identity, which is why this
# reuses the same configured identity as the main loop rather than suffixing Sonnet.
#
# The built-in Explore agents are covered too. Their separate
# CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP knob is deliberately NOT set: that cap only engages
# for a first-party base URL, so it is already inert against a localhost proxy, and this
# variable outranks it anyway.
export CLAUDE_CODE_SUBAGENT_MODEL="$LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL"

args=("$@")
for ((i = 1; i < ${#args[@]}; i++)); do
  if [[ ${args[i]} == --model ]] &&
     ((i + 1 < ${#args[@]})) &&
     is_desktop_claude_identity "${args[i + 1]}"; then
    args[i + 1]=$LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL
    ((i++))
  elif [[ ${args[i]} == --model=* ]] &&
       is_desktop_claude_identity "${args[i]#--model=}"; then
    args[i]=--model="$LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL"
  fi
done

exec "${args[@]}"
