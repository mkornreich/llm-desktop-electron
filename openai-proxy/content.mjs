// One ordered representation of a message's content, shared by both surfaces.
//
// WHAT WAS WRONG, verified by translating a message and looking at what came out.
//
// The encoder collected content into four separate buckets — text, tool calls, tool results, images
// — and re-emitted them bucket by bucket. Anything that matched no bucket fell out of the loop with
// no `else`, and the consequences were not subtle:
//
//   input:  [image(AAA), text("what is in this picture?"), image(BBB)]
//   output: [text, image(AAA), image(BBB)]
//
// The question moved in front of both pictures, so which image it referred to is gone.
//
//   input:  a user message containing one `document` block (a PDF)
//   output: NOTHING. Not a marker, not an empty message — the entire message disappeared, and the
//           model answered as though nothing had been attached.
//
//   input:  a user message containing `{type:"image", source:{}}`
//   output: NOTHING, for the same reason: no URL could be built, so no image was pushed, so the
//           message had neither text nor images and was skipped entirely.
//
//   input:  a tool_result carrying an image (what Read produces for a screenshot)
//   output: "[image omitted by proxy]" — labelled, at least, but the picture was lost.
//
// The invariant this file exists to enforce: NOTHING DISAPPEARS SILENTLY. A part that cannot be
// represented becomes a labelled marker saying what was dropped and why, so the model and the reader
// both know something was there. A wrong answer to a question about an image nobody sent is much
// harder to diagnose than an answer that says the image is missing.
//
// REMOTE URLS ARE NEVER FETCHED. A proxy that downloads whatever a message points at is a request
// forgery engine pointed at the user's own network. A URL source is passed through as a URL and let
// the upstream decide.

// A part is one of:
//   { kind: "text",  text }
//   { kind: "image", url, mediaType }            // data: URL or a remote URL, never fetched here
//   { kind: "file",  filename, dataUrl, mediaType }
//   { kind: "note",  text }                      // something that could not be represented
// Strip the harness-injected "# userEmail" context block (the user's email address) from any text
// block before it is forwarded upstream. Structural (no hardcoded address) so it redacts whatever
// address the harness injects, and only that block — a user-typed email elsewhere is left untouched.
// Applied in decodeBlocks, so it covers user messages and tool results on both the chat and
// responses surfaces.
const USER_EMAIL_BLOCK_RE = /# userEmail\n[^\n]*\n?/g;
export function redactInjectedPII(text) {
  return typeof text === "string" ? text.replace(USER_EMAIL_BLOCK_RE, "") : text;
}

export function decodeBlocks(blocks) {
  const parts = [];
  for (const blk of Array.isArray(blocks) ? blocks : []) {
    const t = blk?.type;
    if (t === "text") {
      if (blk.text) parts.push({ kind: "text", text: redactInjectedPII(String(blk.text)) });
      continue;
    }
    if (t === "image") {
      const src = blk.source || {};
      const mediaType = src.media_type || "image/png";
      if (src.type === "url" && src.url) parts.push({ kind: "image", url: String(src.url), mediaType });
      else if (src.data) parts.push({ kind: "image", url: `data:${mediaType};base64,${src.data}`, mediaType });
      // A malformed image used to vanish, taking its whole message with it when there was no other
      // content. Say what happened instead.
      else parts.push({ kind: "note", text: `[an image was attached but could not be read: ` +
        `source type ${JSON.stringify(src.type ?? null)} with no data or url]` });
      continue;
    }
    if (t === "document") {
      const src = blk.source || {};
      const mediaType = src.media_type || "application/pdf";
      const filename = blk.title || src.filename || `document.${mediaType.split("/").pop() || "bin"}`;
      if (src.type === "url" && src.url)
        parts.push({ kind: "file", filename, url: String(src.url), mediaType });
      else if (src.data)
        parts.push({ kind: "file", filename, dataUrl: `data:${mediaType};base64,${src.data}`, mediaType });
      else
        parts.push({ kind: "note", text: `[a document (${mediaType}) was attached but could not be read]` });
      continue;
    }
    // Thinking blocks are the client's own record of a previous turn and carry no input value; they
    // are dropped deliberately, and named so the drop is a decision rather than an accident.
    if (t === "thinking" || t === "redacted_thinking") continue;
    if (t === "tool_use" || t === "tool_result") continue;   // handled by the caller: they are items, not content
    // Anything else. A future block type must not disappear just because this proxy predates it.
    parts.push({ kind: "note", text: `[a "${t ?? "malformed"}" content block was not forwarded: ` +
      `this proxy does not know how to translate it]` });
  }
  return parts;
}

// A tool_result's content, split into the text that belongs in the paired result and any media that
// cannot go there.
//
// The Responses API's `function_call_output` takes a string. So media inside a tool result has to go
// somewhere else — and dropping it is not an option, since Read on a screenshot produces exactly this
// shape. The text stays paired with its call (breaking that pairing makes the transcript describe
// something that never happened) and the media follows as a companion user message.
export function decodeToolResult(blk) {
  const c = blk?.content;
  if (typeof c === "string") return { text: c, media: [] };
  if (c == null) return { text: "", media: [] };
  if (!Array.isArray(c)) return { text: JSON.stringify(c), media: [] };
  const text = [];
  const media = [];
  for (const part of decodeBlocks(c)) {
    if (part.kind === "text" || part.kind === "note") text.push(part.text);
    else media.push(part);
  }
  // A marker in the paired text says the media exists and where it went, so the model does not read
  // the companion message as an unrelated attachment.
  if (media.length)
    text.push(`[${media.length} attachment(s) from this tool result follow as the next message]`);
  return { text: text.join("\n"), media };
}

// Order-preserving serialisation for the Responses API.
export function partsToResponses(parts) {
  const out = [];
  for (const p of parts) {
    if (p.kind === "text" || p.kind === "note") out.push({ type: "input_text", text: p.text });
    else if (p.kind === "image") out.push({ type: "input_image", image_url: p.url });
    else if (p.kind === "file") {
      // The documented shape: a base64 file needs a filename alongside it. A URL is passed through
      // rather than fetched.
      if (p.dataUrl) out.push({ type: "input_file", filename: p.filename, file_data: p.dataUrl });
      else out.push({ type: "input_file", filename: p.filename, file_url: p.url });
    }
  }
  return out;
}

// Chat Completions. It has no file part, so a document becomes a labelled note rather than silently
// nothing — the difference between the model knowing a PDF was attached and the model answering as
// though the conversation never contained one.
export function partsToChat(parts) {
  const out = [];
  for (const p of parts) {
    if (p.kind === "text" || p.kind === "note") out.push({ type: "text", text: p.text });
    else if (p.kind === "image") out.push({ type: "image_url", image_url: { url: p.url } });
    else if (p.kind === "file")
      out.push({ type: "text", text: `[a document was attached (${p.filename}, ${p.mediaType}) but ` +
        `this API surface cannot accept files; switch OPENAI_API to responses to send it]` });
  }
  return out;
}

export const countImages = (parts) => parts.filter((p) => p.kind === "image").length;
export const countFiles = (parts) => parts.filter((p) => p.kind === "file").length;
export const countNotes = (parts) => parts.filter((p) => p.kind === "note").length;
