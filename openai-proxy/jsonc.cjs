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
// Shared by BOTH module systems: config.mjs (ESM) `import`s this .cjs, settings/config.js (CJS)
// `require`s it — one implementation, no duplicated parser across the ESM/CJS boundary.

const fs = require("fs");
const path = require("path");

// Repo root is the parent of openai-proxy/. The single source of truth for all non-secret config.
const CONFIG_FILE = path.join(__dirname, "..", "config.jsonc");

const WS = new Set([" ", "\t", "\n", "\r"]);
const isWs = (c) => WS.has(c);

// Parse `text` into { value, node }. `node` mirrors the structure with source spans:
//   { start, end, type:"object", props: Map<key, childNode> }
//   { start, end, type:"array",  items: childNode[] }
//   { start, end, type:"string"|"literal" }
// `start`/`end` bound the VALUE token itself (a string node's span includes its quotes).
function parse(text) {
  let i = 0;
  const n = text.length;

  // Advance past whitespace AND comments. Comments never appear inside a value token, only between
  // structural tokens, so skipping them here is enough for both parsing and span tracking.
  function skip() {
    while (i < n) {
      const c = text[i];
      if (isWs(c)) { i++; continue; }
      if (c === "/" && text[i + 1] === "/") { i += 2; while (i < n && text[i] !== "\n") i++; continue; }
      if (c === "/" && text[i + 1] === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
      break;
    }
  }

  const ESC = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  function parseString() {
    const start = i;
    i++; // opening quote
    let s = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") { s += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
        else { s += (e in ESC ? ESC[e] : e); i += 2; }
        continue;
      }
      if (c === '"') { i++; break; }
      s += c; i++;
    }
    return { value: s, node: { start, end: i, type: "string" } };
  }

  function parseLiteral() {
    const start = i;
    // Consume up to the next structural char / whitespace / comment start.
    while (i < n && !isWs(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]"
           && !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))) i++;
    const raw = text.slice(start, i);
    let value;
    if (raw === "true") value = true;
    else if (raw === "false") value = false;
    else if (raw === "null") value = null;
    else value = Number(raw);
    return { value, node: { start, end: i, type: "literal" } };
  }

  function parseObject() {
    const start = i;
    i++; // {
    const props = new Map();
    const obj = {};
    skip();
    while (i < n && text[i] !== "}") {
      const key = parseString();
      skip();
      if (text[i] === ":") i++;               // colon
      const v = parseValue();
      props.set(key.value, v.node);
      obj[key.value] = v.value;
      skip();
      if (text[i] === ",") { i++; skip(); }   // trailing comma tolerated (loop re-checks for })
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
    while (i < n && text[i] !== "]") {
      const v = parseValue();
      items.push(v.node);
      arr.push(v.value);
      skip();
      if (text[i] === ",") { i++; skip(); }   // trailing comma tolerated
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
  return r;
}

// Parse a JSONC file (or string) to a plain JS object. Comments and trailing commas are tolerated.
function readConfigText(text) { return parse(text).value; }
function readConfig(file = CONFIG_FILE) { return readConfigText(fs.readFileSync(file, "utf8")); }

// Walk the node tree to the value node at `pathArr` (["providers","gemini","model"] or a mix with array
// indices), returning { start, end } of that value's span, or null when any segment is missing. The
// second return, `parentObject`, is the nearest enclosing OBJECT node — used to insert a missing leaf.
function locate(text, pathArr) {
  let node = parse(text).node;
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
// preserved by splicing, so only the value token itself is (re)written).
function serialize(v) { return JSON.stringify(v); }

// Replace (or, when the leaf key is absent, insert) the value at `pathArr` in `text`, preserving every
// comment / blank line / key order / indentation outside the edited span. Returns the new text.
function editText(text, pathArr, value) {
  const found = locate(text, pathArr);
  if (found.span) {
    return text.slice(0, found.span.start) + serialize(value) + text.slice(found.span.end);
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
    const entry = `"${found.missingKey}": ${serialize(value)}`;
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
  const next = editText(fs.readFileSync(file, "utf8"), pathArr, value);
  fs.writeFileSync(file, next);
  return next;
}

module.exports = { CONFIG_FILE, readConfig, readConfigText, editConfig, editText, locate, parse };
