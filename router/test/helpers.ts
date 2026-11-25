// Test harness: full router stack with in-memory SQLite and a scripted mock provider.
import { defaultConfig, type AppConfig } from "../src/config";
import { QuotaTracker } from "../src/quota";
import { Router, type FetchFn } from "../src/router";
import { Store } from "../src/db";
import { ClientLimiter } from "../src/clients";
import { Embedder } from "../src/embedder";
import { Classifier } from "../src/classify";
import { ResponseCache } from "../src/cache";
import { Gateway } from "../src/gateway";
import { createHandler } from "../src/server";
import { SecretStore } from "../src/secrets";
import { Balancer } from "../src/balance";

export const ADMIN = "a".repeat(48);

export function cfg(): AppConfig {
  const c = defaultConfig();
  c.routes = [
    { name: "auto", description: "", targets: ["groq/a", "gemini/b", "ollama/*"] },
    { name: "coding", description: "", targets: ["mistral/code"] },
    { name: "fast", description: "", targets: ["groq/fast"] },
    { name: "reasoning", description: "", targets: ["gemini/think"] },
    { name: "long-context", description: "", targets: ["gemini/long"] },
    { name: "vision", description: "", targets: ["gemini/vision"] },
  ];
  return c;
}

/** Bag-of-words hashing embedding: shared words → similar vectors. Deterministic. */
export function fakeEmbed(text: string, dims = 128): number[] {
  const v = new Array(dims).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % dims] += 1;
  }
  return v;
}

export const okChat = (model: string, extra: any = {}) =>
  Response.json({
    id: "x",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: `hi from ${model}`, ...extra }, finish_reason: extra.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });

export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function mockFetch(h: Handler): FetchFn & { calls: string[]; bodies: any[] } {
  const calls: string[] = [];
  const bodies: any[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return h(url, init);
  }) as FetchFn & { calls: string[]; bodies: any[] };
  f.calls = calls;
  f.bodies = bodies;
  return f;
}

/** Default local behaviour: Ollama serves a chat + embedding model; embeddings use fakeEmbed. */
export function localAware(h: Handler): Handler {
  return (url, init) => {
    if (url.endsWith("11434/v1/models")) return Response.json({ data: [{ id: "qwen3:8b" }, { id: "nomic-embed-text" }] });
    if (url.endsWith(":8001/v1/models")) return new Response("down", { status: 502 });
    if (url.endsWith("11434/v1/embeddings")) {
      const b = JSON.parse(String(init?.body));
      const inputs: string[] = Array.isArray(b.input) ? b.input : [b.input];
      return Response.json({ data: inputs.map((t, index) => ({ index, embedding: fakeEmbed(t) })), model: b.model, usage: { prompt_tokens: 3 } });
    }
    return h(url, init);
  };
}

export function stack(opts: { config?: AppConfig; fetch?: FetchFn; clock?: () => number; random?: () => number } = {}) {
  const config = opts.config ?? cfg();
  let current = config;
  const secrets = new SecretStore(false);
  for (const p of current.providers) if (p.kind === "cloud") secrets.set(`provider:${p.id}`, `key-${p.id}`);
  const fetchImpl = opts.fetch ?? mockFetch(localAware((u) => okChat(u)));
  const quota = new QuotaTracker(undefined, opts.clock);
  const router = new Router(() => current, quota, fetchImpl, opts.clock, secrets, new Balancer(opts.random ?? (() => 0.5)));
  const store = new Store(":memory:");
  const embedder = new Embedder(router, opts.clock, fetchImpl);
  const classifier = new Classifier(embedder, () => current.taskRouting, opts.clock);
  const cache = new ResponseCache(store, embedder, () => current.cache, opts.clock);
  const limiter = new ClientLimiter(opts.clock);
  const gateway = new Gateway({ router, classifier, cache, store, limiter, getConfig: () => current, adminToken: ADMIN, clock: opts.clock });
  const handler = createHandler({
    router, gateway, classifier, cache, store, secrets, adminToken: ADMIN, version: "test",
    getConfig: () => current,
    saveConfig: (c) => (current = c),
  });
  const call = (path: string, init: RequestInit & { json?: any } = {}) => {
    const { json, ...rest } = init;
    return handler(new Request("http://127.0.0.1:4141" + path, {
      method: json !== undefined ? "POST" : "GET",
      ...rest,
      headers: { "content-type": "application/json", ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    }));
  };
  const admin = (path: string, init: RequestInit & { json?: any } = {}) => call(path, { ...init, headers: { authorization: `Bearer ${ADMIN}`, ...(init.headers ?? {}) } });
  return { router, store, cache, classifier, secrets, limiter, gateway, handler, call, admin, config: () => current, fetch: fetchImpl as any };
}

export const chatBody = (content = "hi", extra: any = {}) => ({ model: "auto", messages: [{ role: "user", content }], ...extra });
