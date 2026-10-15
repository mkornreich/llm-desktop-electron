"use strict";
// Minimal JSONC (JSON-with-comments) read + SURGICAL, comment-preserving value edits.
//
// The consolidated config lives in one hand-editable `config.jsonc` whose inline documentation
// (latency measurements, rationale, quirks — carried over from the old .openai-model) is as valuable
// as the values. So the settings window must edit ONE value in place and leave every comment, blank
// line, key order, and bit of formatting untouched — the JSONC analogue of the old surgical KEY=value
// line editor. That rules out "parse -> mutate -> re-serialize", which discards comments.
//
// This is a small position-tracking parser: it produces the plain JS value AND a node tree recording
// the [start,end) source span of every value, so `editConfig` can splice a new serialized value into
// exactly that span. Deliberately hand-written and dependency-free (the repo installs no npm packages);
// it handles the subset of JSON5/JSONC this project's config uses — `//` and `/* */` comments, trailing
// commas, double-quoted keys — which is everything `config.jsonc` contains. It is NOT a general JSON5
// parser (no single quotes, no unquoted keys, no hex/Infinity literals).
//
// STRICT outside that subset: anything else is a JsoncSyntaxError naming line:column, never a guess.
// The parser used to be lenient, and a hand-edit typo — `"prefix": ""openrouter2:z-ai/glm-5.3-flash",`
// — parsed "successfully" as `"prefix": ""` plus an invented key `"penrouter2:z-ai/glm-5.3-flash": 0`,
// so the prefix classifier quietly fell back to the default provider with no signal anywhere.
//
// Shared by BOTH module systems: config.mjs (ESM) `import`s this .cjs, settings/config.js (CJS)
// `require`s it — one implementation, no duplicated parser across the ESM/CJS boundary.

const fs = require("fs");
const path = require("path");

// Repo root is the parent of openai-proxy/. The single source of truth for all non-secret config.
const CONFIG_FILE = path.join(__dirname, "..", "config.jsonc");

const WS = new Set([" ", "\t", "\n", "\r"]);
const isWs = (c) => WS.has(c);

// A syntax error in a JSONC document. `line`/`column` are 1-based; the message leads with
// `<file>:<line>:<column>: <reason>` (the shape terminals and editors turn into a jump-to link) and then
// quotes the offending source line with a caret under the column.
class JsoncSyntaxError extends SyntaxError {
  constructor(reason, text, offset, source) {
    const { line, column, lineStart, lineEnd } = position(text, offset);
    const where = `${source ? `${source}:` : ""}${line}:${column}`;
    const quoted = excerpt(text.slice(lineStart, lineEnd), line, column);
    super(`${where}: ${reason}\n${quoted}`);
    this.name = "JsoncSyntaxError";
    // `excerpt` alone (the quoted line + caret) is for a UI that lays the parts out itself (Settings).
    Object.assign(this, { reason, line, column, offset, source, excerpt: quoted });
  }
}

// 1-based line/column of `offset`, plus the [lineStart, lineEnd) bounds of that line.
function position(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = text.indexOf("\n", offset);
  if (lineEnd < 0) lineEnd = text.length;
  return { line: text.slice(0, lineStart).split("\n").length, column: offset - lineStart + 1, lineStart, lineEnd };
}

// `  272 |     "prefix": ""openrouter2…` with a `^` under `column`. A very long line (an inline
// suggestions array) is windowed around the column so the caret stays on screen.
function excerpt(lineText, line, column) {
  const WIDTH = 100;
  let shown = lineText.replace(/\r$/, "").replace(/\t/g, " ");   // one column per char keeps the caret aligned
  let caret = column - 1;
  if (shown.length > WIDTH) {
    const from = Math.max(0, Math.min(caret - WIDTH / 2, shown.length - WIDTH));
    const tail = from + WIDTH < shown.length ? "…" : "";
    shown = (from > 0 ? "…" : "") + shown.slice(from, from + WIDTH) + tail;
    caret = caret - from + (from > 0 ? 1 : 0);
  }
  const gutter = String(line);
  return `  ${gutter} | ${shown}\n  ${" ".repeat(gutter.length)} | ${" ".repeat(caret)}^`;
}

const WORD = /[A-Za-z0-9_$.+-]/;   // a char that can continue a bare token (number, keyword, typo)
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;   // exactly JSON's number grammar
const ESC = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

// Parse `text` into { value, node }. `node` mirrors the structure with source spans:
//   { start, end, type:"object", props: Map<key, childNode> }
//   { start, end, type:"array",  items: childNode[] }
//   { start, end, type:"string"|"literal" }
// `start`/`end` bound the VALUE token itself (a string node's span includes its quotes).
// `source` (a file path) only labels error messages. Malformed input throws JsoncSyntaxError.
function parse(text, source) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;   // an editor-added BOM is not content
  const n = text.length;

  const fail = (reason, at = i) => { throw new JsoncSyntaxError(reason, text, at, source); };
  // What sits at `at`, for an error message: the whole bare word when there is one (the usual typo
  // is an unquoted or half-quoted token), else the single character.
  function found(at = i) {
    if (at >= n) return "end of input";
    let j = at;
    while (j < n && WORD.test(text[j]) && j - at < 40) j++;
    const tok = j > at ? text.slice(at, j) : text[at];
    return /['\x00-\x1f]/.test(tok) ? JSON.stringify(tok) : `'${tok}'`;
  }
  const at = (offset) => { const p = position(text, offset); return `${p.line}:${p.column}`; };
  // A missing ',' at the END of a line is reported where the next member starts — often lines below,
  // past comments — so name the line the comma belongs on.
  function missingComma(valueEnd) {
    const line = position(text, valueEnd).line;
    return line < position(text, i).line ? ` (missing ',' at the end of line ${line}?)` : "";
  }

  // Advance past whitespace AND comments. Comments never appear inside a value token, only between
  // structural tokens, so skipping them here is enough for both parsing and span tracking.
  function skip() {
    while (i < n) {
      const c = text[i];
      if (isWs(c)) { i++; continue; }
      if (c === "/" && text[i + 1] === "/") { i += 2; while (i < n && text[i] !== "\n") i++; continue; }
      if (c === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close < 0) fail("unterminated /* comment (no closing */)");
        i = close + 2;
        continue;
      }
      break;
    }
  }

  function parseString() {
    const start = i;
    i++; // opening quote
    let s = "";
    for (;;) {
      if (i >= n) fail("unterminated string (no closing '\"')", start);
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === "\n" || c === "\r") fail("unterminated string (no closing '\"' before the end of the line)", start);
      if (c < " ") fail(`raw control character ${JSON.stringify(c)} in a string (write it as an escape)`);
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape (expected 4 hex digits)");
          s += String.fromCharCode(parseInt(hex, 16)); i += 6;
        } else if (e !== undefined && Object.hasOwn(ESC, e)) { s += ESC[e]; i += 2; }
        else fail(`invalid escape ${JSON.stringify(`\\${e ?? ""}`)} in a string`);
        continue;
      }
      s += c; i++;
    }
    return { value: s, node: { start, end: i, type: "string" } };
  }

  // true / false / null / a JSON number — and nothing else. A bare word here (an unquoted string, a
  // half-quoted typo, a JSON5-ism) is exactly the input the old lenient parser turned into 0.
  function parseLiteral() {
    const start = i;
    for (const [word, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(word, i) && !WORD.test(text[i + word.length] || "")) {
        i += word.length;
        return { value, node: { start, end: i, type: "literal" } };
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m && !WORD.test(text[i + m[0].length] || "")) {
      i += m[0].length;
      return { value: Number(m[0]), node: { start, end: i, type: "literal" } };
    }
    return fail(`expected a value ("string", number, {…}, […], true, false or null), found ${found()}`);
  }

  function parseObject() {
    const start = i;
    i++; // {
    const props = new Map();
    const obj = {};
    skip();
    for (;;) {
      if (text[i] === "}") break;                           // empty object, or after a trailing comma
      if (i >= n) fail(`unterminated object (the '{' at ${at(start)} is never closed)`);
      if (text[i] !== '"') fail(`expected a "quoted" property name or '}', found ${found()}`);
      const key = parseString();
      skip();
      if (text[i] !== ":") fail(`expected ':' after property name ${JSON.stringify(key.value)}, found ${found()}`);
      i++;
      const v = parseValue();
      props.set(key.value, v.node);
      obj[key.value] = v.value;
      skip();
      if (text[i] === ",") { i++; skip(); continue; }       // trailing comma tolerated (loop re-checks for })
      if (text[i] === "}") break;
      if (i >= n) fail(`unterminated object (the '{' at ${at(start)} is never closed)`);
      fail(`expected ',' or '}' after the value of ${JSON.stringify(key.value)}, found ${found()}${missingComma(v.node.end)}`);
    }
    i++; // }
    return { value: obj, node: { start, end: i, type: "object", props } };
  }

  function parseArray() {
    const start = i;
    i++; // [
    const items = [];
    const arr = [];
    skip();
    for (;;) {
      if (text[i] === "]") break;                           // empty array, or after a trailing comma
      if (i >= n) fail(`unterminated array (the '[' at ${at(start)} is never closed)`);
      const v = parseValue();
      items.push(v.node);
      arr.push(v.value);
      skip();
      if (text[i] === ",") { i++; skip(); continue; }       // trailing comma tolerated
      if (text[i] === "]") break;
      if (i >= n) fail(`unterminated array (the '[' at ${at(start)} is never closed)`);
      fail(`expected ',' or ']' after array element ${items.length}, found ${found()}${missingComma(v.node.end)}`);
    }
    i++; // ]
    return { value: arr, node: { start, end: i, type: "array", items } };
  }

  function parseValue() {
    skip();
    const c = text[i];
    if (c === '"') return parseString();
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    return parseLiteral();
  }

  const r = parseValue();
  skip();
  if (i < n) fail(`unexpected ${found()} after the end of the top-level value`);
  return r;
}

// Parse a JSONC file (or string) to a plain JS object. Comments and trailing commas are tolerated;
// anything else malformed throws JsoncSyntaxError (labelled with `source`/the file path).
function readConfigText(text, source) { return parse(text, source).value; }
function readConfig(file = CONFIG_FILE) { return readConfigText(fs.readFileSync(file, "utf8"), file); }

// Walk the node tree to the value node at `pathArr` (["providers","gemini","model"] or a mix with array
// indices), returning { start, end } of that value's span, or null when any segment is missing. The
// second return, `parentObject`, is the nearest enclosing OBJECT node — used to insert a missing leaf.
function locate(text, pathArr, source) {
  let node = parse(text, source).node;
  let parentObject = node.type === "object" ? node : null;
  for (let k = 0; k < pathArr.length; k++) {
    const seg = pathArr[k];
    if (node.type === "object") { parentObject = node; node = node.props.get(seg); }
    else if (node.type === "array") node = node.items[Number(seg)];
    else return { span: null, parentObject: null };
    if (!node) return { span: null, parentObject: k === pathArr.length - 1 ? parentObject : null, missingKey: seg };
  }
  return { span: { start: node.start, end: node.end }, parentObject };
}

// Serialize a JS value the way it should appear in the file (compact — the surrounding formatting is
// preserved by splicing, so only the value token itself is (re)written). The one exception is a list of
// flat objects (e.g. tools.webSearchEngines): one `{ "k": v, … }` per line, indented under the line the
// value sits on, so a GUI save keeps a hand-formatted list readable instead of collapsing it to one line.
const isFlatObject = (o) => o && typeof o === "object" && !Array.isArray(o)
  && Object.values(o).every((x) => x === null || typeof x !== "object");
function serialize(v, indent = "") {
  if (Array.isArray(v) && v.length && v.every(isFlatObject)) {
    const row = (o) => "{ " + Object.entries(o).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ") + " }";
    return "[\n" + v.map((o) => indent + "  " + row(o)).join(",\n") + "\n" + indent + "]";
  }
  return JSON.stringify(v);
}
// The leading whitespace of the line holding `pos` — the indentation a multi-line value continues from.
const lineIndent = (text, pos) => (text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos).match(/^[ \t]*/) || [""])[0];

// Replace (or, when the leaf key is absent, insert) the value at `pathArr` in `text`, preserving every
// comment / blank line / key order / indentation outside the edited span. Returns the new text.
// A malformed `text` throws JsoncSyntaxError rather than splicing at spans a bad parse invented.
function editText(text, pathArr, value, source) {
  const found = locate(text, pathArr, source);
  if (found.span) {
    return text.slice(0, found.span.start) + serialize(value, lineIndent(text, found.span.start)) + text.slice(found.span.end);
  }
  // Leaf key missing but its parent object exists -> insert `"key": value` before the object's `}`.
  // Only supported for a missing FINAL segment in an existing object (e.g. a new CONTEXT_<model>).
  if (found.parentObject && found.missingKey != null) {
    const obj = found.parentObject;
    const close = obj.end - 1;                      // index of the '}'
    const inner = text.slice(obj.start + 1, close);
    const empty = inner.trim() === "";
    // Reuse the object's existing indentation if we can find a key line; else a two-space bump.
    const indentMatch = inner.match(/\n([ \t]+)"/);
    const indent = indentMatch ? indentMatch[1] : "  ";
    const entry = `"${found.missingKey}": ${serialize(value, indent)}`;
    if (empty) return text.slice(0, obj.start + 1) + `\n${indent}${entry}\n` + text.slice(close);
    // Append after the last non-whitespace char before `}`, adding a comma to the previous entry.
    let j = close - 1;
    while (j > obj.start && isWs(text[j])) j--;
    const needsComma = text[j] !== ",";
    return text.slice(0, j + 1) + (needsComma ? "," : "") + `\n${indent}${entry}` + text.slice(j + 1);
  }
  throw new Error(`jsonc.editText: path not found and not insertable: ${pathArr.join(".")}`);
}

// File-level edit: read, splice one value, write back atomically-ish (single writeFileSync).
function editConfig(file, pathArr, value) {
  const next = editText(fs.readFileSync(file, "utf8"), pathArr, value, file);
  fs.writeFileSync(file, next);
  return next;
}

module.exports = { CONFIG_FILE, readConfig, readConfigText, editConfig, editText, locate, parse, JsoncSyntaxError };
