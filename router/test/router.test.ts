import { describe, expect, test } from "bun:test";
import { applyUpdate, defaultConfig, isEmbeddingModel, maskKey, mergeWithDefaults, parseTarget, redactConfig } from "../src/config";
import { parseDuration, QuotaTracker, retryAfterMs } from "../src/quota";
import { classify, isFallback, usageSniffer } from "../src/router";
import { cfg, chatBody, localAware, mockFetch, okChat, stack } from "./helpers";

describe("config", () => {
  test("parseTarget keeps slashes in model ids", () => {
    expect(parseTarget("openrouter/meta-llama/llama-3.3-70b-instruct:free")).toEqual({ providerId: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" });
    expect(parseTarget("nope")).toBeNull();
  });
  test("redact masks keys; applyUpdate never changes keys or client hashes", () => {
    const c = cfg();
    c.providers[0]!.apiKey = "key-groq";
    c.clients = [{ id: "x", name: "x", keyHash: "h", keyPrefix: "ofr-abcd", enabled: true, createdAt: 1 }];
    const red = structuredClone(redactConfig(c));
    expect(red.providers[0]!.apiKey).toBe(maskKey("key-groq"));
    red.providers[0]!.apiKey = "attempted-change";
    (red.clients[0] as any).keyHash = "evil";
    red.clients.push({ id: "smuggled", name: "s", keyHash: "s", keyPrefix: "s", enabled: true, createdAt: 1 });
    const back = applyUpdate(c, red);
    expect(back.providers[0]!.apiKey).toBe("key-groq");
    expect(back.clients.map((x) => x.keyHash)).toEqual(["h"]);
  });
  test("v1 config migrates: new routes, oMLX in local chains, new providers", () => {
    const v1 = { version: 1, providers: [defaultConfig().providers[0]!], routes: [{ name: "auto", description: "", targets: ["groq/x", "ollama/*"] }] } as any;
    const m = mergeWithDefaults(v1);
    expect(m.version).toBe(2);
    expect(m.providers.some((p) => p.id === "omlx")).toBe(true);
    expect(m.routes.find((r) => r.name === "auto")!.targets).toEqual(["groq/x", "omlx/*", "ollama/*"]);
    expect(m.routes.some((r) => r.name === "coding")).toBe(true);
    expect(m.taskRouting.enabled).toBe(false);
  });
  test("embedding model detection", () => {
    const p = defaultConfig().providers.find((x) => x.id === "omlx")!;
    expect(isEmbeddingModel(p, "mlx-community/nomic-embed-text-v1.5")).toBe(true);
    expect(isEmbeddingModel(p, "bge-m3")).toBe(true);
    expect(isEmbeddingModel(p, "Qwen3-Coder-30B")).toBe(false);
  });
});

describe("quota", () => {
  test("parseDuration handles provider formats", () => {
    expect(parseDuration("2m59.56s")).toBe(179560);
    expect(parseDuration("7.66s")).toBe(7660);
    expect(parseDuration("30")).toBe(30000);
    expect(parseDuration("120ms")).toBe(120);
  });
  test("retryAfterMs reads retry-after and OpenRouter epoch-ms reset", () => {
    const now = 1_800_000_000_000;
    expect(retryAfterMs(new Headers({ "retry-after": "12" }), now)).toBe(12000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": String(now + 5000) }), now)).toBe(5000);
  });
  test("enforces RPM and RPD, rolls days", () => {
    let now = new Date(2026, 10, 25, 23, 58).getTime();
    const q = new QuotaTracker(undefined, () => now);
    q.recordAttempt("g/a");
    q.recordAttempt("g/a");
    expect(q.check("g", "g/a", { rpm: 2 }).ok).toBe(false);
    now += 61_000;
    expect(q.check("g", "g/a", { rpm: 2 }).ok).toBe(true);
    expect(q.check("g", "g/a", { rpd: 2 }).ok).toBe(false);
    now += 2 * 60_000;
    expect(q.snapshot().targets["g/a"]!.requestsToday).toBe(0);
  });
  test("exponential backoff and success clears cooldown", () => {
    const q = new QuotaTracker(undefined, () => 1000);
    q.recordFailure("g/a", 500, "boom", "backoff");
    expect(q.targets["g/a"]!.cooldownUntil).toBe(31_000);
    q.recordFailure("g/a", 500, "boom", "backoff");
    expect(q.targets["g/a"]!.cooldownUntil).toBe(61_000);
    q.recordSuccess("g/a", 10);
    expect(q.check("g", "g/a").ok).toBe(true);
  });
});

describe("classify upstream errors", () => {
  test("rate limits, outages, stale models, no-tools fall back; bad requests do not", () => {
    expect(classify(429, "").fallback).toBe(true);
    expect(classify(503, "").fallback).toBe(true);
    expect(classify(401, "").providerWide).toBe(true);
    expect(classify(400, '{"error":"The model `x` has been decommissioned"}').fallback).toBe(true);
    expect(classify(400, "context length exceeded").cooldown).toBe("none");
    expect(classify(400, "This model does not support tools").fallback).toBe(true);
    expect(classify(400, '{"error":"messages[0].role is invalid"}').fallback).toBe(false);
    expect(classify(400, "API key not valid. Please pass a valid API key.").providerWide).toBe(true);
  });
});

describe("fallback accounting", () => {
  test("skips for missing keys or disabled providers are not fallbacks; failures and cooldowns are", () => {
    expect(isFallback([{ target: "a", outcome: "skipped", reason: "no API key" }, { target: "b", outcome: "ok" }])).toBe(false);
    expect(isFallback([{ target: "a", outcome: "skipped", reason: "cooldown" }, { target: "b", outcome: "ok" }])).toBe(true);
    expect(isFallback([{ target: "a", outcome: "failed", status: 429 }, { target: "b", outcome: "ok" }])).toBe(true);
  });
});

describe("fallback through the gateway", () => {
  test("serves from first healthy provider", async () => {
    const s = stack();
    const res = await s.call("/v1/chat/completions", { json: chatBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ofr-provider")).toBe("groq");
    expect(((await res.json()) as any).model).toBe("groq/a");
  });

  test("429 falls back and cools the provider down using retry-after", async () => {
    const f = mockFetch(localAware((url) => (url.includes("groq") ? new Response('{"error":"rate"}', { status: 429, headers: { "retry-after": "20" } }) : okChat(url))));
    const s = stack({ fetch: f });
    const res = await s.call("/v1/chat/completions", { json: chatBody("one") });
    expect(res.headers.get("x-ofr-provider")).toBe("gemini");
    expect(res.headers.get("x-ofr-attempts")).toBe("2");
    f.calls.length = 0;
    await s.call("/v1/chat/completions", { json: chatBody("two") });
    expect(f.calls.some((u: string) => u.includes("groq"))).toBe(false);
  });

  test("network error and 401 fall through to local Ollama with the first *chat* model", async () => {
    const f = mockFetch(localAware((url) => {
      if (url.includes("groq")) throw new TypeError("fetch failed");
      if (url.includes("googleapis")) return new Response("unauthorized", { status: 401 });
      return okChat("local");
    }));
    const s = stack({ fetch: f });
    const res = await s.call("/v1/chat/completions", { json: chatBody() });
    expect(res.headers.get("x-ofr-provider")).toBe("ollama");
    expect(res.headers.get("x-ofr-model")).toBe("qwen3:8b");
    expect(s.router.quota.providerCooldowns["gemini"]).toBeDefined();
  });

  test("bad request is returned without trying others", async () => {
    const f = mockFetch(localAware(() => new Response('{"error":"messages is invalid"}', { status: 400 })));
    const s = stack({ fetch: f });
    const res = await s.call("/v1/chat/completions", { json: chatBody() });
    expect(res.status).toBe(400);
    expect(f.calls.filter((u: string) => u.includes("chat/completions")).length).toBe(1);
  });

  test("503 with attempts trail when everything is exhausted", async () => {
    const f = mockFetch((url) => (url.includes("/models") ? Response.json({ data: [] }) : new Response("down", { status: 502 })));
    const s = stack({ fetch: f });
    s.secrets.set("provider:gemini", undefined);
    const res = await s.call("/v1/chat/completions", { json: chatBody() });
    expect(res.status).toBe(503);
    const j: any = await res.json();
    expect(j.error.attempts.map((a: any) => a.outcome)).toEqual(["failed", "skipped", "skipped"]);
  });

  test("direct provider/model requests bypass routes", async () => {
    const f = mockFetch(localAware(() => okChat("x")));
    const s = stack({ fetch: f });
    await s.call("/v1/chat/completions", { json: { ...chatBody(), model: "mistral/mistral-small-latest" } });
    expect(f.calls.find((u: string) => u.includes("chat/completions"))).toContain("api.mistral.ai");
  });

  test("OpenRouter discovery keeps only :free models", async () => {
    const s = stack({ fetch: mockFetch(() => Response.json({ data: [{ id: "a/b:free" }, { id: "a/paid" }] })) });
    expect(await s.router.listModels("openrouter")).toEqual(["a/b:free"]);
  });

  test("oMLX down is skipped as 'not running', not cooled down", async () => {
    const c = cfg();
    c.routes[0]!.targets = ["omlx/*", "ollama/*"];
    const s = stack({ config: c });
    const res = await s.call("/v1/chat/completions", { json: chatBody() });
    expect(res.headers.get("x-ofr-provider")).toBe("ollama");
    expect(s.router.quota.providerCooldowns["omlx"]).toBeUndefined();
  });
});

describe("streaming", () => {
  test("usage sniffer records tokens, passes bytes through and reports done", async () => {
    let usage: any;
    let done: any;
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n';
    const out = await new Response(new Response(sse).body!.pipeThrough(usageSniffer((u) => (usage = u), (u) => (done = u)))).text();
    expect(out).toBe(sse);
    expect(usage.total_tokens).toBe(3);
    expect(done.total_tokens).toBe(3);
  });
});

describe("timeouts", () => {
  test("timeout applies to headers only: a slow stream after headers is not cut off", async () => {
    const c = cfg();
    c.requestTimeoutMs = 100;
    c.routes[0]!.targets = ["groq/a"];
    const f = mockFetch(() => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(ctl) {
          ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          await Bun.sleep(250); // longer than the timeout
          ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n'));
          ctl.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const s = stack({ config: c, fetch: f });
    const txt = await (await s.call("/v1/chat/completions", { json: chatBody("x", { stream: true }) })).text();
    expect(txt).toContain('"b"');
  });
  test("no headers within the timeout → timeout and fallback", async () => {
    const c = cfg();
    c.requestTimeoutMs = 50;
    const f = mockFetch(localAware(async (url, init) => {
      if (url.includes("groq")) {
        await new Promise((r, j) => init?.signal?.addEventListener("abort", () => j(init.signal!.reason)));
      }
      return okChat(url);
    }));
    const s = stack({ config: c, fetch: f });
    const res = await s.call("/v1/chat/completions", { json: chatBody() });
    expect(res.headers.get("x-ofr-provider")).toBe("gemini");
  });
});

describe("retired providers", () => {
  test("GitHub Models is removed from stored configs, routes and embedding routes", () => {
    const stored: any = {
      version: 2,
      providers: [...defaultConfig().providers, { id: "github", name: "GitHub Models", baseUrl: "https://models.github.ai/inference", enabled: true, kind: "cloud", free: "free" }],
      routes: [{ name: "auto", description: "", targets: ["groq/a", "github/openai/gpt-4.1-mini", "ollama/*"] }],
      embeddingRoutes: [{ name: "gh", description: "", space: "gh", targets: ["github/openai/text-embedding-3-small"] }, { name: "embed", description: "", space: "x", targets: ["omlx/*embed"] }],
    };
    const m = mergeWithDefaults(stored);
    expect(m.providers.some((p) => p.id === "github")).toBe(false);
    expect(m.routes[0]!.targets).toEqual(["groq/a", "ollama/*"]);
    expect(m.embeddingRoutes.map((r) => r.name)).toEqual(["embed"]);
  });
  test("a non-JSON /models reply gives a clear error instead of a parse crash", async () => {
    const s = stack({ fetch: mockFetch(() => new Response("OK", { status: 200 })) });
    await expect(s.router.listModels("groq", true)).rejects.toThrow(/non-JSON reply.*"OK"/);
  });
});
