// Local web search (Claude Code's server-side WebSearch, executed by the proxy).
//   node --test openai-proxy/websearch.test.mjs
//
// Network is mocked; the real engines are only exercised by hand.
import test from "node:test";
import assert from "node:assert/strict";
import {
  webSearchQuery, parseHtmlResults, parseJsonResults, injectWebSearch, handleWebSearch, searchEngine,
  engineUrl, normalizeEngines, engineProblem, DEFAULT_SEARCH_ENGINES,
} from "./websearch.mjs";

const wsTool = { type: "web_search_20250305", name: "web_search" };
const subRequest = (q) => ({
  tools: [wsTool],
  messages: [{ role: "user", content: `Perform a web search for the query: ${q}` }],
});
const page = (body, status = 200, contentType = "text/html; charset=utf-8") => ({ ok: true, status, contentType, body });
const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Bing-shaped: results are <h2><a href="bing.com/ck/a?…&u=a1<base64url(real)>">, a <cite> breadcrumb, a
// caption paragraph; plus a sponsored aclick result, engine-own nav links, and a footer.
const BING = `
<header><a href="https://www.bing.com/images/search?q=x">Images of rust programming</a></header>
<ol id="b_results">
<li class="b_ad"><h2><a href="https://www.bing.com/aclick?ld=e8&u=https%3A%2F%2Fads.example%2Foffer">Sponsored Rust Course Today</a></h2></li>
<li class="b_algo"><div class="b_attribution"><cite>https://en.wikipedia.org › wiki › Rust</cite></div>
<h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${b64url("https://en.wikipedia.org/wiki/Rust_(programming_language)")}&amp;ntb=1">Rust (programming language) - Wikipedia</a></h2>
<p class="b_lineclamp2">Rust is a general-purpose programming language emphasizing performance &amp; safety.</p></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=def&amp;u=a1${b64url("https://doc.rust-lang.org/std/")}&amp;ntb=1">std - Rust</a></h2>
<p>The Rust Standard Library is the foundation of portable Rust software.</p></li>
</ol>
<a href="https://www.bing.com/search?q=rust+tutorial">Related: rust tutorial for beginners</a>
<footer><a href="https://go.microsoft.com/fwlink/?LinkId=521839">Privacy and Cookies statement</a></footer>`;

// Brave-shaped: a direct outbound link whose title is a child with a "title" class (site name + cite
// breadcrumb ride along in the same anchor), then deep links to fragments of the same page.
const BRAVE = `
<div class="snippet"><a href="https://rust-lang.org/" class="l1"><div class="site-name">Rust<cite>rust-lang.org</cite></div>
<div class="title search-snippet-title">Rust Programming Language</div></a>
<div class="snippet-description">A language empowering everyone to build reliable and efficient software.</div></div>
<div class="snippet"><a href="https://en.wikipedia.org/wiki/Rust_(programming_language)" class="l1"><div class="title">Rust (programming language) - Wikipedia</div></a>
<div class="snippet-description">Rust is a general-purpose programming language.</div>
<a class="deep-link" href="https://en.wikipedia.org/wiki/Rust_(programming_language)#History">History</a></div>
<a href="https://search.brave.com/settings">Search settings and preferences</a>`;

// DuckDuckGo-lite-shaped: //duckduckgo.com/l/?uddg=<encoded url> redirects and a y.js ad.
const DDG = `
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dihire.com&amp;rut=x" class='result-link'>Sponsored Jobs Listing</a>
<td class='result-snippet'>An advertisement snippet.</td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjobs&amp;rut=a" class='result-link'>Software Engineer Jobs &#x27;24 - Example</a>
<td class='result-snippet'>Find software engineer jobs in New York City.</td>`;

const CLOUDFLARE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/x.js"></script></body></html>`;

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

test("the default engines are Yep first, then Qwant Lite, Startpage, Swisscows, Brave, Bing — no DuckDuckGo", () => {
  assert.deepEqual(DEFAULT_SEARCH_ENGINES.map((e) => e.name), ["Yep", "Qwant Lite", "Startpage", "Swisscows", "Brave Search", "Bing"]);
  assert.equal(DEFAULT_SEARCH_ENGINES[0].url, "https://yep.com/?q=%s");
  assert.ok(DEFAULT_SEARCH_ENGINES.every((e) => engineProblem(e) === null), "every default is usable");
  assert.ok(!DEFAULT_SEARCH_ENGINES.some((e) => /duckduckgo/i.test(e.url + e.name)));
});

test("engineUrl puts the URL-encoded query at every %s", () => {
  assert.equal(engineUrl("https://yep.com/?q=%s", "rust & c++ 100%"), "https://yep.com/?q=rust%20%26%20c%2B%2B%20100%25");
  assert.equal(engineUrl("https://x.test/%s/?again=%s", "a b"), "https://x.test/a%20b/?again=a%20b");
});

test("normalizeEngines takes an array or its JSON; engineProblem names what makes an entry unusable", () => {
  assert.deepEqual(normalizeEngines('[{"name":" Yep ","url":" https://yep.com/?q=%s "}, 5, null]'),
    [{ name: "Yep", url: "https://yep.com/?q=%s" }]);
  assert.deepEqual(normalizeEngines("not json"), []);
  assert.deepEqual(normalizeEngines({ name: "x" }), []);
  assert.equal(engineProblem({ name: "A", url: "https://a.test/?q=%s" }), null);
  assert.match(engineProblem({ name: "A", url: "https://a.test/?q=" }), /no %s/);
  assert.match(engineProblem({ name: "A", url: "ftp://a.test/%s" }), /not an http/);
  assert.match(engineProblem({ name: "A", url: "" }), /no URL/);
});

test("parseHtmlResults (Bing shape): unwraps base64 redirects, titles by heading, drops ads/nav/footer", () => {
  const r = parseHtmlResults(BING, "https://www.bing.com/search?q=rust");
  assert.deepEqual(r.map((x) => x.url), ["https://en.wikipedia.org/wiki/Rust_(programming_language)", "https://doc.rust-lang.org/std/"]);
  assert.equal(r[0].title, "Rust (programming language) - Wikipedia");
  assert.equal(r[0].snippet, "Rust is a general-purpose programming language emphasizing performance & safety.");
  assert.equal(r[1].title, "std - Rust");
  assert.ok(!r.some((x) => /ads\.example|microsoft|bing\.com/.test(x.url)), "ads, footer and engine-own links are not results");
});

test("parseHtmlResults (Brave shape): title-class child wins over site name/breadcrumb, fragments dedupe", () => {
  const r = parseHtmlResults(BRAVE, "https://search.brave.com/search?q=rust");
  assert.deepEqual(r.map((x) => [x.title, x.url]), [
    ["Rust Programming Language", "https://rust-lang.org/"],
    ["Rust (programming language) - Wikipedia", "https://en.wikipedia.org/wiki/Rust_(programming_language)"],
  ]);
  assert.match(r[0].snippet, /^A language empowering everyone/);
});

test("parseHtmlResults (DuckDuckGo shape): uddg redirects decoded, y.js ads dropped, entities decoded", () => {
  const r = parseHtmlResults(DDG, "https://lite.duckduckgo.com/lite/");
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { title: "Software Engineer Jobs '24 - Example", url: "https://example.com/jobs",
                           snippet: "Find software engineer jobs in New York City." });
});

test("parseHtmlResults respects max and tolerates junk", () => {
  assert.equal(parseHtmlResults(BING, "https://www.bing.com/search?q=x", { max: 1 }).length, 1);
  assert.deepEqual(parseHtmlResults("<html>no results here</html>", "https://x.test/"), []);
  assert.deepEqual(parseHtmlResults(null, "https://x.test/"), []);
  assert.deepEqual(parseHtmlResults(BING, "not a url"), []);
});

test("parseJsonResults finds {url,title,snippet} objects anywhere (a SearXNG-style JSON API)", () => {
  const json = JSON.stringify({ query: "rust", results: [
    { url: "https://rust-lang.org/", title: "Rust", content: "A language empowering everyone." },
    { url: "https://rust-lang.org/", title: "dup", content: "" },
    { link: "https://doc.rust-lang.org/book/", name: "The Book", description: "Learn Rust." },
    { url: "https://searx.example/settings", title: "engine-own page" },
  ] });
  assert.deepEqual(parseJsonResults(json, "https://searx.example/search?q=rust&format=json"), [
    { title: "Rust", url: "https://rust-lang.org/", snippet: "A language empowering everyone." },
    { title: "The Book", url: "https://doc.rust-lang.org/book/", snippet: "Learn Rust." },
  ]);
  assert.deepEqual(parseJsonResults("{bad", "https://x.test/"), []);
});

test("searchEngine reports a bot wall, an HTTP error and a result-less page distinctly", async () => {
  const eng = { name: "E", url: "https://e.test/?q=%s" };
  assert.deepEqual(await searchEngine(eng, "q", { run: () => page(CLOUDFLARE, 403) }),
    { ok: false, reason: "blocked by a bot check (HTTP 403)" });
  assert.deepEqual(await searchEngine(eng, "q", { run: () => page("oops", 500) }), { ok: false, reason: "HTTP 500" });
  assert.deepEqual(await searchEngine(eng, "q", { run: () => page("<html><title>Captcha</title>solve the captcha</html>") }),
    { ok: false, reason: "blocked by a bot check" });
  assert.match((await searchEngine(eng, "q", { run: () => page("<div id=app></div>") })).reason, /no results.*JavaScript/);
  assert.deepEqual(await searchEngine(eng, "q", { run: () => ({ ok: false, reason: "the request timed out" }) }),
    { ok: false, reason: "the request timed out" });
  const json = await searchEngine(eng, "q", { run: () => page('{"results":[{"url":"https://a.test/","title":"A result"}]}', 200, "application/json") });
  assert.equal(json.ok, true);
  assert.equal(json.results[0].url, "https://a.test/");
});

test("injectWebSearch strips the server tool and injects results", () => {
  const body = subRequest("nyc jobs");
  injectWebSearch(body, "nyc jobs", { ok: true, engine: "Bing", results: [{ title: "T", url: "https://x.com", snippet: "S" }] });
  assert.deepEqual(body.tools, [], "the unrunnable web_search tool is removed");
  const text = body.messages[body.messages.length - 1].content;
  assert.match(text, /Web search results for "nyc jobs" \(via Bing\)/);
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

test("handleWebSearch falls through blocked/empty engines in order and stops at the first with results", async () => {
  const engines = [
    { name: "Yep", url: "https://yep.com/?q=%s" },
    { name: "Broken", url: "https://broken.test/?q=" },             // no %s -> skipped, never fetched
    { name: "Swisscows", url: "https://swisscows.com/en/web?query=%s" },
    { name: "Bing", url: "https://www.bing.com/search?q=%s" },
    { name: "Never", url: "https://never.test/?q=%s" },
  ];
  const fetched = [], logs = [];
  const fetchImpl = (url, e) => {
    fetched.push(url);
    if (e.name === "Yep") return page(CLOUDFLARE, 403);
    if (e.name === "Swisscows") return page("<div id=app></div>");
    if (e.name === "Bing") return page(BING);
    throw new Error("must not be reached");
  };
  const body = subRequest("rust language");
  assert.equal(await handleWebSearch(body, { engines, fetchImpl, log: (l) => logs.push(l) }), true);
  assert.deepEqual(fetched, ["https://yep.com/?q=rust%20language", "https://swisscows.com/en/web?query=rust%20language",
                             "https://www.bing.com/search?q=rust%20language"]);
  const text = body.messages[body.messages.length - 1].content;
  assert.match(text, /\(via Bing\)/);
  assert.match(text, /en\.wikipedia\.org\/wiki\/Rust_\(programming_language\)/);
  assert.deepEqual(body.tools, []);
  const all = logs.join("\n");
  assert.match(all, /skipping engine 'Broken' — its URL has no %s/);
  assert.match(all, /Yep FAILED: blocked by a bot check \(HTTP 403\)/);
  assert.match(all, /Swisscows FAILED: no results/);
});

test("handleWebSearch reports every engine's failure when none answers, and no-ops on ordinary requests", async () => {
  const engines = [{ name: "Yep", url: "https://yep.com/?q=%s" }, { name: "Qwant Lite", url: "https://lite.qwant.com/?q=%s" }];
  const body = subRequest("nyc jobs");
  await handleWebSearch(body, { engines, fetchImpl: (u, e) => e.name === "Yep" ? page(CLOUDFLARE, 403) : { ok: false, reason: "the request timed out" } });
  const text = body.messages[body.messages.length - 1].content;
  assert.match(text, /could not be completed \(every search engine failed — Yep: blocked by a bot check \(HTTP 403\); Qwant Lite: the request timed out\)/);

  const none = subRequest("x");
  await handleWebSearch(none, { engines: [] });
  assert.match(none.messages[0].content, /no usable search engine is configured/);

  // an ordinary request is untouched
  const plain = { tools: [{ name: "Bash" }], messages: [{ role: "user", content: "hello" }] };
  assert.equal(await handleWebSearch(plain, {}), false);
  assert.deepEqual(plain.tools, [{ name: "Bash" }]);
});
