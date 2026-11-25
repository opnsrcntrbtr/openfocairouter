// Configuration model + defaults for OpenFOC AI Router.
// Model IDs on free tiers rotate often: defaults are starting points, and the
// app discovers live model lists from each provider's /models endpoint.

export type FreeStatus = "free" | "credits" | "local";

export interface Limits {
  rpm?: number; // requests per minute
  rpd?: number; // requests per day
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string; // OpenAI-compatible base, without trailing /chat/completions
  apiKey?: string;
  enabled: boolean;
  kind: "cloud" | "local";
  free: FreeStatus;
  keyUrl?: string; // where to get a key
  notes?: string;
  modelsUrl?: string; // override for model discovery
  modelFilter?: "free-suffix"; // only keep models ending with :free
  limits?: Limits; // default per-model limits (best-effort, conservative)
  modelLimits?: Record<string, Limits>;
  headers?: Record<string, string>;
}

export interface RouteConfig {
  name: string;
  description: string;
  targets: string[]; // "providerId/modelId"; modelId "*" = first discovered model
}

export interface AppConfig {
  version: 1;
  localApiKey?: string; // if set, clients must send "Authorization: Bearer <key>"
  requestTimeoutMs: number;
  defaultRoute: string;
  providers: ProviderConfig[];
  routes: RouteConfig[];
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    enabled: true,
    kind: "cloud",
    free: "free",
    keyUrl: "https://console.groq.com/keys",
    notes: "Very fast LPU inference. Per-model limits, e.g. ~30 RPM / 1K RPD.",
    limits: { rpm: 30, rpd: 1000 },
  },
  {
    id: "gemini",
    name: "Google AI Studio (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    enabled: true,
    kind: "cloud",
    free: "free",
    keyUrl: "https://aistudio.google.com/apikey",
    notes: "Flash models are free with large context. Free-tier prompts may be used to improve Google products.",
    limits: { rpm: 10, rpd: 500 },
  },
  {
    id: "openrouter",
    name: "OpenRouter (:free models)",
    baseUrl: "https://openrouter.ai/api/v1",
    enabled: true,
    kind: "cloud",
    free: "free",
    keyUrl: "https://openrouter.ai/keys",
    notes: "~20 RPM, 50 req/day on :free models (1,000/day after buying $10 of credits).",
    modelFilter: "free-suffix",
    limits: { rpm: 20, rpd: 50 },
    headers: { "HTTP-Referer": "https://github.com/opnsrcntrbtr/openfocairouter", "X-Title": "OpenFOC AI Router" },
  },
  {
    id: "mistral",
    name: "Mistral (Experiment plan)",
    baseUrl: "https://api.mistral.ai/v1",
    enabled: true,
    kind: "cloud",
    free: "free",
    keyUrl: "https://console.mistral.ai/api-keys",
    notes: "Free Experiment plan with account-specific limits.",
    limits: { rpm: 60 },
  },
  {
    id: "github",
    name: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    modelsUrl: "https://models.github.ai/catalog/models",
    enabled: true,
    kind: "cloud",
    free: "free",
    keyUrl: "https://github.com/settings/personal-access-tokens",
    notes: "Use a fine-grained PAT with models:read. Small per-request token limits.",
    limits: { rpm: 10, rpd: 50 },
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    enabled: true,
    kind: "cloud",
    free: "free",
    keyUrl: "https://build.nvidia.com/",
    notes: "Free developer access, rate-limited (~40 RPM).",
    limits: { rpm: 40 },
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    enabled: false,
    kind: "cloud",
    free: "credits",
    keyUrl: "https://cloud.cerebras.ai/",
    notes: "No longer free since 21 Jul 2026: one-time $5 trial credit after adding a card. Off by default.",
    limits: { rpm: 5 },
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    enabled: true,
    kind: "local",
    free: "local",
    notes: "Runs on your Mac. Last-resort fallback.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    enabled: true,
    kind: "local",
    free: "local",
    notes: "Start the LM Studio server (Developer tab) to use it.",
  },
];

export const DEFAULT_ROUTES: RouteConfig[] = [
  {
    name: "auto",
    description: "Best general-purpose free models, then local.",
    targets: [
      "groq/llama-3.3-70b-versatile",
      "gemini/gemini-2.5-flash",
      "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "mistral/mistral-small-latest",
      "github/openai/gpt-4.1-mini",
      "nvidia/meta/llama-3.3-70b-instruct",
      "ollama/*",
      "lmstudio/*",
    ],
  },
  {
    name: "fast",
    description: "Lowest latency for short calls.",
    targets: ["groq/llama-3.1-8b-instant", "groq/openai/gpt-oss-20b", "gemini/gemini-2.5-flash-lite", "ollama/*"],
  },
  {
    name: "long-context",
    description: "Large prompts and documents.",
    targets: ["gemini/gemini-2.5-flash", "openrouter/meta-llama/llama-3.3-70b-instruct:free", "ollama/*"],
  },
  {
    name: "local",
    description: "Never leaves your Mac.",
    targets: ["ollama/*", "lmstudio/*"],
  },
];

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    requestTimeoutMs: 60_000,
    defaultRoute: "auto",
    providers: structuredClone(DEFAULT_PROVIDERS),
    routes: structuredClone(DEFAULT_ROUTES),
  };
}

/** Merge a stored config with defaults so new built-in providers show up after upgrades. */
export function mergeWithDefaults(stored: Partial<AppConfig>): AppConfig {
  const base = defaultConfig();
  const providers = [...(stored.providers ?? [])];
  for (const def of base.providers) {
    if (!providers.some((p) => p.id === def.id)) providers.push(def);
  }
  return {
    ...base,
    ...stored,
    version: 1,
    providers,
    routes: stored.routes?.length ? stored.routes : base.routes,
  };
}

/** Split "provider/model/with/slashes" into provider + model. */
export function parseTarget(target: string): { providerId: string; model: string } | null {
  const i = target.indexOf("/");
  if (i <= 0 || i === target.length - 1) return null;
  return { providerId: target.slice(0, i), model: target.slice(i + 1) };
}

const MASK = "••••";

export function maskKey(key?: string): string | undefined {
  if (!key) return undefined;
  return MASK + key.slice(-4);
}

export function isMasked(value?: string): boolean {
  return !!value && value.startsWith(MASK);
}

/** Config safe to send to the UI: keys masked. */
export function redactConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    localApiKey: cfg.localApiKey,
    providers: cfg.providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey) })),
  };
}

/** Apply an update from the UI, keeping existing keys when the UI sends a masked value. */
export function applyUpdate(current: AppConfig, update: AppConfig): AppConfig {
  return {
    ...update,
    version: 1,
    providers: update.providers.map((p) => {
      const existing = current.providers.find((c) => c.id === p.id);
      const apiKey = isMasked(p.apiKey) ? existing?.apiKey : p.apiKey?.trim() || undefined;
      return { ...p, apiKey };
    }),
  };
}
