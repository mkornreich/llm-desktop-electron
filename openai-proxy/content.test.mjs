// Ordered content translation: nothing disappears silently.
//   node --test openai-proxy/content.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeBlocks, decodeToolResult, partsToResponses, partsToChat,
  countImages, countFiles, countNotes, redactInjectedPII,
} from "./content.mjs";

const img = (data = "AAA", mediaType = "image/png") =>
  ({ type: "image", source: { type: "base64", media_type: mediaType, data } });
const txt = (text) => ({ type: "text", text });

test("order is preserved across text and media", () => {
  // THE FIRST DEFECT, verified by translating a real message: four separate buckets were re-emitted
  // bucket by bucket, so [image, text, image] came out as [text, image, image] — the question moved
  // in front of both pictures and which one it referred to was gone.
  const parts = decodeBlocks([img("AAA"), txt("what is in this picture?"), img("BBB")]);
  assert.deepEqual(parts.map((p) => p.kind), ["image", "text", "image"]);
  assert.match(parts[0].url, /AAA/);
  assert.match(parts[2].url, /BBB/);
  const ser = partsToResponses(parts);
  assert.deepEqual(ser.map((p) => p.type), ["input_image", "input_text", "input_image"]);
});

test("an unreadable image becomes a labelled note, not a gap", () => {
  // It used to be skipped — and a message whose only content was a malformed image disappeared
  // entirely, so the model answered as though nothing had been attached.
  for (const bad of [{ type: "image" }, { type: "image", source: {} },
                     { type: "image", source: { type: "url" } }]) {
    const parts = decodeBlocks([bad]);
    assert.equal(parts.length, 1, "something must survive");
    assert.equal(parts[0].kind, "note");
    assert.match(parts[0].text, /could not be read/);
  }
});

test("an unknown block type is reported rather than dropped", () => {
  // A future block type must not vanish just because this proxy predates it.
  const parts = decodeBlocks([{ type: "some_future_type", data: 1 }, txt("after")]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, "note");
  assert.match(parts[0].text, /some_future_type/);
  assert.match(parts[0].text, /does not know how to translate/);
  assert.equal(parts[1].text, "after", "and the rest of the message is unaffected");
});

test("thinking blocks are dropped deliberately, and nothing else is", () => {
  // They are the client's record of a previous turn and carry no input value. Named so the drop is a
  // decision rather than an accident.
  assert.deepEqual(decodeBlocks([{ type: "thinking", thinking: "…" }]), []);
  assert.deepEqual(decodeBlocks([{ type: "redacted_thinking", data: "…" }]), []);
  // tool_use / tool_result are items rather than content; the caller handles them.
  assert.deepEqual(decodeBlocks([{ type: "tool_use", id: "x" }]), []);
});

test("a PDF becomes a file part with a filename, and is never fetched", () => {
  const parts = decodeBlocks([
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" }, title: "spec.pdf" },
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, "file");
  assert.equal(parts[0].filename, "spec.pdf");
  assert.match(parts[0].dataUrl, /^data:application\/pdf;base64,UERG$/);
  const [ser] = partsToResponses(parts);
  assert.equal(ser.type, "input_file");
  assert.equal(ser.filename, "spec.pdf");
  assert.ok(ser.file_data, "base64 files need a filename alongside the data");
});

test("a remote URL is passed through, never downloaded", () => {
  // A proxy that fetches whatever a message points at is a request-forgery engine aimed at the user's
  // own network. The URL goes upstream as a URL and the upstream decides.
  const parts = decodeBlocks([
    { type: "image", source: { type: "url", url: "https://example.invalid/a.png" } },
    { type: "document", source: { type: "url", url: "https://example.invalid/b.pdf" } },
  ]);
  assert.equal(parts[0].url, "https://example.invalid/a.png");
  assert.equal(parts[1].url, "https://example.invalid/b.pdf");
  const ser = partsToResponses(parts);
  assert.equal(ser[0].image_url, "https://example.invalid/a.png");
  assert.equal(ser[1].file_url, "https://example.invalid/b.pdf");
  assert.ok(!JSON.stringify(ser).includes("base64"), "nothing was fetched and inlined");
});

test("a filename is derived when the document does not carry one", () => {
  const [p] = decodeBlocks([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } }]);
  assert.equal(p.filename, "document.pdf");
});

// ---------- tool results ----------

test("media inside a tool result is separated from its paired text", () => {
  // What Read produces for a screenshot. A function_call_output takes a string, so the picture cannot
  // live there — and it used to become "[image omitted by proxy]" and be lost.
  const { text, media } = decodeToolResult({ type: "tool_result", tool_use_id: "c1", content: [
    txt("read the file"), img("CCC") ] });
  assert.match(text, /read the file/);
  assert.match(text, /follow as the next message/, "the text says where the attachment went");
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "image");
  assert.match(media[0].url, /CCC/);
});

test("a text-only tool result is unchanged and carries no companion", () => {
  const { text, media } = decodeToolResult({ type: "tool_result", tool_use_id: "c", content: "plain output" });
  assert.equal(text, "plain output");
  assert.deepEqual(media, []);
  const arr = decodeToolResult({ type: "tool_result", tool_use_id: "c", content: [txt("a"), txt("b")] });
  assert.equal(arr.text, "a\nb");
  assert.deepEqual(arr.media, []);
});

test("an empty or non-array tool result does not throw", () => {
  assert.deepEqual(decodeToolResult({ content: null }), { text: "", media: [] });
  assert.deepEqual(decodeToolResult({}), { text: "", media: [] });
  assert.equal(decodeToolResult({ content: { a: 1 } }).text, '{"a":1}');
});

// ---------- surfaces ----------

test("Chat cannot take a file, so it says so instead of silently sending nothing", () => {
  const parts = decodeBlocks([
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" }, title: "r.pdf" },
  ]);
  const [ser] = partsToChat(parts);
  assert.equal(ser.type, "text");
  assert.match(ser.text, /r\.pdf/);
  assert.match(ser.text, /cannot accept files/);
  assert.match(ser.text, /OPENAI_API to responses/, "and names the fix");
});

test("Chat keeps image ordering too", () => {
  const ser = partsToChat(decodeBlocks([img("A"), txt("q"), img("B")]));
  assert.deepEqual(ser.map((p) => p.type), ["image_url", "text", "image_url"]);
});

test("the counters describe what was actually sent", () => {
  const parts = decodeBlocks([img("A"), txt("t"), { type: "image", source: {} },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } },
    { type: "mystery" }]);
  assert.equal(countImages(parts), 1, "only the readable image counts as sent");
  assert.equal(countFiles(parts), 1);
  assert.equal(countNotes(parts), 2, "the unreadable image and the unknown block");
});

test("an empty or absent content array yields nothing, without throwing", () => {
  assert.deepEqual(decodeBlocks([]), []);
  assert.deepEqual(decodeBlocks(null), []);
  assert.deepEqual(decodeBlocks(undefined), []);
  assert.deepEqual(decodeBlocks("not an array"), []);
});

// The harness injects the user's email as a "# userEmail" context block in the user message; it is
// redacted before anything is forwarded upstream.
const INJECTED = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n" +
  "# userEmail\nThe user's email address is someone@example.com.\n# currentDate\nToday's date is 2026-08-22.\n</system-reminder>\n\n";

test("redactInjectedPII drops the # userEmail block and only that block", () => {
  const out = redactInjectedPII(INJECTED);
  assert.doesNotMatch(out, /someone@example\.com/);
  assert.doesNotMatch(out, /# userEmail/);
  assert.doesNotMatch(out, /The user's email address is/);
  assert.match(out, /# currentDate/);                       // sibling context kept
  assert.match(out, /Today's date is 2026-08-22/);
  assert.match(out, /^<system-reminder>/);                  // wrapper kept
  // structural, not hardcoded: a different address is redacted too
  assert.doesNotMatch(redactInjectedPII("# userEmail\nThe user's email address is a.b+c@d.co.uk.\n"), /a\.b\+c@d\.co\.uk/);
  // a user-typed email OUTSIDE the block is left alone
  assert.equal(redactInjectedPII("please email bob@corp.com about it"), "please email bob@corp.com about it");
  assert.equal(redactInjectedPII(undefined), undefined);
});

test("decodeBlocks redacts the injected email from a text block on the way through", () => {
  const parts = decodeBlocks([{ type: "text", text: INJECTED }, { type: "text", text: "hello" }]);
  assert.equal(parts.length, 2);
  assert.doesNotMatch(parts[0].text, /someone@example\.com/);
  assert.doesNotMatch(parts[0].text, /# userEmail/);
  assert.equal(parts[1].text, "hello");
  // and it reaches neither wire shape
  assert.doesNotMatch(JSON.stringify(partsToChat(parts)), /someone@example\.com/);
  assert.doesNotMatch(JSON.stringify(partsToResponses(parts)), /someone@example\.com/);
});
