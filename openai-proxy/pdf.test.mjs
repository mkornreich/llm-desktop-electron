// PDF ingestion for local backends.
//   node --test openai-proxy/pdf.test.mjs
//
// The invariant: a PDF attached to a local (Ollama) turn reaches the model as readable TEXT, and
// nothing ever disappears silently — a failed or text-less PDF becomes a labelled marker, not a
// gap the model answers around.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  isPdfDocument, containsPdf, pdfBlockToText, runPdftotext, makePdfExtractor, localizePdfsInBody,
} from "./pdf.mjs";

const HAS_PDFTOTEXT = (() => { try { return spawnSync("pdftotext", ["-v"]).error == null; } catch { return false; } })();

// A tiny, real, single-line PDF ("Hello from a test PDF file"), verified with pdftotext.
const PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg" +
  "L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug" +
  "L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAv" +
  "Rm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1OCA+PgpzdHJlYW0KQlQg" +
  "L0YxIDI0IFRmIDcyIDcwMCBUZCAoSGVsbG8gZnJvbSBhIHRlc3QgUERGIGZpbGUpIFRqIEVUCmVuZHN0cmVhbQplbmRv" +
  "YmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5k" +
  "b2JqCnRyYWlsZXIKPDwgL1Jvb3QgMSAwIFIgPj4KJSVFT0YK";

const pdfDoc = (data = "QUFB", extra = {}) =>
  ({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, ...extra });

// ---------- predicates ----------

test("isPdfDocument accepts only an inline-base64 PDF document", () => {
  assert.equal(isPdfDocument(pdfDoc()), true);
  assert.equal(isPdfDocument({ type: "document", source: { data: "x" } }), true, "default media type is PDF");
  // A URL source is never fetched, so it is not one we can localize.
  assert.equal(isPdfDocument({ type: "document", source: { type: "url", url: "http://x/a.pdf" } }), false);
  assert.equal(isPdfDocument({ type: "document", source: { media_type: "text/plain", data: "x" } }), false);
  assert.equal(isPdfDocument({ type: "image", source: { data: "x" } }), false);
  assert.equal(isPdfDocument({ type: "document", source: { media_type: "application/pdf", data: "" } }), false);
  assert.equal(isPdfDocument(null), false);
});

test("containsPdf finds a PDF at the top level and one nested inside a tool_result", () => {
  assert.equal(containsPdf([{ type: "text", text: "hi" }, pdfDoc()]), true);
  assert.equal(containsPdf([{ type: "tool_result", tool_use_id: "t", content: [pdfDoc()] }]), true, "Read returns it nested");
  assert.equal(containsPdf([{ type: "text", text: "hi" }, { type: "image", source: { data: "x" } }]), false);
  assert.equal(containsPdf("not an array"), false);
});

test("pdfBlockToText gives each outcome a distinct, honest marker", () => {
  const named = pdfDoc("QUFB", { title: "report.pdf" });
  assert.match(pdfBlockToText(named, "the body text").text, /Extracted text of the attached PDF "report\.pdf"/);
  assert.match(pdfBlockToText(named, "the body text").text, /the body text/);
  assert.match(pdfBlockToText(named, "").text, /no extractable text layer/);
  assert.match(pdfBlockToText(named, "   \n\f ").text, /no extractable text layer/, "whitespace is empty");
  assert.match(pdfBlockToText(named, null).text, /could not be extracted/);
  assert.match(pdfBlockToText(named, null).text, /scanned or image-only PDF/);
});

// ---------- the body transform (extraction mocked) ----------

test("a PDF attachment and a Read-nested PDF both become text; other blocks are untouched", async () => {
  const extract = async () => "MOCK EXTRACTED TEXT";
  const body = { messages: [
    { role: "user", content: [{ type: "text", text: "read this" }, pdfDoc()] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [pdfDoc()] }] },
  ] };
  await localizePdfsInBody(body, { extract });

  const top = body.messages[0].content;
  assert.deepEqual(top[0], { type: "text", text: "read this" }, "the sibling text is preserved, in place");
  assert.equal(top[1].type, "text");
  assert.match(top[1].text, /MOCK EXTRACTED TEXT/);

  const nested = body.messages[1].content[0];
  assert.equal(nested.type, "tool_result", "the tool_result wrapper is kept");
  assert.equal(nested.content[0].type, "text");
  assert.match(nested.content[0].text, /MOCK EXTRACTED TEXT/);

  assert.equal(body.messages.some((m) => containsPdf(m.content)), false, "no PDF block remains");
});

test("an empty text layer and a failed extraction produce markers, not silence", async () => {
  const empty = { messages: [{ role: "user", content: [pdfDoc("AAAA")] }] };
  await localizePdfsInBody(empty, { extract: async () => "" });
  assert.match(empty.messages[0].content[0].text, /no extractable text layer/);

  const failed = { messages: [{ role: "user", content: [pdfDoc("AAAA")] }] };
  await localizePdfsInBody(failed, { extract: async () => null });
  assert.match(failed.messages[0].content[0].text, /could not be extracted/);
});

test("the extractor receives the block's base64 data", async () => {
  const seen = [];
  await localizePdfsInBody({ messages: [{ role: "user", content: [pdfDoc("SGVsbG8=")] }] },
    { extract: async (b64) => { seen.push(b64); return "x"; } });
  assert.deepEqual(seen, ["SGVsbG8="]);
});

test("a URL-source PDF is left alone (a proxy must not fetch it)", async () => {
  const urlDoc = { type: "document", source: { type: "url", url: "http://host/a.pdf" } };
  const body = { messages: [{ role: "user", content: [urlDoc] }] };
  await localizePdfsInBody(body, { extract: async () => { throw new Error("must not run"); } });
  assert.deepEqual(body.messages[0].content[0], urlDoc);
});

test("a turn with no PDF is returned untouched, rebuilding nothing", async () => {
  const content = [{ type: "text", text: "hi" }, { type: "image", source: { data: "x" } }];
  const body = { messages: [{ role: "user", content }] };
  await localizePdfsInBody(body, { extract: async () => { throw new Error("must not run"); } });
  assert.equal(body.messages[0].content, content, "same array reference — no needless rebuild");
});

// ---------- the extractor's cache ----------

test("makePdfExtractor caches by content, including failures, and caps the text", async () => {
  let calls = 0;
  const run = async () => (calls++, { ok: true, text: "T".repeat(30) });
  const extract = makePdfExtractor({ cap: 10, run });
  const a = await extract("QUFB");
  const b = await extract("QUFB");
  assert.equal(calls, 1, "identical PDF extracted once");
  assert.equal(a, b);
  assert.match(a, /^T{10}\n\n\[…PDF text truncated at 10 characters\]$/, "capped and marked");

  let fcalls = 0;
  const failing = makePdfExtractor({ run: async () => (fcalls++, { ok: false, reason: "boom" }) });
  assert.equal(await failing("ZZZZ"), null);
  assert.equal(await failing("ZZZZ"), null);
  assert.equal(fcalls, 1, "a failure is cached, not retried every turn");

  const emptyLayer = makePdfExtractor({ run: async () => ({ ok: true, text: "" }) });
  assert.equal(await emptyLayer("QQQQ"), "", "empty text is distinct from failure");
});

test("a transient failure is NOT cached, so a later turn retries", async () => {
  // A permanent parse failure is cached (previous test); a timeout / spawn error must not poison a
  // good PDF for the life of the process.
  let calls = 0;
  const flaky = makePdfExtractor({ run: async () => (calls++, { ok: false, reason: "timed out", transient: true }) });
  assert.equal(await flaky("TTTT"), null);
  assert.equal(await flaky("TTTT"), null);
  assert.equal(calls, 2, "the transient failure was retried, not served from cache");
});

// ---------- real pdftotext (skipped where the binary is absent) ----------

test("runPdftotext extracts a real PDF, and rejects non-PDF bytes", { skip: !HAS_PDFTOTEXT }, async () => {
  const ok = await runPdftotext(Buffer.from(PDF_B64, "base64"));
  assert.equal(ok.ok, true, ok.reason);
  assert.match(ok.text, /Hello from a test PDF file/);

  const bad = await runPdftotext(Buffer.from("this is not a pdf at all", "utf8"));
  assert.equal(bad.ok, false, "garbage is a failure, not empty text");

  // Hitting maxBytes stops reading and returns the partial text (ok:true), not a failure — the
  // memory bound is enforced at the source rather than after buffering everything.
  const capped = await runPdftotext(Buffer.from(PDF_B64, "base64"), { maxBytes: 8 });
  assert.equal(capped.ok, true);
  assert.equal(capped.truncated, true, "over-cap output is truncated, not failed");
});

test("end to end: a real PDF attachment becomes readable text", { skip: !HAS_PDFTOTEXT }, async () => {
  const body = { messages: [{ role: "user", content: [pdfDoc(PDF_B64, { title: "hello.pdf" })] }] };
  await localizePdfsInBody(body, { extract: makePdfExtractor({}) });
  const blk = body.messages[0].content[0];
  assert.equal(blk.type, "text");
  assert.match(blk.text, /Extracted text of the attached PDF "hello\.pdf"/);
  assert.match(blk.text, /Hello from a test PDF file/);
});
