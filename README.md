# OpenFOC AI Router

**Open-source, free-of-cost AI model router for macOS.** One local OpenAI-compatible endpoint, `http://127.0.0.1:4141/v1`, spreading your requests across the free tiers of Groq, Google Gemini, OpenRouter, Mistral, GitHub Models and NVIDIA NIM, with your own Ollama / LM Studio models as the last resort. When one provider rate-limits you, goes down or retires a model, the request moves to the next one automatically.

- 🔁 **Automatic fallback.** Handles 429s (honouring `retry-after` and `x-ratelimit-*` headers), 5xx, timeouts, bad keys, retired models and per-provider context limits.
- 📊 **Quota dashboard.** Requests per minute and per day, tokens, latency, cooldowns, and the limits each provider reports back.
- 💬 **Built-in chat** that goes through the same router.
- 🧭 **Routes.** Named chains such as `auto`, `fast`, `long-context` and `local` that you can reorder in the UI, or call any `provider/model` directly.
- 🔒 **Local-only.** Bound to loopback, keys stored in an owner-only file, the admin API locked to a per-launch token, and requests from browser pages blocked.
- 🪶 **Small and native.** Tauri v2 menu-bar app plus a single-binary TypeScript router (Bun-compiled sidecar).

> Free tiers change often. As of Nov 2026, Cerebras no longer has a standing free tier (it now gives a $5 trial credit with a card), so it ships disabled. Model IDs rotate too: use **Providers → Discover models** to see what's live, then paste targets into **Routes**.

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

The app lives in the menu bar. Closing the window keeps the router running; quit it from the tray menu.

### Unsigned build note
Local and CI builds are unsigned. On first launch, right-click the app → **Open**, or run `xattr -dr com.apple.quarantine "/Applications/OpenFOC AI Router.app"`.

## Add free keys

| Provider | Get a key | Free tier (verify, it changes) |
|---|---|---|
| Groq | https://console.groq.com/keys | per-model limits, e.g. 30 RPM / 1K req/day |
| Google AI Studio | https://aistudio.google.com/apikey | Gemini Flash models free |
| OpenRouter | https://openrouter.ai/keys | `:free` models, ~20 RPM / 50 req/day |
| Mistral | https://console.mistral.ai/api-keys | Experiment plan |
| GitHub Models | https://github.com/settings/personal-access-tokens (models:read) | rate-limited per model |
| NVIDIA NIM | https://build.nvidia.com | free dev access |
| Ollama / LM Studio | local | unlimited, on your Mac |

You can also set keys through environment variables when running the router headless: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GITHUB_API_KEY`, `NVIDIA_API_KEY`.

## Use it from your tools

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

- **OpenAI SDK**: `new OpenAI({ baseURL: "http://127.0.0.1:4141/v1", apiKey: "any" })`
- **Continue / Cline / Cursor**: add an OpenAI-compatible provider with base URL `http://127.0.0.1:4141/v1`, model `auto`
- **aider**: `aider --openai-api-base http://127.0.0.1:4141/v1 --openai-api-key any --model openai/auto`

Each response carries `x-ofr-provider`, `x-ofr-model` and `x-ofr-attempts` headers. If every target is exhausted you get `503` with an `attempts` trail explaining why. To require a key from clients, set one under **Settings → Local API key**.

## How routing works

```
client ──► /v1/chat/completions  model="auto"
              │
              ▼  for each target in the route
   enabled? key? cooldown? local RPM/RPD left? provider says remaining>0?
              │ yes                                   │ no → skip
              ▼
        call provider ── 2xx ──► stream/return (+ usage recorded)
              │
   429 → cooldown from retry-after/reset headers → next
   5xx / timeout / network → exponential backoff (30s→10m) → next
   401/403 / bad key → pause provider 10 min → next
   404 / retired model → backoff → next
   413 / context too long → next (no cooldown)
   other 4xx → return to client (the request itself is invalid)
```

Streaming fallback happens before any bytes reach the client, so a client never sees a half-answer from one provider spliced onto another.

## Project layout

```
router/        TypeScript router (Bun): config, quota, routing, HTTP server, tests
src/           React UI: Dashboard, Providers, Routes, Chat, Settings
src-tauri/     Tauri v2 shell: spawns sidecar, tray menu, admin token
scripts/       build-sidecar.sh
```

Data: `~/Library/Application Support/openfocairouter/` (`config.json` with 0600 permissions, `usage.json`).

## Develop

```bash
npm test             # router unit tests (bun test)
npm run typecheck
npm run dev:router   # router alone on :4141 (prints an admin token)
npm run dev:ui       # UI in a browser at :1420 (paste that token)
```

## Roadmap
Keychain storage for keys · launch at login · `/v1/embeddings` · per-client usage · latency-aware ordering · signed and notarized releases.

## License
MIT. Not affiliated with any provider. Respect each provider's terms of service; free tiers may log prompts or use them for training (Gemini's free tier does).
