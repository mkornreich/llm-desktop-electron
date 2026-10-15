// Web search for local models.
//
// Claude Code's `WebSearch` is Anthropic's SERVER-SIDE `web_search_20250305` tool: the CLI runs a
// search by sending a tiny sub-request — `"Perform a web search for the query: <q>"` plus the
// web_search server tool — to ANTHROPIC_BASE_URL, expecting the server to run the search and return
// results. When ANTHROPIC_BASE_URL is this proxy pointed at a local model, nothing executes the
// search, so it returns nothing. This module makes the PROXY the search executor: it detects those
// sub-requests, fetches a search engine's results page, injects the real results into the prompt,
// strips the (unrunnable) server tool, and lets the local model write the cited summary the
// sub-request is meant to produce. Fails soft — an unreachable search becomes an honest
// "unavailable" note, never a crash or an invented answer.
//
// Engines are an ORDERED list of { name, url } (config.jsonc tools.webSearchEngines), where `url` is
// the engine's results URL with `%s` standing for the URL-encoded query — the same shape a browser's
// "add search engine" dialog takes. They are tried in order and the first that yields results wins; a
// blocked, failing or empty engine falls through to the next. No engine is special-cased: results are
// pulled out of whatever the page is by a generic extractor (outbound result links + their headings and
// nearby text for HTML, {url,title,…} objects for a JSON API such as a SearXNG `format=json` instance).
//
// Pages are fetched via `curl`, not node's fetch: undici's TLS/HTTP2 fingerprint is refused by more
// engines' bot detection than curl's (HTTP/1.1, browser UA). The fetch forces IPv4 (`-4`): AAAA lookups
// stall to the timeout on some resolvers, which surfaced as `curl (28) Resolving timed out`. An engine
// that answers with a bot check (Cloudflare "Just a moment", DataDome, a captcha page) is reported as
// blocked and skipped — never solved or worked around. Measured from this machine 2026-10-15: Yep
// (Cloudflare), Qwant Lite (DataDome), Startpage (captcha, IP-level) and Swisscows (JS-only page) return
// no results to a plain fetch for ANY user agent; Brave Search and Bing do. `webSearchProxy` (curl -x)
// routes the fetches through another IP when an engine blocks this one.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The default engine order. Yep is the preferred engine; Brave and Bing come last as the fallbacks that
// currently answer a plain fetch.
export const DEFAULT_SEARCH_ENGINES = [
  { name: "Yep", url: "https://yep.com/?q=%s" },
  { name: "Qwant Lite", url: "https://lite.qwant.com/?q=%s" },
  { name: "Startpage", url: "https://www.startpage.com/sp/search?query=%s" },
  { name: "Swisscows", url: "https://swisscows.com/en/web?query=%s" },
  { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  { name: "Bing", url: "https://www.bing.com/search?q=%s" },
];

// Diagnostic dump of every web-search attempt (the raw request shape + outcome), so a failure can be
// traced without guessing. Appended to openai-proxy/websearch-debug.txt.
const DEBUG_FILE = fileURLToPath(new URL("./websearch-debug.txt", import.meta.url));
function dumpDebug(lines) { try { fs.appendFileSync(DEBUG_FILE, lines.filter((l) => l != null).join("\n") + "\n\n"); } catch { /* best effort */ } }

// A small pool of realistic, current desktop-browser UAs, rotated per request — engines throttle a
// fixed or obviously-bot UA far faster than ordinary-looking browser traffic.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// curl exit codes -> a human-readable reason, so a failed search says WHY (the model relays it).
function curlReason(code, err) {
  const known = {
    6: "DNS could not resolve the host",
    7: "the connection was refused",
    28: "the request timed out",
    35: "the TLS handshake failed",
    56: "the connection was reset",
  };
  return known[code] || `fetch failed (curl exit ${code}${err ? ": " + err.trim().slice(0, 100) : ""})`;
}

// ---- engines -------------------------------------------------------------------------------

// Coerce a configured engine list (an array, or its JSON text) into [{ name, url }]. Non-objects are
// dropped; fields are trimmed strings. Validity (http(s) + a %s) is checked separately, by
// engineProblem, so a bad entry can be reported rather than silently vanishing.
export function normalizeEngines(raw) {
  let list = raw;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === "object" && !Array.isArray(e))
    .map((e) => ({ name: String(e.name ?? "").trim(), url: String(e.url ?? "").trim() }));
}

// Why an engine entry cannot be used, or null when it can.
export function engineProblem(e) {
  if (!e || !e.url) return "has no URL";
  if (!/^https?:\/\/[^/\s]+/i.test(e.url)) return "is not an http(s) URL";
  if (!e.url.includes("%s")) return "has no %s for the search terms";
  return null;
}
const engineLabel = (e) => e.name || (() => { try { return new URL(e.url).hostname; } catch { return e.url || "(unnamed)"; } })();

// The results URL for `query`: every %s becomes the URL-encoded query.
export function engineUrl(template, query) {
  return String(template).split("%s").join(encodeURIComponent(String(query)));
}

// ---- detection -----------------------------------------------------------------------------

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === "string" ? b : b && (b.type === "text" || b.type === "input_text") ? b.text || "" : ""))
      .filter(Boolean).join("\n");
  return "";
}

const isWebSearchTool = (t) => /^web_search/.test(String(t?.type || "")) || String(t?.name || "") === "web_search";

// A Claude Code WebSearch sub-request carries a web_search server tool. Return the query string, or
// null when this is an ordinary request.
export function webSearchQuery(body) {
  if (!body || !Array.isArray(body.tools) || !body.tools.some(isWebSearchTool)) return null;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let text = "";
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") { text = contentText(msgs[i].content); break; }
  const m = text.match(/web search for the query:\s*([\s\S]+)/i);
  return ((m ? m[1] : text).trim()) || null;
}

// ---- fetch ---------------------------------------------------------------------------------

// GET `url` via curl. Resolves { ok:true, status, contentType, body } or { ok:false, reason }; never
// rejects. A 4xx/5xx still resolves ok:true (with its status) so the caller can tell a bot wall from
// a plain error.
const STATUS_MARK = "\n@@llmd-http@@";
export function fetchPage(url, { timeoutMs = 12000, proxy = "" } = {}) {
  return new Promise((resolve) => {
    let child;
    const args = [
      "-4",                                     // AAAA (IPv6) lookups stall on some resolvers; IPv4 resolves instantly
      "-sS", "-L", "--compressed", "-m", String(Math.max(3, Math.ceil(timeoutMs / 1000))),
      "--connect-timeout", "8",                 // fail fast on a genuinely blocked network instead of burning -m
      "-A", pickUA(),
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
      "-H", "Accept-Language: en-US,en;q=0.9",
      ...(proxy ? ["-x", proxy] : []),          // route through an HTTP/SOCKS proxy when configured
      "-w", STATUS_MARK + "%{http_code} %{content_type}",
      url,
    ];
    try { child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return resolve({ ok: false, reason: "curl is not available" }); }
    const out = []; let err = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, reason: "the request timed out" }), timeoutMs + 2000);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => { if (err.length < 300) err += d; });
    child.on("error", () => finish({ ok: false, reason: "curl is not available" }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, reason: curlReason(code, err) });
      const all = Buffer.concat(out).toString("utf8"), at = all.lastIndexOf(STATUS_MARK);
      const [status, ...ct] = (at < 0 ? "" : all.slice(at + STATUS_MARK.length)).split(" ");
      finish({ ok: true, status: parseInt(status, 10) || 0, contentType: ct.join(" "), body: at < 0 ? all : all.slice(0, at) });
    });
  });
}

// ---- parse ---------------------------------------------------------------------------------

const decodeEntities = (s) => String(s || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ""; } })
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const toText = (s) => decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// The registrable-ish site of a host (last two labels), so search.brave.com and brave.com — the engine's
// own pages, nav and "related searches" — are recognised as the engine rather than as results.
const siteOf = (host) => String(host || "").toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

// Sponsored / tracking links (DDG y.js, Bing aclick, Google aclk, ad-network hosts).
const AD_RE = /\/aclk\b|\/aclick\b|[?&]ad_(?:domain|provider)=|\/y\.js\b|doubleclick\.net|googleadservices\.com/i;

function b64urlToUrl(s) {
  try {
    const t = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\/\S+$/i.test(t) ? t : null;
  } catch { return null; }
}
// An engine-hosted redirect (DDG /l/?uddg=<url>, Bing /ck/a?…&u=a1<base64url>, a generic ?url=/?u=/?q=)
// unwrapped to its destination; null for any other engine-own link. A link off the engine is itself.
function unwrapRedirect(abs, own) {
  let url; try { url = new URL(abs); } catch { return null; }
  if (siteOf(url.hostname) !== own) return url.href;
  for (const [, v] of url.searchParams) {
    if (/^https?:\/\//i.test(v)) return v;
    const b = /^a1[\w-]{8,}$/.test(v) ? b64urlToUrl(v.slice(2)) : null;
    if (b) return b;
  }
  return null;
}
const attr = (attrs, name) => {
  const m = String(attrs).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

// Generic HTML results extractor: [{title, url, snippet}] in page order. A result is an outbound link
// (off the engine's own site, redirects unwrapped, ads dropped) titled by its heading (<h2><a>…</a></h2>,
// <a><h3>…</h3></a>), else by a child with a "title" class, else by its text; its snippet is the text
// that follows it up to the next result. Page chrome (header/nav/footer, scripts) is removed first.
export function parseHtmlResults(html, pageUrl, { max = 8 } = {}) {
  let base; try { base = new URL(pageUrl); } catch { return []; }
  const own = siteOf(base.hostname);
  const src = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|header|footer|nav)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const byUrl = new Map(), order = [];
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(m[1], "href");
    if (!href || /^\s*(#|javascript:|mailto:|tel:)/i.test(href) || AD_RE.test(href)) continue;
    let abs; try { abs = new URL(decodeEntities(href), base).href; } catch { continue; }
    const real = unwrapRedirect(abs, own);
    if (!real || !/^https?:/i.test(real) || AD_RE.test(real)) continue;
    const host = hostOf(real);
    if (!host || siteOf(host) === own) continue;
    const key = real.replace(/#.*$/, "");
    const inner = m[2].replace(/<cite\b[\s\S]*?<\/cite\s*>/gi, " ");   // <cite> = URL breadcrumbs, not a title
    const innerHeading = inner.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i);
    const wrapped = /<h[1-6]\b[^>]*>(?:(?!<\/h[1-6]\s*>)[\s\S])*$/i.test(src.slice(Math.max(0, m.index - 300), m.index));
    const classed = inner.match(/<([a-z0-9]+)\b[^>]*\bclass\s*=\s*["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/i);
    const [rank, title] = innerHeading ? [3, toText(innerHeading[1])] : wrapped ? [3, toText(inner)]
      : classed ? [2, toText(classed[2])] : [1, toText(inner)];
    let e = byUrl.get(key);
    if (!e) { e = { url: key, title: "", rank: 0, start: m.index, end: m.index + m[0].length }; byUrl.set(key, e); order.push(e); }
    if (title && title.length <= 200 && (rank > e.rank || (rank === e.rank && title.length > e.title.length))) {
      e.title = title; e.rank = rank; e.end = m.index + m[0].length;   // the snippet follows the TITLE link
    }
  }
  // A bare link needs a title-like text (two+ words) to count; heading/title-class links need any text.
  const hits = order.filter((e) => e.title.length >= 3 && (e.rank >= 2 || (e.title.length >= 10 && /\s/.test(e.title))));
  return hits.slice(0, max).map((e, i) => {
    const stop = Math.min(hits[i + 1] ? hits[i + 1].start : Infinity, e.end + 2500);
    let snippet = toText(src.slice(e.end, Math.max(e.end, stop)).replace(/<cite\b[\s\S]*?<\/cite\s*>/gi, " "));
    if (snippet.startsWith(e.title)) snippet = snippet.slice(e.title.length).trim();
    return { title: e.title, url: e.url, snippet: snippet.length > 300 ? snippet.slice(0, 297) + "..." : snippet };
  });
}

// Generic JSON results extractor (a search API, e.g. SearXNG ?format=json): every object carrying an
// http(s) url/link/href plus a title/name is a result; its snippet is content/snippet/description/….
export function parseJsonResults(json, pageUrl, { max = 8 } = {}) {
  let data = json;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return []; } }
  const own = siteOf(hostOf(pageUrl));
  const str = (o, ks) => { for (const k of ks) if (typeof o[k] === "string" && o[k].trim()) return o[k]; return ""; };
  const out = [], seen = new Set();
  const walk = (x, depth) => {
    if (out.length >= max || depth > 12 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    const url = str(x, ["url", "link", "href"]), title = str(x, ["title", "name"]);
    if (/^https?:\/\//i.test(url) && title && !AD_RE.test(url) && siteOf(hostOf(url)) !== own) {
      if (!seen.has(url)) {
        seen.add(url);
        const snippet = toText(str(x, ["content", "snippet", "description", "desc", "body", "text", "abstract"]));
        out.push({ title: toText(title), url, snippet: snippet.length > 300 ? snippet.slice(0, 297) + "..." : snippet });
      }
      return;
    }
    for (const v of Object.values(x)) walk(v, depth + 1);
  };
  walk(data, 0);
  return out;
}

// A bot check instead of results: Cloudflare's interstitial, DataDome, a captcha / "blocked" page.
const BOT_WALL_RE = /challenges\.cloudflare\.com|<title>\s*(?:just a moment|attention required|access denied)|datadome|ddjskey|captcha-delivery|captcha|<title>[^<]*\bblocked\b/i;

// One engine, start to finish: { ok:true, results } with at least one result, or { ok:false, reason }.
// `run(url, engine)` replaces the network fetch (tests).
export async function searchEngine(engine, query, { proxy = "", run } = {}) {
  const url = engineUrl(engine.url, query);
  const r = run ? await run(url, engine) : await fetchPage(url, { proxy });
  if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "fetch failed" };
  const body = String(r.body ?? "");
  const walled = BOT_WALL_RE.test(body);
  if (r.status >= 400) return { ok: false, reason: walled ? `blocked by a bot check (HTTP ${r.status})` : `HTTP ${r.status}` };
  const json = /json/i.test(r.contentType || "") || /^\s*[[{]/.test(body);
  const results = json ? parseJsonResults(body, url) : parseHtmlResults(body, url);
  if (results.length) return { ok: true, results, bytes: body.length };
  return { ok: false, reason: walled ? "blocked by a bot check" : "no results in the page (it may need JavaScript)" };
}

// ---- body rewrite --------------------------------------------------------------------------

function setLastUserText(body, text) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") { msgs[i] = { ...msgs[i], content: text }; return; }
  body.messages = [...msgs, { role: "user", content: text }];
}

// Replace the "Perform a web search…" prompt with the real results (or an honest failure note), and
// strip the server tool the local model cannot run. The model then writes the cited summary.
export function injectWebSearch(body, query, search) {
  if (Array.isArray(body.tools)) body.tools = body.tools.filter((t) => !isWebSearchTool(t));
  const text = (search.ok && search.results.length)
    ? `Web search results for "${query}"${search.engine ? ` (via ${search.engine})` : ""}:\n\n` +
      search.results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}${x.snippet ? "\n" + x.snippet : ""}`).join("\n\n") +
      `\n\nAnswer the query using ONLY these results, and cite each fact with its source URL. If the results do not answer it, say so.`
    : `A web search for "${query}" could not be completed (${search.reason || "no results found"}). Tell the user the web search was unavailable; do NOT invent results.`;
  setLastUserText(body, text);
  return body;
}

// The whole flow: if `body` is a WebSearch sub-request, run the search — each engine in order until one
// yields results — and rewrite it in place. Returns true if handled (body was rewritten), false otherwise.
const toolSig = (body) => Array.isArray(body?.tools) ? body.tools.map((t) => t?.type || t?.name || "?").join(", ") : "(no tools)";
const lastUserText = (body) => {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") return contentText(msgs[i].content);
  return "";
};

export async function handleWebSearch(body, { log = () => {}, proxy = "", engines = DEFAULT_SEARCH_ENGINES, fetchImpl } = {}) {
  const query = webSearchQuery(body);
  if (!query) {
    // A near-miss: a request carrying a search-ish tool that we did NOT route. Surfacing these tells
    // "the sub-request never looked like a search" apart from "the search itself failed".
    const sig = toolSig(body);
    if (/search/i.test(sig)) {
      log(`  web_search NOT routed — tools=[${sig}] last-user="${lastUserText(body).slice(0, 100)}"`);
      dumpDebug(["=== web_search candidate NOT routed ===", "tools: " + sig,
                 "msgs: " + (Array.isArray(body?.messages) ? body.messages.length : 0),
                 "lastUser: " + lastUserText(body).slice(0, 500)]);
    }
    return false;
  }
  const all = normalizeEngines(engines);
  const usable = all.filter((e) => !engineProblem(e));
  for (const e of all) { const p = engineProblem(e); if (p) log(`  web_search: skipping engine '${engineLabel(e)}' — its URL ${p}`); }
  log(`  web_search: "${query.slice(0, 100)}"${proxy ? " via " + proxy : " (direct)"} — engines: ${usable.map(engineLabel).join(" > ") || "(none)"}`);
  const failures = [];
  let search = null;
  for (const e of usable) {
    const name = engineLabel(e);
    const r = await searchEngine(e, query, { proxy, run: fetchImpl });
    if (r.ok) {
      search = { ok: true, engine: name, results: r.results };
      log(`  web_search ${name}: ${r.results.length} results`);
      dumpDebug([`=== web_search "${query}" via ${name} -> ${r.results.length} results ===`,
                 ...failures.map((f) => "  (fell past " + f + ")"),
                 r.results.map((x, i) => `  [${i + 1}] ${x.title} | ${x.url}`).join("\n")]);
      break;
    }
    failures.push(`${name}: ${r.reason}`);
    log(`  web_search ${name} FAILED: ${r.reason}`);
  }
  if (!search) {
    const reason = !usable.length ? "no usable search engine is configured"
      : failures.length === 1 ? failures[0] : `every search engine failed — ${failures.join("; ")}`;
    search = { ok: false, reason };
    dumpDebug([`=== web_search "${query}" — FAILED ===`, "reason: " + reason, "proxy: " + (proxy || "(direct)")]);
  }
  injectWebSearch(body, query, search);
  dumpDebug(["injected (" + (search.ok ? search.results.length + " results" : "unavailable") + "); tools now: [" + toolSig(body) + "]"]);
  return true;
}
