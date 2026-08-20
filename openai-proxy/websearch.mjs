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
// DDG's bot detection, while curl (HTTP/1.1, browser UA) fares better. DDG still rate-limits, so
// heavy use will throttle — an API-keyed backend would be sturdier, but this is keyless by request.
import { spawn } from "node:child_process";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const LITE_URL = "https://lite.duckduckgo.com/lite/";

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
export function fetchDdgLite(query, { timeoutMs = 12000, run } = {}) {
  if (run) return Promise.resolve(run(query));
  return new Promise((resolve) => {
    let child;
    const args = ["-sS", "-m", String(Math.max(3, Math.ceil(timeoutMs / 1000))), "-A", UA,
      "--data-urlencode", "q=" + query, LITE_URL];
    try { child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return resolve({ ok: false, reason: "curl is not available" }); }
    const out = []; let err = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, reason: "search timed out" }), timeoutMs + 2000);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => { if (err.length < 300) err += d; });
    child.on("error", () => finish({ ok: false, reason: "curl is not available" }));
    child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer);
      code === 0 ? resolve({ ok: true, html: Buffer.concat(out).toString("utf8") })
                 : resolve({ ok: false, reason: `search failed (curl ${code}${err ? ": " + err.trim().slice(0, 120) : ""})` }); });
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
export async function handleWebSearch(body, { log = () => {}, fetchImpl } = {}) {
  const query = webSearchQuery(body);
  if (!query) return false;
  const raw = await fetchDdgLite(query, { run: fetchImpl });
  const search = raw.ok ? { ok: true, results: parseDdgLite(raw.html) } : { ok: false, reason: raw.reason };
  injectWebSearch(body, query, search);
  log(`  web_search "${query.slice(0, 60)}" -> ${search.ok ? (search.results.length || 0) + " results" : "unavailable: " + search.reason}`);
  return true;
}
