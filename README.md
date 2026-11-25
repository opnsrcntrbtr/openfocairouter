# OpenFOC AI Router

**Open-source, free-of-cost AI gateway for macOS.** A menu-bar app that runs one local endpoint, `http://127.0.0.1:4141`, for OpenAI-style tools, Anthropic-style tools (Claude Code) and embeddings. It spreads your requests across the free tiers of Groq, Google Gemini, OpenRouter, Mistral, GitHub Models and NVIDIA NIM, plus your own models in **oMLX**, Ollama and LM Studio. When a provider rate-limits you, goes down or retires a model, the request moves to the next one automatically.

### What's in v0.2

| | |
|---|---|
| 🔁 **Automatic fallback** | Handles 429s (honours `retry-after` / `x-ratelimit-*`), 5xx, timeouts, bad keys, retired models, models without tool support, and context limits. Streams fall back before the first byte. |
| 🧭 **Task routing** | `auto:task` classifies each request (rules, then **local** embeddings) as coding, reasoning, long-context, quick, vision or general, then sends it to that task's route. Conversations stay on one task. |
| ⚖️ **Load balancing** | Per-route `ordered`, `latency` or `balanced` strategy, reordering only within tiers so cloud-first and local-last still hold. |
| 🤖 **Anthropic API** | `POST /v1/messages` with tool use and streaming lets Claude Code run on free and local models. |
| 🧮 **Embeddings** | `POST /v1/embeddings` with model-pinned routes, so vectors never mix models. |
| 🔑 **Client keys and stats** | A key per tool, with per-client usage, latency, fallbacks, cache hits and optional limits. Tools without a key are grouped by `X-OFR-Client` header or User-Agent. |
| 💾 **Response cache** | Exact-match by default, semantic cache opt-in. Hits use no provider quota. |
| 🔎 **Request log** | SQLite with full-text search and an attempt-by-attempt trace viewer. |
| 🔒 **Local and private** | Keys in the macOS Keychain, loopback only, browser origins blocked, prompts never sent to the cloud for routing decisions. |
| 🚀 **Launch at login** | Starts hidden in the menu bar. |

> Free tiers change often. As of Nov 2026, Cerebras gives only a one-time $5 credit with a card, so it ships disabled. Model IDs rotate too: use **Providers → Discover models** and fix route targets if a provider has retired one. The router already skips retired models automatically.

## Quick start (macOS, Apple Silicon or Intel)

```bash
# prerequisites (once)
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash        # compiles the router sidecar
# Node 18+ for the UI tooling

git clone https://github.com/opnsrcntrbtr/openfocairouter && cd openfocairouter
npm install
npm run dev          # launches the app with hot reload
npm run build        # → src-tauri/target/release/bundle/{macos,dmg}/
```

The app lives in the menu bar. Closing the window keeps the router running.

**Unsigned builds:** right-click the app → Open on first launch, or `xattr -dr com.apple.quarantine "/Applications/OpenFOC AI Router.app"`. macOS may ask to allow Keychain access after each rebuild. Choose **Always Allow**, because Keychain permissions follow the code signature.

## Local models

| Provider | Default URL | Notes |
|---|---|---|
| **oMLX** | `http://127.0.0.1:8001/v1` | MLX on Apple Silicon. Chat plus embeddings; also the default embedder for task routing and the semantic cache. Edit the URL on the Providers tab if your port differs. |
| Ollama | `http://127.0.0.1:11434/v1` | `ollama pull nomic-embed-text` gives task routing an embedder if oMLX isn't running. |
| LM Studio | `http://127.0.0.1:1234/v1` | Start the server in the Developer tab. |

In a route, `omlx/*` means "the first chat model oMLX serves" and `omlx/*embed` means "the first embedding model". A local server that isn't running is skipped quietly, not cooled down.

## Free cloud keys

| Provider | Get a key | Free tier (verify, it changes) |
|---|---|---|
| Groq | https://console.groq.com/keys | per-model limits, e.g. 30 RPM / 1K req/day |
| Google AI Studio | https://aistudio.google.com/apikey | Gemini Flash models free; free-tier prompts may be used for training |
| OpenRouter | https://openrouter.ai/keys | `:free` models, ~20 RPM / 50 req/day |
| Mistral | https://console.mistral.ai/api-keys | Experiment plan |
| GitHub Models | https://github.com/settings/personal-access-tokens (models:read) | rate-limited per model |
| NVIDIA NIM | https://build.nvidia.com | free dev access |

Paste keys on the Providers tab; they're saved to your **macOS Keychain** and the router holds them only in memory. For headless use (`bun router/src/index.ts`), set `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` and so on.

## Use it from your tools

Create a key per tool on the **Clients** tab, then:

```bash
# Claude Code (Anthropic API): sonnet → coding route, haiku → fast, opus → reasoning
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_AUTH_TOKEN=$OFR_KEY

# OpenAI-compatible tools (Cursor, Continue, Cline, aider, SDKs)
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=$OFR_KEY

curl http://127.0.0.1:4141/v1/chat/completions -H "Authorization: Bearer $OFR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:task","messages":[{"role":"user","content":"Refactor this function..."}]}'

curl http://127.0.0.1:4141/v1/embeddings -H "Authorization: Bearer $OFR_KEY" \
  -H "Content-Type: application/json" -d '{"model":"embed","input":["first","second"]}'
```

**Model names you can send:** a route (`auto`, `fast`, `coding`, `reasoning`, `long-context`, `vision`, `local`), `auto:task` (classify), `auto:<task>` (force a task), or any `provider/model`. Headers you can send: `X-OFR-Task` to force a task, `X-OFR-Client` to name an unkeyed tool, `X-OFR-Cache: force` to cache at any temperature, and `Cache-Control: no-cache`.

**Response headers:** `x-ofr-provider`, `x-ofr-model`, `x-ofr-attempts`, `x-ofr-client`, `x-ofr-cache` (`hit`, `semantic-hit`, `miss` or `bypass`), `x-ofr-task`, `x-ofr-task-reason`, `x-ofr-task-score` and `x-ofr-embedding-space`. When every target is exhausted you get a `503` with an `attempts` trail.

## How a request flows

```
client ─► identify (client key → X-OFR-Client → User-Agent) ─► client limits
       ─► translate (/v1/messages only) ─► cache lookup ─► classify task (auto:task)
       ─► order targets (route strategy, tiers) ─► try each target:
             skip: disabled · no key · local-only client · cooldown · RPM/RPD · server not running
             429 → cooldown from headers · 5xx/timeout → backoff · 401/403 → pause provider
             404/retired model → backoff · 413/context/no-tools → next, no cooldown
             other 4xx → returned to the client (the request itself is invalid)
       ─► stream or return ─► log (SQLite) + stats + cache
```

Task routing uses rules first (images → vision, prompts over 24k tokens → long-context, code or agent prompts → coding, very short single turns → quick). Otherwise it compares the last user message with editable example prompts using a **local** embedder, with a confidence threshold and margin. It never blocks: when no embedder is running, the request goes to `auto`. Check the classifier's accuracy on your Mac with `npm run eval:tasks` (100 labelled prompts; target ≥85%).

## Project layout

```
router/src/
  config.ts      providers, routes, tasks, clients, defaults, v1→v2 migration
  gateway.ts     the shared pipeline (identify → cache → classify → route → log)
  router.ts      target resolution, fallback, embeddings
  classify.ts    hybrid task classifier + stickiness
  embedder.ts    local embedder (oMLX → Ollama)
  balance.ts     ordered / latency / balanced strategies
  anthropic.ts   Messages ⇄ Chat Completions translation (incl. SSE)
  cache.ts       exact + semantic cache
  clients.ts     client keys, identification, limits
  db.ts          SQLite request log, FTS, client stats
  secrets.ts     in-memory secrets fed by the shell (Keychain)
src/             React UI: Dashboard, Providers, Routes, Clients, Logs, Chat, Settings
src-tauri/       Tauri v2 shell: Keychain, sidecar, tray, launch at login
```

Data lives in `~/Library/Application Support/openfocairouter/`: `config.json` (no secrets, owner-only), `ofr.db` (request log and cache) and `usage.json`.

## Develop

```bash
npm test             # router tests (bun test)
npm run typecheck
npm run eval:tasks   # classifier accuracy against your local embedder
npm run dev:router   # router alone on :4141 (prints an admin token)
npm run dev:ui       # UI in a browser at :1420 (paste that token)
```

## Roadmap
Native Anthropic passthrough for oMLX · tray pause/resume · Responses API · rerank endpoint · MCP gateway · signed and notarized releases.

## License
MIT. Not affiliated with any provider. Respect each provider's terms of service.
