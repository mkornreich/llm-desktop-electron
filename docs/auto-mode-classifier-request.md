# Auto-mode safety classifier — request structure & why it overflows

How the **Auto-mode safety classifier** request is shaped, and why it overflows the on-device
classifier model (`freetoken:qwen3:1.7b`, ~30.5k-token served window) and falls back to manual
approval. Grounded in the client's own error dumps at
`$TMPDIR/auto-mode-classifier-errors/*.txt` (3 real overflows analysed).

The fixed rulebook that dominates every request is saved verbatim (username redacted) in
[auto-mode-classifier-rulebook.md](auto-mode-classifier-rulebook.md).

## What the classifier request is

When the agent runs autonomously and is about to use a tool, Claude Code sends a **separate
Anthropic Messages request** to the safety classifier to decide whether the action may be
auto-approved. It is NOT an extra thing appended to the main turn — it is its own call, and it
carries almost the entire conversation so the verdict is made in context.

Everything of size lives in the **system prompt**, which has two parts:

```
system prompt
├── [~27k tokens]  the fixed safety rulebook          ← identical on every request
└── === USER PROMPT (transcript) ===
    └── [variable] the whole conversation transcript  ← every tool call + tool result, verbatim
messages
└── the pending action to judge  (a few dozen tokens: "Bash …", "mcp__…__navigate …")
```

The proxy does **not** inflate this: classifier calls get no format/persistence hints, no tools, no
reasoning (`CLASSIFIER_POLICY` in `openai-proxy/routes.mjs`). The ~27k rulebook and the transcript
are both authored entirely by the client.

## The client's error-dump format

Each `*.txt` dump the client writes on a failed verdict has four sections:

| Section | Contents |
|---|---|
| `=== ERROR ===` | the upstream failure, e.g. `prompt is too long: 43760 tokens > 30571 maximum` |
| `=== CONTEXT COMPARISON ===` | `classifierTokensEst`, `mainLoopTokens`, `messages`, `transcriptEntries` |
| `=== ACTION BEING CLASSIFIED ===` | the one tool call under review (tiny) |
| `=== SYSTEM PROMPT ===` | the ~27k rulebook **plus** the embedded transcript (the bulk of the file) |

## The three real overflows

All three were browser/scraping-heavy sessions. Actions are shown by tool type only (specific
URLs, commands, and user prompts omitted).

| Action type (judged) | Rulebook | Transcript | Total est. | vs ~30.5k cap |
|---|---|---|---|---|
| Browser tool — page load | ~27k | ~2k | ~29.3k | at the line |
| Browser tool — navigate | ~27k | ~4k | ~31.1k | **over** |
| Bash — run a local script | ~27k | ~23k | ~50.0k | **way over** |

Note it is **not message count**: one dump had 21 messages, another 257, yet both are dominated by
the same ~27k rulebook plus large per-message content. The classifier's copy tracks the main loop
almost exactly (e.g. classifier ~50k vs main-loop ~57.7k on the largest).

## Why it overflows

1. **The rulebook is ~27k tokens — ~88% of the ~30.5k window — before any transcript.** The
   classifier is nearly full before it sees the conversation, leaving only ~3.5k tokens of headroom.
2. **The transcript is the whole conversation, dominated by large tool results.** Not extra calls —
   accumulated output: browser page dumps (`get_page_text` / `navigate` / `preview_start`), file
   reads dumping file contents, command stdout, and code the agent wrote/read. One page dump or one
   big file read is several thousand tokens — enough to blow the ~3.5k headroom on its own.

## Why the clean fix is a bigger-window classifier model

Neither part can be shortened safely: cutting the **rulebook** degrades the verdict criteria, and
truncating the **transcript** for a safety judgment is a fail-open risk (a dangerous instruction may
sit in the dropped portion). So the proxy correctly fails closed on overflow. The overflow is removed
at the root only by giving the classifier a model whose window dwarfs `27k + transcript` — a
large-context cloud model (e.g. Gemini's ~1M window makes the 27k rulebook a rounding error). On-box
options cannot get there: the 8 GB card caps the KV budget at ~30.5k regardless of `--max-model-len`.
See the classifier-model options discussed for the `classifier.safety` / `classifier.prefix` config
keys.
