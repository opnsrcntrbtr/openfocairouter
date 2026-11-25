// Talks to the local router sidecar. The admin token comes from the Tauri shell;
// in browser dev (`npm run dev:ui` + `npm run dev:router`) paste the token the router prints.
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface Limits { rpm?: number; rpd?: number }
export interface Provider {
  id: string; name: string; baseUrl: string; apiKey?: string; enabled: boolean;
  kind: "cloud" | "local"; free: "free" | "credits" | "local"; keyUrl?: string; notes?: string;
  limits?: Limits; modelLimits?: Record<string, Limits>;
  [k: string]: unknown;
}
export interface Route { name: string; description: string; targets: string[] }
export interface Config { version: 1; localApiKey?: string; requestTimeoutMs: number; defaultRoute: string; providers: Provider[]; routes: Route[] }
export interface Stats {
  requestsToday: number; tokensToday: number; successes: number; failures: number; recent: number[];
  cooldownUntil?: number; lastStatus?: number; lastError?: string; lastUsedAt?: number; avgLatencyMs?: number;
  remainingRequests?: number; remainingTokens?: number;
}
export interface Attempt { target: string; outcome: "ok" | "skipped" | "failed"; status?: number; reason?: string; ms?: number }
export interface RouterEvent { at: number; requested: string; served?: string; attempts: Attempt[]; stream: boolean; ms: number; ok: boolean }
export interface Usage { targets: Record<string, Stats>; providerCooldowns: Record<string, { until: number; reason: string }>; events: RouterEvent[]; now: number }

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

export const api = {
  config: () => call<Config>("/admin/config"),
  saveConfig: (c: Config) => call<Config>("/admin/config", { method: "PUT", body: JSON.stringify(c) }),
  usage: () => call<Usage>("/admin/usage"),
  resetUsage: () => call<{ ok: boolean }>("/admin/usage/reset", { method: "POST" }),
  models: (id: string, refresh = false) => call<{ models: string[]; error?: string }>(`/admin/providers/${id}/models${refresh ? "?refresh" : ""}`),
  test: (id: string) => call<{ ok: boolean; detail: string; ms: number }>(`/admin/providers/${id}/test`, { method: "POST" }),
  clear: (id: string) => call<{ ok: boolean }>(`/admin/providers/${id}/clear`, { method: "POST" }),
};

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Stream a chat completion through the router; calls onDelta for each token chunk. */
export async function streamChat(
  model: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<{ provider?: string; model?: string; attempts?: string }> {
  const res = await fetch(baseUrl() + "/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text();
    let msg = t;
    try { msg = JSON.parse(t).error?.message ?? t; } catch { /* not JSON */ }
    throw new Error(`${res.status}: ${msg}`);
  }
  const meta = { provider: res.headers.get("x-ofr-provider") ?? undefined, model: res.headers.get("x-ofr-model") ?? undefined, attempts: res.headers.get("x-ofr-attempts") ?? undefined };
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
