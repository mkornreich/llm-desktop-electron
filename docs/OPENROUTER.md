# OpenRouter provider — catalog analysis & the free-model allowlist

OpenRouter (`https://openrouter.ai/api/v1`) is one of the keyed providers the proxy can route a
turn to (`openrouter:<model>`). This doc records what its catalog actually looks like *on this
account*, why the UI is restricted to a curated set of 11 free models, and how that restriction is
wired. Probed 2026-08-25 with the account key in `.openai-key` (`openrouterApiKey`).

## TL;DR

- The account is **free-tier with no purchased credits**. Paid models accept a trivial (1-token)
  call but **402 on a real, multi-thousand-token turn** — so in practice only free models are usable.
- The live catalog is **417 models** (347 tool-capable). On this key, **319 respond** on the app's
  surface, but the durable set is the **free** models — and of those, **11** passed a tool-calling +
  max-reasoning probe cleanly on **both** the chat and responses surfaces.
- Those **11 free models are the only OpenRouter models the UI offers** — enforced by a per-provider
  allowlist, `providers.openrouter.suggestions` in `config.jsonc`, which gates the Settings pickers
  **and** proxy gateway discovery (`GET /v1/models`).

## Provider configuration

```jsonc
// config.jsonc → providers.openrouter
"endpoint": "https://openrouter.ai/api/v1",
"api": "responses",     // OpenRouter serves BOTH /chat/completions and /responses; the app uses
                        // /responses so the 200+ agent tools aren't dropped by the chat tool cap
"responses": true,      // /responses confirmed working (so it's eligible for the responses-only picker)
"model": "nvidia/nemotron-3-ultra-550b-a55b:free",   // default — a free allowlist member
"keyNames": ["openrouterApiKey", "apiKey"],
"suggestions": [ /* the 11-model allowlist, below */ ]
```

Both API surfaces do tool-calling on OpenRouter (verified on `mistral-nemo`, `gpt-4o-mini`,
`deepseek-v3.1`, and every allowlist model). `api: "responses"` is chosen because the Code-tab agent
sends 200+ tools and `/chat/completions` drops tools above a 128-tool cap.

## The catalog on this account (2026-08-25)

| metric | count |
|---|---|
| Models in the catalog | 417 |
| Tool-capable (`supported_parameters` includes `tools`) | 347 |
| Reachable on the app's `/responses` surface | 319 |
| …of those, tool-capable (agent-ready) | 265 |
| Chat-only (fail `/responses`) | 7 |
| Hard-blocked / unavailable | 91 (mostly delisted `not_found`) |

The "chat-only vs responses-only" split is **not** an API-coverage gap — every such model failed the
other surface with `needs_credits` or a rate-limit, i.e. it's a per-route credit/throttle artifact.

## The 11-model free allowlist

These are the only OpenRouter models the UI offers. All are free, tool-capable, reasoning-capable,
and answered correctly at max reasoning (`reasoning: {effort:"high"}`) on both surfaces.

| model | arch (active / total) | ctx | role |
|---|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 55B / 550B MoE | 1M | frontier reasoning — the heavyweight (default) |
| `nvidia/nemotron-3-super-120b-a12b:free` | 12B / 120B MoE | 262K | strong all-round |
| `nvidia/nemotron-3.5-lightning:free` | 3B / 30B MoE | 1M | high-throughput — the fast pick |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 3B / 30B MoE | 256K | multimodal perception sub-agent |
| `cohere/north-mini-code:free` | 3B / 30B MoE | 256K | agentic coding |
| `poolside/laguna-xs-2.1:free` | 3B / 33B MoE | 262K | small coding agent |
| `poolside/laguna-s-2.1:free` | 8B / 118B MoE | 262K | coding, 70.2% Terminal-Bench 2.1 · ⚠ returns answer in the reasoning field, empty content |
| `dots-studio/dots-3-note-preview:free` | 16B / 280B MoE | 512K | general, image input |
| `liquid/lfm-2.5-2.6b:free` | 2.6B dense | 64K | tiny/instant; not for coding (per Liquid) |
| `stealth/ox-alpha` | cloaked | 1M | reasoning/coding · ⚠ cloaked — prompts are logged/shared |
| `openrouter/free` | router | 200K | routes to a random available free model |

### Informed quality & speed ordering

A clean measured ranking was **not** obtainable — repeated probing exhausted the free-tier rate
limit for the day (requests 429). The orders below are inferred from architecture (active params →
speed; total params + specialization → quality) plus the signals captured before throttling (all 11
solved the reasoning trap; `dots-3` went 5/5; Poolside's published Terminal-Bench; `ox-alpha`
measured ~11 tok/s).

- **Quality (best→):** nemotron-3-ultra · dots-3-note · nemotron-3-super · laguna-s (coding) ·
  ox-alpha · north-mini-code · nemotron-3.5-lightning · laguna-xs · nemotron-nano-omni · lfm-2.5 ·
  openrouter/free (variable).
- **Speed (fastest→):** lfm-2.5 (2.6B dense) · nemotron-3.5-lightning · north-mini-code · laguna-xs ·
  nemotron-nano-omni (all 3B-active) · laguna-s (8B) · nemotron-3-super (12B) · dots-3 (16B) ·
  nemotron-3-ultra (55B) · ox-alpha (~11 tok/s measured) · openrouter/free (variable).

Sweet spot: `nemotron-3.5-lightning` (fast + solid); `nemotron-3-ultra` for maximum capability;
`laguna-s` / `north-mini-code` for coding; `lfm-2.5` when you want instant.

## Free-tier limits

- **No credits** → paid models 402 on a real turn. Add credits at
  [openrouter.ai/credits](https://openrouter.ai/credits) to use paid models (then list them in
  `suggestions`).
- **`:free` models are rate-limited** (per-account requests/min + daily caps) and require data
  sharing enabled at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy). A
  burst of concurrent requests 429-storms; space them out.

### Rate limits observed (429s)

The 429s are **cumulative quota exhaustion, not a per-model trait** — the same model 429'd in one
run and answered in another. In the *earliest* clean test (the max-reasoning battery) **all 11
answered with zero 429s**; the throttling only set in after a day of probing (the 400-model catalog
sweep, the both-surface test, the quality/speed benchmarks) drained the free-tier allowance. What the
two later benchmark runs recorded:

| model | concurrent run (earlier) | sequential run (later, 429s logged) |
|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | all errors | all 429 |
| `nvidia/nemotron-3-super-120b-a12b:free` | all errors | all 429 |
| `nvidia/nemotron-3.5-lightning:free` | all errors | all 429 |
| `cohere/north-mini-code:free` | all errors | all 429 |
| `liquid/lfm-2.5-2.6b:free` | all errors | all 429 |
| `poolside/laguna-xs-2.1:free` | speed only (quality errored) | all 429 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 3/3 + speed | all 429 |
| `poolside/laguna-s-2.1:free` | 1/1 + speed | all 429 |
| `dots-studio/dots-3-note-preview:free` | 5/5 + speed | all 429 |
| `openrouter/free` | 4/5 + speed | all 429 |
| `stealth/ox-alpha` | 4/4 + speed | broke through (2×429, then succeeded) |

- In the final sequential run (429s explicitly tracked), **all 11 hit 429s**; the only one to push a
  request through was **`stealth/ox-alpha`** — and it isn't a `:free` model, so it's on a looser
  limit than the ten `:free` ones.
- In the earlier concurrent run, **5 got nothing through** (`nemotron-3-ultra`, `nemotron-3-super`,
  `nemotron-3.5-lightning`, `cohere/north-mini-code`, `liquid/lfm-2.5`); the other 6 got partial data.
- Caveats: the concurrent run labelled failures generically ("ERR"), so not every one there is
  provably a 429 vs a timeout (the two big NVIDIA MoEs are slow at max reasoning); the sequential
  run's are confirmed 429. None of this reflects the models' real reliability — it's shared-quota
  exhaustion from testing. A clean re-run after the quota resets (or with a small credit balance)
  gets all 11 through.

### Two distinct 429 limits (they are not the same throttle)

`stealth/ox-alpha` looked like "the one that still works", but under a real Code-tab turn it 429s too
— for a **different reason**. There are two separate limits, and `ox-alpha` being the lone non-`:free`
id is why it lands on the second one:

| limit | applies to | `metadata`/message | shape |
|---|---|---|---|
| **`free-models-per-day`** | the ten `:free` models | *"Rate limit exceeded: free-models-per-day. Add 10 credits…"* | a **single shared daily counter** across ALL `:free` models; pre-flight reject (~0.05 s, before inference). ≥ $10 credits raises it (~50/day → ~1000/day). Resets daily. |
| **`upstream_provider_shared_pool`** | `stealth/ox-alpha` (cloaked; served by the "Stealth" provider) | *"stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly."* · `provider_name:"Stealth"` · `is_byok:false` | the upstream provider's **shared free capacity** — intermittent, not a daily counter, and heavier on big requests. Remedy: retry shortly, add credits (raises shared-pool priority), or BYOK (your own provider key). |

**Routing is correct** — this is NOT a proxy/config bug. The live proxy log shows the pick resolving
and dispatching exactly as intended, then the upstream 429:

```
/v1/messages [responses] model=openrouter:stealth/ox-alpha->stealth/ox-alpha … tools=63 session=…
  routed to provider openrouter (https://openrouter.ai/api/v1)
OpenAI(responses) 429: "stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly."
  limit_source:"upstream_provider_shared_pool"  provider_name:"Stealth"  is_byok:false
```

A direct retest isolates it to load, not surface: `chat`-tiny, `responses`-tiny, and
`responses`+reasoning all returned 200, but `responses`+tools **429'd** — matching the real turn
(31.6k tokens, 63 tool schemas). And because a single-model pick has **no fallover** (unlike
Composite), an `ox-alpha` 429 just fails the turn; the proxy retries it a few times and gives up.

## How the allowlist is enforced

`providers.<id>.suggestions` (non-empty) is the **exclusive** set of that provider's models the UI
offers — one source of truth in three places:

1. **Settings "OpenRouter model" field** — generated by `settings/config.js buildProviderSchema()`
   with `suggestions = providers.openrouter.suggestions`.
2. **Dropdown + composite member pickers** — `settings/server.js /api/composite-choices` offers
   `sug("OPENROUTER_MODEL")` (those suggestions) + the configured `providers.openrouter.model`
   (itself an allowlist member, so it can't leak a 12th).
3. **Gateway model discovery** — `openai-proxy/proxy.mjs fetchProviderCatalog` filters each
   provider's live `GET /models` catalog to `reg.suggestions` when set (`config.mjs buildProviders`
   copies `suggestions` into the registry). Without this, `GET /v1/models` dumped OpenRouter's whole
   ~400-model catalog into the Code-tab native picker.

An **empty** `suggestions` (every provider except openrouter) means the whole live catalog is
offered, unchanged. To use a different OpenRouter model, add its id to `suggestions` (and add credits
if it's paid).

The old `settings/server.js /api/openrouter-models` endpoint (a full-catalog fetch) was removed — it
was dead code that pinged openrouter.ai on every Settings open and was a latent allowlist bypass.

## Reproducing the probes

The scratch scripts that produced these numbers hit `GET /api/v1/models` (catalog), then
`POST /chat/completions` and `POST /responses` per model with a minimal body (access + tool-calling),
and a max-reasoning battery of verifiable questions (quality). Keep concurrency ≤ 1–2 and space
requests ≥ 2.5s apart, or the free tier throttles. None of them print the key.
