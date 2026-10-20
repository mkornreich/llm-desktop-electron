// Kaggle Model Proxy credentials — mint, cache, refresh, and quota.
//
// WHY THIS EXISTS. Every other provider in this proxy carries a STATIC key: `providerAuth`
// reads it once from .openai-key at boot and that string is good forever. Kaggle is different.
// Kaggle's free "AI quota" (a daily/monthly USD inference budget, separate from the GPU/TPU
// accelerator hours) is spent through the Model Proxy — an OpenAI-compatible gateway at a
// per-account base URL. You do NOT authenticate to it with your long-lived Kaggle access token
// (the `KGAT_…` in ~/.kaggle/access_token). Instead you EXCHANGE that token for a short-lived
// proxy token + the proxy's base URL:
//
//   POST https://www.kaggle.com/api/v1/models/proxy/token   (Bearer <KGAT>, body `{}`)
//   -> { token: "<short-lived>", baseUri: "https://mp[-staging].kaggle.net/models", expiryTime: "<ISO>" }
//
// and then call `${baseUri}/openapi/chat/completions` with `Authorization: Bearer <token>`.
// The short-lived token expires, so something has to keep minting fresh ones. That is this module.
//
// HOW IT PLUGS IN WITHOUT TOUCHING THE HOT PATH. The proxy's routing reads two generic things for
// any provider: `PROVIDER_KEYS[keyName]` (the bearer) and `PROVIDERS[id].baseURL`. Both are plain
// mutable objects built at boot. So rather than special-casing "kaggle" in resolvePickedProvider /
// the catalog fetch / upstreamHeaders, this module just OVERWRITES those two fields on every
// refresh (via the `onRefresh` callback proxy.mjs supplies). Everything downstream stays
// provider-agnostic. If there is no KGAT token, nothing happens and the provider is simply inactive.
//
// NEVER logs a token value — only baseUri, expiry, and USD quota numbers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readConfig } = require("./jsonc.cjs");

// PROD Kaggle API hosts to try, in order. The public token currently mints a STAGING proxy
// (mp-staging.kaggle.net) — that is whatever `baseUri` the mint returns, which we use verbatim, so
// there is nothing env-specific hardcoded here. The two hosts are only about where the EXCHANGE
// lives; www.kaggle.com answers today, api.kaggle.com is the documented alternative.
const API_HOSTS = ["https://www.kaggle.com", "https://api.kaggle.com"];
const MINT_PATH = "/api/v1/models/proxy/token";
const QUOTA_PATH = "/api/v1/models/proxy/quota";
// Re-mint this long before the stated expiry, so a request never races a just-expired token.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
// Where the last good creds are cached, so a proxy restart within the token's lifetime reuses the
// token instead of re-minting. Lives in the app-local user-data dir (gitignored), beside the
// Electron profile run.sh points at (--user-data-dir="$PWD/user-data").
const CREDS_FILE = fileURLToPath(new URL("../user-data/.kaggle-proxy-creds.json", import.meta.url));

// ---- the long-lived Kaggle access token (KGAT) ----
// KAGGLE_API_TOKEN env wins (matches the kaggle CLI), then ~/.kaggle/access_token, then an optional
// `kaggleAccessToken` line in .openai-key for people who keep every secret in one place.
function readKgatToken() {
  const env = (process.env.KAGGLE_API_TOKEN || "").trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(path.join(os.homedir(), ".kaggle", "access_token"), "utf8").trim();
    if (t) return t;
  } catch { /* no file — fall through */ }
  try {
    for (const line of fs.readFileSync(fileURLToPath(new URL("../.openai-key", import.meta.url)), "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i > 0 && s.slice(0, i).trim() === "kaggleAccessToken") return s.slice(i + 1).trim();
    }
  } catch { /* no keyfile — fine */ }
  return "";
}
export function hasKaggleToken() { return !!readKgatToken(); }

// Append "/openapi" to the proxy base, tolerating a baseUri that already carries an /openapi or
// /genai suffix (the kaggle-benchmarks client strips those before re-adding — mirror that).
function openaiBase(baseUri) {
  const b = String(baseUri || "").replace(/\/(openapi|genai)$/i, "").replace(/\/+$/, "");
  return b + "/openapi";
}

let creds = null;          // { token, baseUri, baseURL, expiryTime, expiresAtMs }
let minting = null;        // in-flight mint promise (one at a time)
let refreshTimer = null;
let logFn = () => {};
let onRefreshCb = null;    // proxy.mjs's hook: ({token, baseURL}) => overwrite PROVIDER_KEYS + baseURL

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
    if (c && c.token && c.baseUri) {
      const expiresAtMs = Date.parse(c.expiryTime) || 0;
      if (expiresAtMs > Date.now() + MIN_REFRESH_MS) {
        creds = { ...c, baseURL: openaiBase(c.baseUri), expiresAtMs };
        return creds;
      }
    }
  } catch { /* no/!parse cache — fine */ }
  return null;
}
function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
    fs.writeFileSync(CREDS_FILE, JSON.stringify({ token: c.token, baseUri: c.baseUri, expiryTime: c.expiryTime }), { mode: 0o600 });
  } catch (e) { logFn(`kaggle: could not cache creds (${e.message})`); }
}

async function httpJson(url, { method = "GET", bearer, body, timeoutMs = 20000 } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { ok: r.ok, status: r.status, json, text };
}

// Exchange the KGAT token for a fresh short-lived proxy token. Tries each API host until one
// answers with a token. Throws if none do (caller decides whether that is fatal).
async function mintOnce() {
  const kgat = readKgatToken();
  if (!kgat) throw new Error("no Kaggle access token (~/.kaggle/access_token / KAGGLE_API_TOKEN)");
  let lastErr = null;
  for (const host of API_HOSTS) {
    try {
      const { ok, status, json } = await httpJson(host + MINT_PATH, { method: "POST", bearer: kgat, body: "{}" });
      if (ok && json && json.token && json.baseUri) {
        const expiresAtMs = Date.parse(json.expiryTime) || (Date.now() + 55 * 60 * 1000);
        const c = { token: json.token, baseUri: json.baseUri, baseURL: openaiBase(json.baseUri), expiryTime: json.expiryTime, expiresAtMs };
        creds = c; saveCache(c);
        logFn(`kaggle: minted proxy token via ${host} — base ${c.baseURL}, expires ${c.expiryTime}`);
        return c;
      }
      lastErr = new Error(`mint ${host} HTTP ${status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("mint failed");
}

// A fresh set of creds — the cached/in-memory one if it is comfortably unexpired, else a new mint.
export async function getCreds() {
  if (creds && creds.expiresAtMs > Date.now() + REFRESH_SKEW_MS) return creds;
  if (!minting) minting = mintOnce().finally(() => { minting = null; });
  return minting;
}
// Synchronous best-effort accessor (null until the first mint lands). Used only for seeding.
export function currentCreds() { return creds; }

// Force a re-mint NOW (the 401/403 backstop in obtainUpstream calls this). Publishes the fresh creds
// through onRefresh so the proxy's live token + baseURL update, and reschedules the proactive timer.
export async function forceRefresh() {
  creds = null;
  const c = await getCreds();
  if (onRefreshCb) onRefreshCb({ token: c.token, baseURL: c.baseURL });
  scheduleRefresh();
  return c;
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!creds) return;
  const delay = Math.max(MIN_REFRESH_MS, creds.expiresAtMs - Date.now() - REFRESH_SKEW_MS);
  refreshTimer = setTimeout(() => { refresh(); }, delay);
  if (refreshTimer.unref) refreshTimer.unref();   // never keep the process alive just for this
}
async function refresh() {
  try {
    creds = null;
    const c = await getCreds();
    if (onRefreshCb) onRefreshCb({ token: c.token, baseURL: c.baseURL });
    scheduleRefresh();
  } catch (e) {
    logFn(`kaggle: token refresh failed (${e.message}); retrying in 60s`);
    refreshTimer = setTimeout(() => refresh(), 60000);
    if (refreshTimer.unref) refreshTimer.unref();
  }
}

// Start the credential lifecycle. `onRefresh({token, baseURL})` is called once up front with the
// seeded/minted creds and again after every refresh — proxy.mjs uses it to overwrite
// PROVIDER_KEYS.kaggleProxyToken and PROVIDERS.kaggle.baseURL. Non-blocking: if no KGAT token is
// present it quietly does nothing. Returns a promise that resolves once the first mint settles
// (handy for a startup log), but callers need not await it.
export async function start({ onRefresh, log } = {}) {
  if (log) logFn = log;
  onRefreshCb = onRefresh || null;
  if (!readKgatToken()) { logFn("kaggle: no access token found — Kaggle provider inactive"); return null; }
  loadCache();                                   // seed from disk if still valid
  if (creds && onRefreshCb) onRefreshCb({ token: creds.token, baseURL: creds.baseURL });
  try {
    const c = await getCreds();                  // mint if the cache was missing/stale
    if (onRefreshCb) onRefreshCb({ token: c.token, baseURL: c.baseURL });
    scheduleRefresh();
    return c;
  } catch (e) {
    logFn(`kaggle: initial mint failed (${e.message}); provider will be inactive until it recovers`);
    scheduleRefresh();
    return null;
  }
}

// Current AI-quota balances in USD, or null on any failure. Free to call — reads the quota, spends
// nothing. Normalizes the bare-array response:
//   [ { refillPeriod:"daily", quotaUsed:0.0, totalQuotaAllowed:10.0, hasRefillTime:false }, {monthly…} ]
export async function getQuota() {
  const kgat = readKgatToken();
  if (!kgat) return null;
  for (const host of API_HOSTS) {
    try {
      const { ok, json } = await httpJson(host + QUOTA_PATH, { bearer: kgat });
      if (ok && json) {
        const arr = Array.isArray(json) ? json : (Array.isArray(json.quotaBalances) ? json.quotaBalances : []);
        return arr.map((b) => {
          const used = Number(b.quotaUsed ?? b.quota_used ?? 0);
          const total = Number(b.totalQuotaAllowed ?? b.total_quota_allowed ?? 0);
          return {
            period: String(b.refillPeriod ?? b.refill_period ?? "").toLowerCase(),
            used, total, remaining: Math.max(0, total - used),
            refillTime: b.refillTime ?? b.refill_time ?? null,
          };
        });
      }
    } catch { /* try next host */ }
  }
  return null;
}
