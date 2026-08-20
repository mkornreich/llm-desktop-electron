// Web search for local models.
//
// Claude Code's `WebSearch` is Anthropic's SERVER-SIDE `web_search_20250305` tool: the CLI runs a
// search by sending a tiny sub-request — `"Perform a web search for the query: <q>"` plus the
// web_search server tool — to ANTHROPIC_BASE_URL, expecting the server to run the search and return
// results. When ANTHROPIC_BASE_URL is this proxy pointed at a local model, nothing executes the
// search, so it returns nothing. This module makes the PROXY the search executor: it detects those
// sub-requests, scrapes DuckDuckGo's lite endpoint, injects the real results into the prompt, strips
// the (unrunnable) server tool, and lets the local model write the cited summary the sub-request is
// meant to produce. Fails soft — an unreachable search becomes an honest "unavailable" note, never a
// crash or an invented answer.
//
// DuckDuckGo is scraped via `curl`, not node's fetch: undici's TLS/HTTP2 fingerprint gets blocked by
// DDG's bot detection, while curl (HTTP/1.1, browser UA) fares better. The fetch forces IPv4 (`-4`):
// `lite.duckduckgo.com`'s AAAA (IPv6) lookup stalls to the timeout on some resolvers, which surfaced
// as `curl (28) Resolving timed out`; its A record resolves instantly, so IPv4 sidesteps the hang.
// DDG still rate-limits, so heavy use will throttle — an API-keyed backend would be sturdier, but
// this is keyless by request.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Diagnostic dump of every web-search attempt (the raw request shape + outcome), so a failure can be
// traced without guessing. Appended to openai-proxy/websearch-debug.txt.
const DEBUG_FILE = fileURLToPath(new URL("./websearch-debug.txt", import.meta.url));
function dumpDebug(lines) { try { fs.appendFileSync(DEBUG_FILE, lines.filter((l) => l != null).join("\n") + "\n\n"); } catch { /* best effort */ } }

// A small pool of realistic, current desktop-browser UAs, rotated per request — DuckDuckGo throttles
// a fixed or obviously-bot UA far faster than ordinary-looking browser traffic.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const LITE_URL = "https://lite.duckduckgo.com/lite/";

// curl exit codes -> a human-readable reason, so a failed search says WHY (the model relays it).
function curlReason(code, err) {
  const known = {
    6: "DNS could not resolve DuckDuckGo",
    7: "the connection to DuckDuckGo was refused",
    28: "the request to DuckDuckGo timed out",
    35: "the TLS handshake with DuckDuckGo failed",
    56: "the connection to DuckDuckGo was reset",
  };
  return known[code] || `search failed (curl exit ${code}${err ? ": " + err.trim().slice(0, 100) : ""})`;
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

// ---- fetch + parse -------------------------------------------------------------------------

// Scrape DDG lite via curl. Resolves { ok:true, html } or { ok:false, reason }; never rejects.
// `run` is injectable so tests need not hit the network.
export function fetchDdgLite(query, { timeoutMs = 12000, proxy = "", run } = {}) {
  if (run) return Promise.resolve(run(query));
  return new Promise((resolve) => {
    let child;
    const args = [
      "-4",                                     // DDG's AAAA (IPv6) record stalls DNS; forcing IPv4 resolves instantly
      "-sS", "-L", "-m", String(Math.max(3, Math.ceil(timeoutMs / 1000))),
      "--connect-timeout", "8",                 // fail fast on a genuinely blocked network instead of burning -m
      "-A", pickUA(),
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-H", "Accept-Language: en-US,en;q=0.9",
      ...(proxy ? ["-x", proxy] : []),          // route through an HTTP/SOCKS proxy when configured
      "--data-urlencode", "q=" + query, LITE_URL,
    ];
    try { child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return resolve({ ok: false, reason: "curl is not available" }); }
    const out = []; let err = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, reason: "the request timed out" }), timeoutMs + 2000);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => { if (err.length < 300) err += d; });
    child.on("error", () => finish({ ok: false, reason: "curl is not available" }));
    child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer);
      code === 0 ? resolve({ ok: true, html: Buffer.concat(out).toString("utf8") })
                 : resolve({ ok: false, reason: curlReason(code, err) }); });
  });
}

const stripTags = (s) => String(s || "")
  .replace(/<[^>]+>/g, "")
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

// DDG lite hrefs are `//duckduckgo.com/l/?uddg=<url-encoded real url>&…` redirects.
function realUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  let u = m ? decodeURIComponent(m[1]) : href;
  if (u.startsWith("//")) u = "https:" + u;
  return u;
}
// Ad links route through duckduckgo.com/y.js and carry ad_domain/ad_provider — all present as
// substrings even in the URL-encoded href, so match loosely rather than on exact `/` and `=`.
const isAd = (href) => /y\.js|ad_provider|ad_domain/i.test(String(href || ""));

// Parse DDG lite HTML into [{title, url, snippet}], ads removed. Result links and snippet cells are
// 1:1 in document order, so snippet[i] pairs with link[i] BEFORE ads are filtered.
export function parseDdgLite(html, { max = 8 } = {}) {
  const src = String(html || "");
  const links = [...src.matchAll(/<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const snips = [...src.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
  const results = [];
  for (let i = 0; i < links.length && results.length < max; i++) {
    if (isAd(links[i][1])) continue;
    const title = stripTags(links[i][2]);
    if (title) results.push({ title, url: realUrl(links[i][1]), snippet: snips[i] || "" });
  }
  return results;
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
    ? `Web search results for "${query}":\n\n` +
      search.results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}${x.snippet ? "\n" + x.snippet : ""}`).join("\n\n") +
      `\n\nAnswer the query using ONLY these results, and cite each fact with its source URL. If the results do not answer it, say so.`
    : `A web search for "${query}" could not be completed (${search.reason || "no results found"}). Tell the user the web search was unavailable; do NOT invent results.`;
  setLastUserText(body, text);
  return body;
}

// The whole flow: if `body` is a WebSearch sub-request, run the search and rewrite it in place.
// Returns true if handled (body was rewritten), false otherwise.
const toolSig = (body) => Array.isArray(body?.tools) ? body.tools.map((t) => t?.type || t?.name || "?").join(", ") : "(no tools)";
const lastUserText = (body) => {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") return contentText(msgs[i].content);
  return "";
};

export async function handleWebSearch(body, { log = () => {}, proxy = "", fetchImpl } = {}) {
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
  log(`  web_search: "${query.slice(0, 100)}"${proxy ? " via " + proxy : " (direct)"}`);
  const raw = await fetchDdgLite(query, { proxy, run: fetchImpl });
  let search;
  if (!raw.ok) {
    search = { ok: false, reason: raw.reason };
    log(`  web_search FETCH FAILED: ${raw.reason}`);
    dumpDebug([`=== web_search "${query}" — FETCH FAILED ===`, "reason: " + raw.reason, "proxy: " + (proxy || "(direct)")]);
  } else {
    const results = parseDdgLite(raw.html);
    search = { ok: true, results };
    log(`  web_search fetch ok: ${raw.html.length} bytes -> ${results.length} results`);
    dumpDebug([`=== web_search "${query}" -> ${results.length} results (${raw.html.length} bytes) ===`,
               results.length ? results.map((r, i) => `  [${i + 1}] ${r.title} | ${r.url}`).join("\n")
                              : "  0 RESULTS. html head: " + raw.html.replace(/\s+/g, " ").slice(0, 400)]);
  }
  injectWebSearch(body, query, search);
  dumpDebug(["injected (" + (search.ok ? (search.results?.length || 0) + " results" : "unavailable") + "); tools now: [" + toolSig(body) + "]"]);
  return true;
}
