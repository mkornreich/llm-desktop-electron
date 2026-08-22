# Anthropic endpoints used by the Claude Desktop app

A reverse-engineering audit of every Anthropic endpoint the app calls, the payload
for each, and what the app uses Anthropic for. Compiled from a static sweep of the
bundled main-process code (`app/.vite/build/*.js`) plus a live capture of the chat
completion request.

**Two request origins**
- **Main process** (the Electron desktop shell — bundle code).
- **Remote claude.ai web app** loaded in the window (the chat product, MCP directory
  browsing, analytics). Marked where relevant.

**Base hosts**
- `api.anthropic.com` — inference + OAuth + agent control-plane
- `claude.ai` — web product + org/account APIs (cookie-auth)
- `platform.claude.com` — console OAuth
- `downloads.claude.ai` — updates / VM images
- `assets.claude.ai` — fonts
- `*.mcp.claude.com` / `mcp-proxy.anthropic.com` — MCP connectors

**Shared headers** on authenticated calls: `anthropic-version: 2023-06-01`,
`anthropic-beta: oauth-2025-04-20`, `anthropic-client-platform: desktop_app`,
`anthropic-client-version: {app version}`, `anthropic-client-app: com.anthropic.claudefordesktop`.

> After the OpenAI repurposing in this repo, the agent's `/v1/messages` and the
> auto-mode safety classifier no longer reach Anthropic — they hit the local proxy
> (`openai-proxy/proxy.mjs`) → OpenAI. Everything else below is still Anthropic.

---

## 1. Authentication / OAuth

**Flow A — desktop sign-in (upgrades your claude.ai web session to OAuth tokens)**
- `POST api.anthropic.com/v1/oauth/{orgId}/authorize` — header `Authorization: Bearer {sessionKey cookie}`; body `{response_type:"code", client_id:"89355bc3-cbfd-4382-905b-976645cad410", organization_uuid, redirect_uri:"https://claude.ai/desktop/callback", scope:"user:inference", state, code_challenge, code_challenge_method:"S256"}` → returns an auth `code`.
- `POST api.anthropic.com/v1/oauth/token` — body `{grant_type:"authorization_code", client_id, code, redirect_uri, code_verifier, expires_in}` → `{access_token, refresh_token, expires_in, scope}`. Same endpoint with `grant_type:"refresh_token"` for renewals.

**Flow B — Console API-key mint (`claude_cli`)**
- `GET platform.claude.com/oauth/authorize?response_type=code&client_id=9d1c250a-…&code_challenge&code_challenge_method=S256&redirect_uri&state&scope` (browser consent) → code to `console.anthropic.com/oauth/code/callback`.
- `POST platform.claude.com/v1/oauth/token` — code→token exchange (+ refresh).
- `POST api.anthropic.com/api/oauth/claude_cli/create_api_key` (Bearer) → `{raw_key}` — mints a long-lived API key. 400 → `ORG_NOT_API`.
- `GET api.anthropic.com/api/oauth/profile` (Bearer) → `{organization.uuid, account.email, account.full_name}`.
- `api.anthropic.com/api/oauth/claude_cli/roles` — defined in config, **no call site found** (unused in this build).

**Device enrollment**
- `POST api.anthropic.com/api/auth/trusted_devices` (Bearer) — body `{display_name:"Claude Desktop on {host} · {platform}"}` → `{device_token}`. Gated by flag `claude_code_trusted_devices_required`.

**Redirect callbacks** (parsed locally, not network calls): `claude.ai/desktop/callback`, `console.anthropic.com/oauth/code/callback`, `platform.claude.com/oauth/code/callback`.

**Used for:** proving identity and obtaining the Bearer tokens every other authenticated call uses.

---

## 2. Bootstrap / account / org / feature flags  (host `claude.ai`, cookie-auth)

- `GET /api/bootstrap` — no body → `{account{uuid,email_address,display_name,full_name,memberships[].organization{uuid,capabilities}}, …}`. The main account/org load. (Full payload also carries `current_user_access`, `statsig`, `growthbook{features}`, `model_selector_config`, `system_prompts`.)
- `GET /api/bootstrap/{org}/current_user_access` → `{features:[{feature,status}]}` (enabled when `status==="available"`; polled ~1h/5m).
- `GET /api/bootstrap/{org}/cowork_sysprompt_map` — Cowork/local-agent system-prompt map.
- `GET api.anthropic.com/api/claude_cli/bootstrap?entrypoint=local-agent&model={model}` (Bearer) → `{client_data}`.
- `GET/PUT /api/account_profile` — PUT body `{cowork_global_instructions}` (Cowork "global memory" sync); headers `X-Client-Platform: cowork-desktop`, `x-organization-uuid`.
- `GET /api/organizations/{org}` → `settings.is_desktop_extension_allowlist_enabled`.
- `GET /api/desktop/features` — GrowthBook `{features:{<key>:{on,value,…}}}`; cached to disk.

**Used for:** who's logged in, which org, entitlements/feature flags, remote config.

---

## 3. The chat product  (host `claude.ai`, issued by the **remote web app**)

The desktop bundle does not build these — the loaded claude.ai web app does. **Live-captured completion request:**
- `POST /api/organizations/{org}/chat_conversations/{id}/completion` — body `{"prompt":"hello","model":"claude-opus-5","effort":"high","thinking_mode":"auto","timezone","locale","tools":[…]}`. **No conversation history in the body** — it's server-side, keyed by `{id}`. Streams a proprietary SSE (`assistant_message` / `completion`). Also `.../completion2`, `.../retry_completion`.
- `GET /api/organizations/{org}/chat_conversations_v2?limit=&starred=&consistency=eventual` → `{data:[{uuid,name,summary,model,…}]}` (sidebar list).

**Bundle-issued chat calls (Cowork-specific):**
- `DELETE /api/organizations/{org}/chat_conversations/{id}` — un-share a Cowork artifact (404 treated as success).
- `POST /api/organizations/{org}/conversations/{id}/wiggle/upload-file` — multipart `file` upload into a local-agent conversation.

**Used for:** the entire main chat experience — server-hosted conversations + streaming completions. (This server-side state is why chat can't be redirected to OpenAI.)

---

## 4. MCP / connectors / tool directory

- `POST claude.ai/api/organizations/{org}/mcp/servers/{id}/tools/call` — body `{tool_name, arguments}` → `{content[], is_error, structured_content, _meta}`. Remote MCP tool execution, proxied through Anthropic. Header `x-mcp-client-name` (`ClaudeCodeDesktop`/`Cowork`).
- `POST …/mcp/servers/{id}/resources/read` — body `{uri}` → `{contents}`.
- `GET …/mcp/servers/{id}/resources/list` → `{resources}`.
- `mcp-proxy.anthropic.com/v1/mcp/{server_id}` — streamable-HTTP proxy the agent uses to reach remote MCP servers (dev: `localhost:8205/v1/toolbox/shttp/mcp/{server_id}`).
- `microsoft365.mcp.claude.com/mcp` — Anthropic-hosted M365 connector (OAuth to Azure AD app `07c030f6-…`).
- `api.anthropic.com/mcp-registry/` and `/api/directory/servers` — MCP directory (CSP-allowlisted in bundle; **browsed by the web app** — observed at runtime: `GET /api/directory/servers?limit=500&visibility=…&verified_tier=…&cursor=…`).

Built-in connectors catalog: M365 (remote + local), Web search (Brave), Box (non-Anthropic). OAuth scope list includes `user:mcp_servers`.

**Used for:** discovering MCP servers and executing MCP tools (Anthropic-hosted/proxied).

---

## 5. Agent / Claude Code control-plane + inference  (host `api.anthropic.com`)

- `POST /v1/messages` (+ `?beta=true`, `/count_tokens`, `/batches`, `/batches/{id}` …) — **Messages API**, standard body `{model, messages, max_tokens, system, tools, stream}`. The agent inference (now redirected to OpenAI by the proxy).
- `GET /v1/models` (+`?limit=1000`, `/{id}`) — model discovery / gateway health check.
- **Managed-agents bridge** (`anthropic-beta: managed-agents-2026-04-01`, Bearer, `x-environment-runner-version`):
  - `POST /v1/environments/bridge` — body `{machine_name, directory?, metadata?, environment_id?}` → `{environment_id}`.
  - `GET /v1/environments/{id}/work/poll` — long-poll for queued work → `{id, data{type,…}}`.
  - `POST /v1/environments/{id}/work/{id}/ack|stop|heartbeat` (`stop` body `{force}`).
  - `POST /v1/sessions` — headers add `anthropic-beta: ccr-byoc-2025-07-29`; body `{title, events:[], environment_id, session_context{sources:[]}, tags}` → `{id}`.
  - `GET /v1/sessions/{id}/events/stream` (SSE), `POST /v1/sessions/{id}/events`, `…/resources`, `…/threads/{id}/archive`.
  - `DELETE /v1/environments/bridge/{id}` — deregister runner.
- `GET /api/claude_code/settings` (Bearer) → `{settings}` — remote-managed settings.
- `GET/PUT /api/claude_code/memory?scope=user&repo={org}/{repo}` — ETag concurrency; GET → `{checksum, content{entries, entryChecksums}}`; PUT body `{entries, soft_delete_keys}`.
- `GET /api/claude_code/policy_limits` (Bearer, 3s) → `{restrictions, compliance_taints[], defaults}`.
- `POST /api/claude_cli_feedback/bundle` — feedback upload.

**Used for:** agent inference + orchestration (remote environments/sessions), settings, memory sync, policy/compliance.

---

## 6. Telemetry / logging  (host `claude.ai` + configurable)

- `POST claude.ai/api/event_logging/v2/batch` — header `x-service-name: claude_desktop`; body `{events:[…]}` batched (50) with rich device metadata (`app_version, commit_hash, platform, arch, os_build, cpu_model, total/free/available_memory, org uuid`) and named events (`lam_mcp_tool_call_completed`, `lam_dispatch_list_sessions`, …). Retries on 429/5xx. **Primary product/usage telemetry.**
- `POST {otlpEndpoint}/v1/logs` — OpenTelemetry logs, **only if an enterprise admin configures `otlpEndpoint`** (customer-controlled; not Anthropic by default). Sets `OTEL_*` env on spawned Cowork/Code sessions.
- `api.anthropic.com` — the "nonessential telemetry" host permitted through the Cowork VM egress allowlist (config, not a request from this code).
- `a.claude.ai/isolated-segment.html` — Datadog/Segment analytics iframe (observed at runtime; loaded by the **web renderer**, not the bundle).

**First-party-proxied analytics (renderer; found by auditing live traffic — *not* callable from the bundle, so a code-only audit misses them):**

- `GET s-cdn.anthropic.com/s.js` then `GET s-cdn.anthropic.com/images/<n>.gif?…` — tracker script plus **GIF pixel beacons**, query string carrying session/user identifiers.
- `GET a-cdn.anthropic.com/v1/projects/<writeKey>/settings` + `/next-integrations/actions/amplitude-plugins/*.js` — this is **Segment's `analytics.js`** served from an Anthropic host, so a `*segment.com` blocklist never matches it. Pulls in an Amplitude plugin.
- `POST a-api.anthropic.com/v1/b` (Segment **batch**), `/v1/m` — the actual event egress.

**Third-party sinks (NOT Anthropic):** Sentry (`o1158394.ingest.us.sentry.io`), Datadog (`browser-intake-*-datadoghq.com`).

**Not telemetry (do not block):** `a.claude.ai/cdn-cgi/challenge-platform/…` is Cloudflare bot management — security infrastructure, and blocking it risks challenges or lockout. `api.github.com` is the functional GitHub integration. Intercom, DoubleClick/Google Ads and the Meta Pixel were **not** observed: zero requests across full 90s desktop runs.

**Used for:** usage analytics, crash/error reporting, optional enterprise OTLP.

> **Turning this section off.** Everything above is disabled by `DISABLE_TELEMETRY=1`
> in the **`.privacy`** dot file (read by `run.sh`, so it covers `run-proxy.sh` too).
> It takes three levers, because there are three independent telemetry paths: env vars
> for the bundled Claude Code agent; `PRIVACY_DISABLE_TELEMETRY` + env-gated patches in
> `index.chunk-CnWKsyE_.js` for the desktop shell (whose gates are otherwise reachable
> only from a root-owned MDM plist); and `--host-resolver-rules` DNS sinkholing for the
> remote web app's own Datadog/Sentry, which run in the renderer and consult neither.
> Verified with `--log-net-log`: `[EventLogging]` flushes drop 56→0 per 90s, the app
> logs `Sentry disabled (disableEssentialTelemetry)`, `isolated-segment.html` is
> `ERR_BLOCKED_BY_CLIENT`, Datadog attempts resolve to `ERR_NAME_NOT_RESOLVED` with
> **0 bytes sent**, and the first-party-proxied analytics hosts above sit at **0
> requests / 0 bytes** — while `api.anthropic.com` (1.6 MB), `assets-proxy` (5.4 MB),
> the `claude.ai` app APIs (722 KB) and the GitHub integration all still work and the
> app stays logged in. Set the flag to `0` to restore stock behavior (control-tested:
> telemetry returns).
>
> Two traps worth knowing if you extend this. **Exact hostnames** are required for the
> `*.anthropic.com` analytics hosts — a `*anthropic.com` pattern would also sinkhole
> `api.anthropic.com` (inference) and `assets-proxy.anthropic.com` (the web app's own
> JS). And **DNS blocking does not stop cached code**: the Segment/Amplitude bundles
> were observed loading from `HTTP_CACHE_READ_DATA` with zero network events, which is
> why those hosts are in the webRequest canceller too — it runs before the cache lookup.

---

## 7. Updates / assets / extensions / plugins

- `GET downloads.claude.ai/claude-code-releases/{ver}/manifest.zst.json` (+ `.raw-sig.json`, signature-verified against embedded PEM) — signed self-update; also `downloads.claude.ai/claude-ssh-releases`.
- `GET downloads.claude.ai/releases/darwin/universal/{ver}/vm_hash` and `downloads.claude.ai/vms/linux/{arch}/{sha}/{file}` — Cowork VM image hash + download/pre-warm.
- `GET assets.claude.ai/Fonts/AnthropicSerif-Text-{Weight}[Italic]-Static.otf` (8 files) — app webfonts.
- `GET claude.ai/api/organizations/{org}/dxt/blocklist` → `{entries[]}`; `POST …/dxt/can_install` — body: extensions `{extensionId, hash, source, signatureInfo, manifest}` → `{results:{<id>:{can_install, reason?}}}`.
- Plugins (host `claude.ai`): `GET /api/organizations/{org}/plugins/list-plugins?enabled_only&compact&limit&offset`, `…/account-list-plugins`, `GET …/plugins/enabled-state`, `PUT …/plugins/{name}/enabled` `{enabled}`, `GET …/plugins/{name}/download`, `GET …/plugins/by-name/{name}`, `POST …/plugins/account-upload?overwrite`.

**Used for:** self-update, Cowork VM images, fonts, desktop-extension allow/block checks, plugin catalog + install.

---

## Everything the app uses Anthropic for (summary)

1. **Identity/auth** — sign-in, token mint/refresh, API-key mint, trusted-device enrollment.
2. **The main chat** — server-hosted conversations + streaming completions (server-side state).
3. **Agent inference** — `/v1/messages` for Claude Code (now → OpenAI via proxy) + token counting/batches.
4. **Agent orchestration** — remote environments/sessions bridge (Cowork/cloud agents), settings, memory sync, policy/compliance.
5. **MCP** — server discovery (directory) + tool execution (Anthropic-hosted/proxied connectors).
6. **Config & entitlements** — bootstrap, org membership, GrowthBook feature flags, managed settings.
7. **Extensions & plugins** — allow/block checks, plugin catalog + download.
8. **Updates** — signed self-update + Cowork VM images.
9. **Assets** — fonts.
10. **Telemetry** — product analytics (`event_logging`), crash reporting, optional enterprise OTLP.

## Audit caveats

- Chat completion, MCP-directory browsing, and the analytics iframe are issued by the
  **remote claude.ai web app**, not the desktop bundle.
- `assets-proxy.anthropic.com` / `a-cdn.claude.ai` are **not** in the bundle; the
  runtime ones come from the web app (`a-cdn.anthropic.com` is only CSP-allowlisted).
- `beacon.claude-ai.staging.ant.dev` is an **OAuth allowlist** entry, not a telemetry beacon.
- `api/oauth/claude_cli/roles` is defined but appears unused in this build.
- Payloads marked from the bundle are extracted from minified code; the chat completion
  body is from a live capture. The public Messages API shape is standard/documented.
