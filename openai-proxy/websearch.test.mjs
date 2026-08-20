// Local web search (Claude Code's server-side WebSearch, executed by the proxy).
//   node --test openai-proxy/websearch.test.mjs
//
// Network is mocked; the real DuckDuckGo scrape is only exercised by hand.
import test from "node:test";
import assert from "node:assert/strict";
import {
  webSearchQuery, parseDdgLite, injectWebSearch, handleWebSearch,
} from "./websearch.mjs";

const wsTool = { type: "web_search_20250305", name: "web_search" };
const subRequest = (q) => ({
  tools: [wsTool],
  messages: [{ role: "user", content: `Perform a web search for the query: ${q}` }],
});

// A realistic DDG lite fragment: one sponsored result (must be dropped) then two real ones. Result
// links and snippet cells are 1:1 in order, hrefs are //duckduckgo.com/l/?uddg=<encoded> redirects.
const FIXTURE = `
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dihire.com%26ad_provider%3Dbing&amp;rut=x" class='result-link'>Sponsored Jobs</a>
<td class='result-snippet'>An advertisement snippet.</td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjobs&amp;rut=a" class='result-link'>Software Engineer Jobs &#x27;24 - Example</a>
<td class='result-snippet'>Find software engineer jobs in New York City.</td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Findeed.com%2Fq-swe&amp;rut=b" class='result-link'>SWE roles on Indeed</a>
<td class='result-snippet'>Thousands of SWE roles.</td>
`;

test("webSearchQuery detects the web_search sub-request and extracts the query", () => {
  assert.equal(webSearchQuery(subRequest("software engineer jobs in nyc")), "software engineer jobs in nyc");
  // detects via a bare tool name too, and trims
  assert.equal(webSearchQuery({ tools: [{ name: "web_search" }], messages: [{ role: "user", content: "Perform a web search for the query:  cats " }] }), "cats");
  // not a web-search request
  assert.equal(webSearchQuery({ tools: [{ name: "Bash" }], messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(webSearchQuery({ messages: [{ role: "user", content: "hi" }] }), null);
  // falls back to the whole text when the phrasing differs
  assert.equal(webSearchQuery({ tools: [wsTool], messages: [{ role: "user", content: "weather today" }] }), "weather today");
});

test("parseDdgLite extracts real results, drops ads, decodes redirect URLs, pairs snippets", () => {
  const r = parseDdgLite(FIXTURE);
  assert.equal(r.length, 2, "the sponsored result is filtered out");
  assert.deepEqual(r[0], {
    title: "Software Engineer Jobs '24 - Example",   // HTML entities decoded, tags stripped
    url: "https://example.com/jobs",                 // decoded from ?uddg=
    snippet: "Find software engineer jobs in New York City.",
  });
  assert.equal(r[1].url, "https://indeed.com/q-swe");
  assert.equal(r[1].snippet, "Thousands of SWE roles.");
});

test("parseDdgLite respects max and tolerates junk", () => {
  assert.equal(parseDdgLite(FIXTURE, { max: 1 }).length, 1);
  assert.deepEqual(parseDdgLite("<html>no results here</html>"), []);
  assert.deepEqual(parseDdgLite(null), []);
});

test("injectWebSearch strips the server tool and injects results", () => {
  const body = subRequest("nyc jobs");
  injectWebSearch(body, "nyc jobs", { ok: true, results: [{ title: "T", url: "https://x.com", snippet: "S" }] });
  assert.deepEqual(body.tools, [], "the unrunnable web_search tool is removed");
  const text = body.messages[body.messages.length - 1].content;
  assert.match(text, /Web search results for "nyc jobs"/);
  assert.match(text, /https:\/\/x\.com/);
  assert.match(text, /cite each fact with its source URL/);
});

test("injectWebSearch turns a failed search into an honest note, not an invented answer", () => {
  const body = subRequest("nyc jobs");
  injectWebSearch(body, "nyc jobs", { ok: false, reason: "search timed out" });
  const text = body.messages[body.messages.length - 1].content;
  assert.match(text, /could not be completed \(search timed out\)/);
  assert.match(text, /do NOT invent results/);
  assert.deepEqual(body.tools, []);
});

test("handleWebSearch runs the whole flow with a mocked fetch, and no-ops otherwise", async () => {
  const body = subRequest("software engineer jobs nyc");
  const handled = await handleWebSearch(body, { fetchImpl: () => ({ ok: true, html: FIXTURE }) });
  assert.equal(handled, true);
  assert.deepEqual(body.tools, []);
  const text = body.messages[body.messages.length - 1].content;
  assert.match(text, /example\.com\/jobs/);
  assert.match(text, /indeed\.com\/q-swe/);
  assert.ok(!/duckduckgo\.com\/y\.js/.test(text), "the ad never appears");

  // an ordinary request is untouched
  const plain = { tools: [{ name: "Bash" }], messages: [{ role: "user", content: "hello" }] };
  assert.equal(await handleWebSearch(plain, {}), false);
  assert.deepEqual(plain.tools, [{ name: "Bash" }]);
});

test("handleWebSearch surfaces an unreachable search as unavailable", async () => {
  const body = subRequest("nyc jobs");
  await handleWebSearch(body, { fetchImpl: () => ({ ok: false, reason: "curl is not available" }) });
  assert.match(body.messages[body.messages.length - 1].content, /unavailable|could not be completed/);
});
