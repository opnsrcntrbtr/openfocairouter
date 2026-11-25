// Configuration model + defaults for OpenFOC AI Router.
// Model IDs on free tiers rotate often: defaults are starting points, and the
// app discovers live model lists from each provider's /models endpoint.

export type FreeStatus = "free" | "credits" | "local";
export type Capability = "chat" | "embeddings";
export type Strategy = "ordered" | "latency" | "balanced";

export interface Limits {
  rpm?: number; // requests per minute
  rpd?: number; // requests per day
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string; // OpenAI-compatible base, without trailing /chat/completions
  apiKey?: string; // headless fallback only; the desktop app keeps keys in the Keychain
  enabled: boolean;
  kind: "cloud" | "local";
  free: FreeStatus;
  capabilities?: Capability[];
  keyUrl?: string;
  notes?: string;
  trainsOnFreeTier?: boolean;
  modelsUrl?: string; // override for model discovery
  modelFilter?: "free-suffix"; // only keep models ending with :free
  embeddingModels?: string[]; // user overrides: model ids to treat as embedding models
  anthropicNative?: boolean; // provider also serves POST /v1/messages (passthrough)
  limits?: Limits;
  modelLimits?: Record<string, Limits>;
  headers?: Record<string, string>;
}

export interface RouteConfig {
  name: string;
  description: string;
  targets: string[]; // "providerId/modelId"; "*" = first chat model, "*embed" = first embedding model
  strategy?: Strategy; // default "ordered"
  tiers?: Record<string, number>; // target → tier (lower first). Default: cloud 0, local 1
}

export interface EmbeddingRouteConfig {
  name: string;
  description: string;
  space: string; // all targets must produce vectors in this space (same model weights)
  targets: string[];
}

export interface ClientConfig {
  id: string;
  name: string;
  keyHash: string; // sha256 hex of the key; plaintext is never stored by the router
  keyPrefix: string; // first chars, for display
  enabled: boolean;
  allowedRoutes?: string[]; // empty/undefined = all
  limits?: Limits & { tokensPerDay?: number };
  cache?: boolean; // default true
  semanticCache?: boolean; // default false
  localOnly?: boolean; // never route to cloud providers
  createdAt: number;
}

export interface TaskDef {
  name: string;
  route: string;
  threshold: number;
  examples: string[];
}

export interface TaskRoutingConfig {
  enabled: boolean; // when true, model "auto" is classified too
  stickyMinutes: number;
  longContextTokens: number;
  quickMaxChars: number;
  margin: number;
  embedder: string; // "" = auto (oMLX, then Ollama); or "provider/model"
  tasks: TaskDef[];
}

export interface CacheConfig {
  exact: boolean;
  semantic: boolean;
  ttlHours: number;
  maxMb: number;
  maxTemperature: number;
  semanticThreshold: number;
}

export interface LoggingConfig {
  bodies: boolean;
  retentionDays: number;
}

export interface AppConfig {
  version: 2;
  localApiKey?: string; // v0.1 legacy; migrated to a "default" client
  requireClientKeys: boolean;
  requestTimeoutMs: number;
  defaultRoute: string;
  defaultEmbeddingRoute: string;
  providers: ProviderConfig[];
  routes: RouteConfig[];
  embeddingRoutes: EmbeddingRouteConfig[];
  clients: ClientConfig[];
  taskRouting: TaskRoutingConfig;
  cache: CacheConfig;
  logging: LoggingConfig;
  anthropic: { modelMap: Record<string, string> }; // substring of Claude model name → route
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    enabled: true,
    kind: "cloud",
    free: "free",
    capabilities: ["chat"],
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
    capabilities: ["chat", "embeddings"],
    trainsOnFreeTier: true,
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
    capabilities: ["chat"],
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
    capabilities: ["chat", "embeddings"],
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
    capabilities: ["chat", "embeddings"],
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
    capabilities: ["chat", "embeddings"],
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
    capabilities: ["chat"],
    keyUrl: "https://cloud.cerebras.ai/",
    notes: "No longer free since 21 Jul 2026: one-time $5 trial credit after adding a card. Off by default.",
    limits: { rpm: 5 },
  },
  {
    id: "omlx",
    name: "oMLX (local, Apple Silicon)",
    baseUrl: "http://127.0.0.1:8001/v1",
    enabled: true,
    kind: "local",
    free: "local",
    capabilities: ["chat", "embeddings"],
    anthropicNative: true,
    keyUrl: "https://github.com/jundot/omlx",
    notes: "MLX models served from your Mac. Default local provider; also the default embedder for task routing.",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    enabled: true,
    kind: "local",
    free: "local",
    capabilities: ["chat", "embeddings"],
    notes: "Runs on your Mac. Local fallback.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    enabled: true,
    kind: "local",
    free: "local",
    capabilities: ["chat", "embeddings"],
    notes: "Start the LM Studio server (Developer tab) to use it.",
  },
];

const LOCAL_CHAIN = ["omlx/*", "ollama/*", "lmstudio/*"];

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
      ...LOCAL_CHAIN,
    ],
  },
  {
    name: "fast",
    description: "Lowest latency for short calls.",
    strategy: "latency",
    targets: ["groq/llama-3.1-8b-instant", "groq/openai/gpt-oss-20b", "gemini/gemini-2.5-flash-lite", "omlx/*", "ollama/*"],
  },
  {
    name: "coding",
    description: "Code generation, edits and agent tool use.",
    targets: [
      "groq/openai/gpt-oss-120b",
      "gemini/gemini-2.5-flash",
      "openrouter/qwen/qwen3-coder:free",
      "mistral/devstral-small-latest",
      "github/openai/gpt-4.1",
      ...LOCAL_CHAIN,
    ],
  },
  {
    name: "reasoning",
    description: "Multi-step reasoning, maths and planning.",
    targets: ["groq/openai/gpt-oss-120b", "gemini/gemini-2.5-flash", "openrouter/deepseek/deepseek-r1:free", "nvidia/deepseek-ai/deepseek-r1", ...LOCAL_CHAIN],
  },
  {
    name: "long-context",
    description: "Large prompts and documents.",
    targets: ["gemini/gemini-2.5-flash", "openrouter/meta-llama/llama-3.3-70b-instruct:free", "omlx/*", "ollama/*"],
  },
  {
    name: "vision",
    description: "Prompts with images.",
    targets: ["gemini/gemini-2.5-flash", "github/openai/gpt-4.1-mini", "openrouter/meta-llama/llama-4-scout:free", "omlx/*", "ollama/*"],
  },
  {
    name: "local",
    description: "Never leaves your Mac.",
    targets: [...LOCAL_CHAIN],
  },
];

export const DEFAULT_EMBEDDING_ROUTES: EmbeddingRouteConfig[] = [
  { name: "embed", description: "Local embeddings from oMLX (first embedding model it serves).", space: "omlx-default", targets: ["omlx/*embed"] },
  { name: "embed-ollama", description: "Local embeddings from Ollama.", space: "ollama-default", targets: ["ollama/*embed"] },
];

export const DEFAULT_TASKS: TaskDef[] = [
  {
    name: "coding",
    route: "coding",
    threshold: 0.55,
    examples: [
      "Write a Python function that parses a CSV file and returns a list of dicts",
      "Fix this TypeError in my React component",
      "Refactor this class to use dependency injection",
      "Why does this SQL query return duplicate rows?",
      "Add unit tests for the payment service",
      "Convert this JavaScript code to TypeScript with proper types",
      "Implement a REST endpoint in Express that uploads a file to S3",
      "Explain what this regex does and make it stricter",
      "My Rust code fails to compile with a borrow checker error",
      "Write a bash script that renames all files in a folder",
      "Review this pull request diff for bugs",
      "Create a Dockerfile for a Node.js app",
    ],
  },
  {
    name: "reasoning",
    route: "reasoning",
    threshold: 0.55,
    examples: [
      "Solve this step by step: a train leaves at 3pm travelling 80 km/h",
      "Prove that the square root of 2 is irrational",
      "What is the probability of getting at least two heads in five coin flips?",
      "Plan a migration strategy from a monolith to microservices, with trade-offs",
      "Compare these three options and recommend one with reasoning",
      "Work out the optimal pricing given these cost and demand assumptions",
      "Find the logical flaw in this argument",
      "Estimate how many piano tuners there are in Mumbai",
      "Design a fair scheduling algorithm for these constraints",
      "Analyse the second-order effects of raising interest rates",
    ],
  },
  {
    name: "long-context",
    route: "long-context",
    threshold: 0.6,
    examples: [
      "Summarise the following report",
      "Read this entire document and extract all action items",
      "Here is a long transcript, list the key decisions",
      "Answer questions about the attached contract",
      "Compare these two long documents and list the differences",
      "Condense this book chapter into key points",
    ],
  },
  {
    name: "quick",
    route: "fast",
    threshold: 0.6,
    examples: [
      "hi",
      "thanks!",
      "What's the capital of Japan?",
      "Translate 'good morning' to Spanish",
      "Give me a synonym for happy",
      "How many ounces in a pound?",
      "Spell 'necessary'",
      "What time zone is Mumbai in?",
    ],
  },
];

export function defaultConfig(): AppConfig {
  return {
    version: 2,
    requireClientKeys: false,
    requestTimeoutMs: 60_000,
    defaultRoute: "auto",
    defaultEmbeddingRoute: "embed",
    providers: structuredClone(DEFAULT_PROVIDERS),
    routes: structuredClone(DEFAULT_ROUTES),
    embeddingRoutes: structuredClone(DEFAULT_EMBEDDING_ROUTES),
    clients: [],
    taskRouting: {
      enabled: false,
      stickyMinutes: 30,
      longContextTokens: 24_000,
      quickMaxChars: 80,
      margin: 0.05,
      embedder: "",
      tasks: structuredClone(DEFAULT_TASKS),
    },
    cache: { exact: true, semantic: false, ttlHours: 24, maxMb: 256, maxTemperature: 0.3, semanticThreshold: 0.95 },
    logging: { bodies: false, retentionDays: 7 },
    anthropic: { modelMap: { haiku: "fast", sonnet: "coding", opus: "reasoning" } },
  };
}

/** Merge a stored config (v1 or v2) with defaults so new built-ins show up after upgrades. */
export function mergeWithDefaults(stored: Partial<AppConfig> & { version?: number }): AppConfig {
  const base = defaultConfig();
  const providers = (stored.providers ?? []).map((p) => {
    const def = base.providers.find((d) => d.id === p.id);
    return def ? { ...def, ...p, capabilities: p.capabilities ?? def.capabilities, anthropicNative: p.anthropicNative ?? def.anthropicNative } : p;
  });
  for (const def of base.providers) if (!providers.some((p) => p.id === def.id)) providers.push(def);

  let routes = stored.routes?.length ? [...stored.routes] : base.routes;
  if (stored.version !== 2 && stored.routes?.length) {
    // v1 → v2: add new default routes and slot oMLX into local chains.
    for (const def of base.routes) if (!routes.some((r) => r.name === def.name)) routes.push(def);
    routes = routes.map((r) =>
      r.targets.includes("ollama/*") && !r.targets.includes("omlx/*")
        ? { ...r, targets: r.targets.flatMap((t) => (t === "ollama/*" ? ["omlx/*", t] : [t])) }
        : r,
    );
  }
  return {
    ...base,
    ...stored,
    version: 2,
    providers,
    routes,
    embeddingRoutes: stored.embeddingRoutes?.length ? stored.embeddingRoutes : base.embeddingRoutes,
    clients: stored.clients ?? [],
    taskRouting: { ...base.taskRouting, ...(stored.taskRouting ?? {}) },
    cache: { ...base.cache, ...(stored.cache ?? {}) },
    logging: { ...base.logging, ...(stored.logging ?? {}) },
    anthropic: { modelMap: { ...base.anthropic.modelMap, ...(stored.anthropic?.modelMap ?? {}) } },
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

/** Config safe to send to the UI: keys masked (resolved through the secret store when given). */
export function redactConfig(cfg: AppConfig, keyFor?: (id: string) => string | undefined): AppConfig {
  return {
    ...cfg,
    providers: cfg.providers.map((p) => ({ ...p, apiKey: maskKey(keyFor ? keyFor(p.id) : p.apiKey) })),
    clients: cfg.clients.map((c) => ({ ...c, keyHash: "" })),
  };
}

/**
 * Apply an update from the UI. Keys are never changed through config updates
 * (they go through /admin/secrets or the Keychain), and client key hashes are
 * kept from the current config.
 */
export function applyUpdate(current: AppConfig, update: AppConfig): AppConfig {
  return {
    ...update,
    version: 2,
    providers: update.providers.map((p) => {
      const existing = current.providers.find((c) => c.id === p.id);
      return { ...p, apiKey: existing?.apiKey };
    }),
    clients: (update.clients ?? current.clients).map((c) => {
      const existing = current.clients.find((x) => x.id === c.id);
      return existing ? { ...c, keyHash: existing.keyHash, keyPrefix: existing.keyPrefix, createdAt: existing.createdAt } : c;
    }).filter((c) => current.clients.some((x) => x.id === c.id)), // clients are created only via /admin/clients
  };
}

export function providerHas(p: ProviderConfig, cap: Capability): boolean {
  return (p.capabilities ?? ["chat"]).includes(cap);
}

const EMBED_RE = /embed|bge|e5-|gte-|nomic|minilm|arctic|mxbai|jina/i;

export function isEmbeddingModel(p: ProviderConfig, model: string): boolean {
  if (p.embeddingModels?.includes(model)) return true;
  return EMBED_RE.test(model);
}
