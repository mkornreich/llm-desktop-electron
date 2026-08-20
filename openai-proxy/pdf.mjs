// Local PDF ingestion.
//
// Anthropic's own servers turn an attached PDF into text (and rendered pages) that the model can
// read. A local on-device backend — Ollama, llama.cpp, LM Studio — does none of that: a `document`
// block reaches a model that has no way to parse a PDF byte stream, so it answers "I can't read
// PDFs" even though the file was right there. When the backend is local, this module extracts the
// text with `pdftotext` and hands it to the model as a plain text block instead — the on-device
// equivalent of the server-side ingestion the cloud does for free.
//
// Scope, on purpose:
//   - Only PDFs carried as inline base64 are touched. A URL source is never fetched — a proxy that
//     downloads whatever a message points at is a request-forgery engine aimed at the user's own
//     network (same rule as content.mjs).
//   - Only the text layer is extracted. A scanned/image-only PDF has none; it gets an honest marker
//     rather than silence, so the model (and the reader) know a PDF was there and why it is empty.
//   - Nothing is dropped: extraction failure, an empty text layer, and a missing `pdftotext` binary
//     all become a labelled text block, never a vanished attachment.
import { spawn } from "node:child_process";
import crypto from "node:crypto";

// A block is a PDF document we can handle: type "document", a PDF media type, and inline base64
// data (never a URL). The Anthropic document default media type is application/pdf.
export function isPdfDocument(blk) {
  const s = blk?.source;
  if (!s || typeof s.data !== "string" || s.data === "") return false;
  return blk?.type === "document" && /pdf/i.test(s.media_type || "application/pdf");
}

// Does this block list contain a PDF, at the top level or nested one deep inside a tool_result?
// (Read on a PDF returns the document INSIDE a tool_result, so the common case is the nested one.)
export function containsPdf(blocks) {
  return Array.isArray(blocks) &&
    blocks.some((b) => isPdfDocument(b) || (b?.type === "tool_result" && containsPdf(b.content)));
}

// The text block a PDF becomes. `text` is the extracted text, "" for a real-but-empty text layer,
// or null when extraction could not run — each gets a distinct, honest marker.
export function pdfBlockToText(blk, text) {
  const name = blk?.title || blk?.source?.filename || "document.pdf";
  if (text === null)
    return { type: "text", text:
      `[The PDF "${name}" was attached but its text could not be extracted here. ` +
      `If it is a scanned or image-only PDF it needs OCR or a vision model.]` };
  if (String(text).trim() === "")
    return { type: "text", text:
      `[The PDF "${name}" has no extractable text layer — it is likely scanned images, ` +
      `so there is no text to read.]` };
  return { type: "text", text: `[Extracted text of the attached PDF "${name}" follows.]\n\n${text}` };
}

// Run `pdftotext`, PDF bytes on stdin, text on stdout. No shell and args as an array, so the
// filename never touches a command line; the bytes go through a pipe, not a temp file.
// Resolves { ok:true, text } or { ok:false, reason } — it never rejects.
//
// Memory is bounded AT THE SOURCE, not after the fact: a small crafted PDF can decompress to a
// huge text layer, so once stdout passes `maxBytes` the child is killed and the partial text is
// returned (ok:true, marked truncated) rather than buffering gigabytes only to slice it later.
// A timeout or a spawn failure is flagged `transient` so the caller can retry rather than cache it.
export function runPdftotext(buffer, { timeoutMs = 20000, maxBytes = 8_000_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("pdftotext", ["-q", "-enc", "UTF-8", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve({ ok: false, reason: "pdftotext is not installed", transient: true });
    }
    const chunks = [];
    let total = 0, err = "", done = false;
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `pdftotext timed out after ${timeoutMs}ms`, transient: true }), timeoutMs);
    child.stdout.on("data", (d) => {
      if (done) return;
      total += d.length;
      chunks.push(d);
      if (total >= maxBytes) finish({ ok: true, text: Buffer.concat(chunks).toString("utf8"), truncated: true });
    });
    child.stderr.on("data", (d) => { if (err.length < 500) err += d; });
    child.on("error", () => finish({ ok: false, reason: "pdftotext is not installed", transient: true }));
    child.on("close", (code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
      else resolve({ ok: false, reason: `pdftotext exited ${code}${err ? ": " + err.trim() : ""}` });
    });
    child.stdin.on("error", () => { /* a crash before stdin drains would otherwise throw EPIPE */ });
    child.stdin.end(buffer);
  });
}

// A content-hashed extractor with a bounded cache: the same PDF sits in the transcript for the whole
// conversation, so without the cache `pdftotext` would run again on every turn of an agent loop.
// `run` is injectable so tests need not depend on the binary. Returns the text, "" for an empty
// text layer, or null on failure (all three are cached, including failure, so it is not retried).
export function makePdfExtractor({ cap = 200_000, log = () => {}, run = runPdftotext } = {}) {
  const cache = new Map();
  return async function extract(b64) {
    const key = crypto.createHash("sha256").update(b64).digest("hex");
    if (cache.has(key)) return cache.get(key);
    let result = null, cacheable = true;
    try {
      // Read at most ~cap characters' worth of bytes (UTF-8 is ≤4 bytes/char, with a floor).
      const r = await run(Buffer.from(b64, "base64"), { maxBytes: Math.max(cap * 4, 1_000_000) });
      if (r.ok) {
        result = r.text.length > cap
          ? r.text.slice(0, cap) + `\n\n[…PDF text truncated at ${cap} characters]`
          : r.text;
      } else {
        log(`  ! PDF text extraction failed: ${r.reason}`);
        result = null;
        // A timeout or spawn failure is transient — do not poison this exact PDF for the life of
        // the process; let a later turn try again. Only a real parse failure (a non-zero exit on a
        // corrupt/encrypted PDF) is permanent and worth caching so it is not retried every turn.
        if (r.transient) cacheable = false;
      }
    } catch (e) {
      log(`  ! PDF text extraction error: ${e.message}`);
      result = null; cacheable = false;   // an unexpected throw is transient too
    }
    if (cacheable) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value);   // bound it
      cache.set(key, result);
    }
    return result;
  };
}

async function localizeList(blocks, extract) {
  const out = [];
  for (const blk of blocks) {
    if (isPdfDocument(blk)) {
      out.push(pdfBlockToText(blk, await extract(blk.source.data)));
    } else if (blk?.type === "tool_result" && Array.isArray(blk.content)) {
      out.push({ ...blk, content: await localizeList(blk.content, extract) });   // document lives one level down
    } else {
      out.push(blk);
    }
  }
  return out;
}

// Replace every PDF document block with an extracted-text block, in place, across the request. A
// fast scan first means a conversation with no PDF pays only one walk and rebuilds nothing. The
// caller decides WHEN to run this (only for a local backend); this function just does the transform.
export async function localizePdfsInBody(body, { extract }) {
  if (!body || !Array.isArray(body.messages)) return body;
  if (!body.messages.some((m) => containsPdf(m.content))) return body;   // nothing to do
  for (const m of body.messages) {
    if (Array.isArray(m.content) && containsPdf(m.content)) m.content = await localizeList(m.content, extract);
  }
  return body;
}
