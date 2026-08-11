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

args=("$@")
for ((i = 1; i < ${#args[@]}; i++)); do
  if [[ ${args[i]} == --model ]] &&
     ((i + 1 < ${#args[@]})) &&
     [[ ${args[i + 1]} == claude-opus-4-8 ]]; then
    args[i + 1]=$LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL
    ((i++))
  elif [[ ${args[i]} == --model=claude-opus-4-8 ]]; then
    args[i]=--model="$LLM_DESKTOP_OPENAI_CLAUDE_CODE_MODEL"
  fi
done

exec "${args[@]}"
