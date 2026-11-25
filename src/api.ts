// Talks to the local router sidecar. The admin token comes from the Tauri shell;
// in browser dev (`npm run dev:ui` + `npm run dev:router`) paste the token the router prints.
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface Limits { rpm?: number; rpd?: number }
export interface Provider {
  id: string; name: string; baseUrl: string; apiKey?: string; enabled: boolean;
  kind: "cloud" | "local"; free: "free" | "credits" | "local"; capabilities?: ("chat" | "embeddings")[];
  keyUrl?: string; notes?: string; trainsOnFreeTier?: boolean;
  limits?: Limits; modelLimits?: Record<string, Limits>;
  [k: string]: unknown;
}
export type Strategy = "ordered" | "latency" | "balanced";
export interface Route { name: string; description: string; targets: string[]; strategy?: Strategy; tiers?: Record<string, number> }
export interface EmbeddingRoute { name: string; description: string; space: string; targets: string[] }
export interface ClientConfig {
  id: string; name: string; keyPrefix: string; enabled: boolean; allowedRoutes?: string[];
  limits?: Limits & { tokensPerDay?: number }; cache?: boolean; semanticCache?: boolean; localOnly?: boolean; createdAt: number;
}
export interface TaskDef { name: string; route: string; threshold: number; examples: string[] }
export interface Config {
  version: 2; requireClientKeys: boolean; requestTimeoutMs: number; defaultRoute: string; defaultEmbeddingRoute: string;
  providers: Provider[]; routes: Route[]; embeddingRoutes: EmbeddingRoute[]; clients: ClientConfig[];
  taskRouting: { enabled: boolean; stickyMinutes: number; longContextTokens: number; quickMaxChars: number; margin: number; embedder: string; tasks: TaskDef[] };
  cache: { exact: boolean; semantic: boolean; ttlHours: number; maxMb: number; maxTemperature: number; semanticThreshold: number };
  logging: { bodies: boolean; retentionDays: number };
  anthropic: { modelMap: Record<string, string> };
  secretsManaged?: boolean;
}
export interface Stats {
  requestsToday: number; tokensToday: number; successes: number; failures: number; recent: number[];
  cooldownUntil?: number; lastStatus?: number; lastError?: string; lastUsedAt?: number; avgLatencyMs?: number;
  remainingRequests?: number; remainingTokens?: number;
}
export interface Attempt { target: string; outcome: "ok" | "skipped" | "failed"; status?: number; reason?: string; ms?: number }
export interface RouterEvent { at: number; requested: string; served?: string; attempts: Attempt[]; stream: boolean; ms: number; ok: boolean; client?: string; task?: string; fallback?: boolean }
export interface Usage {
  targets: Record<string, Stats>; providerCooldowns: Record<string, { until: number; reason: string }>; events: RouterEvent[]; now: number;
  scores: Record<string, { ewmaMs?: number; errorRate: number; samples: number }>; cache: { entries: number; bytes: number; hits: number };
}
export interface ClientTotals { requests: number; promptTokens: number; completionTokens: number; errors: number; fallbacks: number; cacheHits: number }
export interface ClientView {
  id: string; name: string; kind: "key" | "user-agent" | "header" | "app" | "anonymous"; config?: ClientConfig;
  totals30d: ClientTotals; latency7d?: { p50: number; p95: number };
  days: (ClientTotals & { day: string; latencyTotal: number })[];
}
export interface LogRow {
  id: number; ts: number; client: string; api: string; requested: string; task?: string; taskScore?: number; taskReason?: string;
  served?: string; attempts: Attempt[]; status: number; stream: boolean; cache?: string; ttfbMs?: number; ms: number;
  promptTokens?: number; completionTokens?: number; error?: string; requestBody?: string | null; responseBody?: string | null;
}
export interface TaskDecision { task: string; route: string; score?: number; reason: string; scores?: Record<string, number>; ms: number }

let token: string | null = null;
let port = 4141;

export async function init(): Promise<void> {
  if (isTauri()) {
    token = await invoke<string>("admin_token");
    port = await invoke<number>("router_port");
  } else {
    token = localStorage.getItem("ofr-admin-token") ?? window.prompt("Admin token printed by `npm run dev:router`:") ?? "";
    localStorage.setItem("ofr-admin-token", token);
  }
}

export const inApp = () => isTauri();
export const baseUrl = () => `http://127.0.0.1:${port}`;
export const adminToken = () => token ?? "";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export async function waitForRouter(tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(baseUrl() + "/health")).ok) return true;
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Store a secret: the Keychain (via the shell) in the app, the router directly in browser dev. */
export async function setSecret(account: string, value: string | null): Promise<void> {
  if (isTauri()) await invoke("set_secret", { account, value });
  else await call("/admin/secrets", { method: "PUT", body: JSON.stringify({ account, value }) });
}

export async function getClientKey(id: string): Promise<string | null> {
  return isTauri() ? invoke<string | null>("get_client_key", { id }) : null;
}

export const api = {
  config: () => call<Config>("/admin/config"),
  saveConfig: (c: Config) => call<Config>("/admin/config", { method: "PUT", body: JSON.stringify(c) }),
  usage: () => call<Usage>("/admin/usage"),
  resetUsage: () => call<{ ok: boolean }>("/admin/usage/reset", { method: "POST" }),
  models: (id: string, refresh = false) => call<{ models: string[]; error?: string }>(`/admin/providers/${id}/models${refresh ? "?refresh" : ""}`),
  test: (id: string) => call<{ ok: boolean; detail: string; ms: number }>(`/admin/providers/${id}/test`, { method: "POST" }),
  clear: (id: string) => call<{ ok: boolean }>(`/admin/providers/${id}/clear`, { method: "POST" }),
  clients: () => call<{ clients: ClientView[] }>("/admin/clients"),
  createClient: (b: { name: string; localOnly?: boolean; limits?: ClientConfig["limits"] }) => call<{ client: ClientConfig; key: string }>("/admin/clients", { method: "POST", body: JSON.stringify(b) }),
  rotateClient: (id: string) => call<{ key: string }>(`/admin/clients/${id}/rotate`, { method: "POST" }),
  deleteClient: (id: string) => call<{ ok: boolean }>(`/admin/clients/${id}`, { method: "DELETE" }),
  logs: (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return call<{ logs: LogRow[] }>(`/admin/logs?${p}`);
  },
  log: (id: number) => call<LogRow>(`/admin/logs/${id}`),
  purgeBodies: () => call<{ ok: boolean }>("/admin/logs/purge-bodies", { method: "POST" }),
  classify: (text: string) => call<TaskDecision>("/admin/classify", { method: "POST", body: JSON.stringify({ text }) }),
  purgeCache: () => call<{ ok: boolean }>("/admin/cache/purge", { method: "POST" }),
};

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Stream a chat completion through the router; calls onDelta for each token chunk. */
export async function streamChat(
  model: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<{ provider?: string; model?: string; attempts?: string; task?: string; cache?: string }> {
  const res = await fetch(baseUrl() + "/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-ofr-client": "OpenFOC chat" },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text();
    let msg = t;
    try { msg = JSON.parse(t).error?.message ?? t; } catch { /* not JSON */ }
    throw new Error(`${res.status}: ${msg}`);
  }
  const h = (k: string) => res.headers.get(k) ?? undefined;
  const meta = { provider: h("x-ofr-provider"), model: h("x-ofr-model"), attempts: h("x-ofr-attempts"), task: h("x-ofr-task"), cache: h("x-ofr-cache") };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* keep-alive or partial */ }
    }
  }
  return meta;
}
