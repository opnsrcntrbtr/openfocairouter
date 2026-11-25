import { describe, expect, test } from "bun:test";
import { applyUpdate, defaultConfig, maskKey, mergeWithDefaults, parseTarget, redactConfig, type AppConfig } from "../src/config";
import { parseDuration, QuotaTracker, retryAfterMs } from "../src/quota";
import { classify, Router, usageSniffer, type FetchFn } from "../src/router";
import { createHandler } from "../src/server";

function cfg(): AppConfig {
  const c = defaultConfig();
  for (const p of c.providers) if (p.kind === "cloud") p.apiKey = `key-${p.id}`;
  c.routes = [{ name: "auto", description: "", targets: ["groq/a", "gemini/b", "ollama/*"] }];
  return c;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(h: Handler): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    return h(url, init);
  }) as FetchFn & { calls: string[] };
  f.calls = calls;
  return f;
}

const ok = (model: string) =>
  Response.json({ id: "x", object: "chat.completion", choices: [{ message: { role: "assistant", content: `hi from ${model}` } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });

const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };

describe("config", () => {
  test("parseTarget keeps slashes in model ids", () => {
    expect(parseTarget("openrouter/meta-llama/llama-3.3-70b-instruct:free")).toEqual({ providerId: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" });
    expect(parseTarget("nope")).toBeNull();
  });
  test("redact + applyUpdate keep keys when UI sends masked values", () => {
    const c = cfg();
    const red = redactConfig(c);
    expect(red.providers[0]!.apiKey).toBe(maskKey("key-groq"));
    const back = applyUpdate(c, red);
    expect(back.providers[0]!.apiKey).toBe("key-groq");
    red.providers[0]!.apiKey = "new-key";
    expect(applyUpdate(c, red).providers[0]!.apiKey).toBe("new-key");
  });
  test("mergeWithDefaults adds new built-in providers", () => {
    const m = mergeWithDefaults({ providers: [defaultConfig().providers[0]!] });
    expect(m.providers.length).toBe(defaultConfig().providers.length);
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
  test("enforces RPM and RPD", () => {
    let now = Date.now();
    const q = new QuotaTracker(undefined, () => now);
    q.recordAttempt("g/a");
    q.recordAttempt("g/a");
    expect(q.check("g", "g/a", { rpm: 2 }).ok).toBe(false);
    now += 61_000;
    expect(q.check("g", "g/a", { rpm: 2 }).ok).toBe(true);
    expect(q.check("g", "g/a", { rpd: 2 }).ok).toBe(false);
  });
  test("daily counters roll over", () => {
    let now = new Date(2026, 10, 25, 23, 59).getTime();
    const q = new QuotaTracker(undefined, () => now);
    q.recordAttempt("g/a");
    now += 2 * 60_000;
    expect(q.snapshot().targets["g/a"]!.requestsToday).toBe(0);
  });
  test("exponential backoff and success clears cooldown", () => {
    const now = 1000;
    const q = new QuotaTracker(undefined, () => now);
    q.recordFailure("g/a", 500, "boom", "backoff");
    expect(q.targets["g/a"]!.cooldownUntil).toBe(now + 30_000);
    q.recordFailure("g/a", 500, "boom", "backoff");
    expect(q.targets["g/a"]!.cooldownUntil).toBe(now + 60_000);
    q.recordSuccess("g/a", 10);
    expect(q.check("g", "g/a").ok).toBe(true);
  });
});

describe("classify", () => {
  test("rate limits, outages and stale models fall back; bad requests do not", () => {
    expect(classify(429, "").fallback).toBe(true);
    expect(classify(503, "").fallback).toBe(true);
    expect(classify(401, "").providerWide).toBe(true);
    expect(classify(400, '{"error":"The model `x` has been decommissioned"}').fallback).toBe(true);
    expect(classify(400, "context length exceeded").cooldown).toBe("none");
    expect(classify(400, '{"error":"messages[0].role is invalid"}').fallback).toBe(false);
    expect(classify(400, "API key not valid. Please pass a valid API key.").providerWide).toBe(true);
  });
});

describe("router fallback", () => {
  test("serves from first healthy provider", async () => {
    const c = cfg();
    const f = mockFetch((url) => ok(url));
    const r = new Router(() => c, new QuotaTracker(), f);
    const res = await r.chat(body);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ofr-provider")).toBe("groq");
    expect(((await res.json()) as any).model).toBe("groq/a");
  });

  test("429 on Groq falls back to Gemini and cools Groq down using retry-after", async () => {
    const c = cfg();
    const f = mockFetch((url) =>
      url.includes("groq") ? new Response('{"error":"rate"}', { status: 429, headers: { "retry-after": "20" } }) : ok("b"),
    );
    const q = new QuotaTracker();
    const r = new Router(() => c, q, f);
    const res = await r.chat(body);
    expect(res.headers.get("x-ofr-provider")).toBe("gemini");
    expect(res.headers.get("x-ofr-attempts")).toBe("2");
    // second request skips Groq entirely while cooling down
    f.calls.length = 0;
    await r.chat(body);
    expect(f.calls.some((u) => u.includes("groq"))).toBe(false);
  });

  test("network error and 401 fall through to local Ollama with discovered model", async () => {
    const c = cfg();
    const f = mockFetch((url) => {
      if (url.includes("groq")) throw new TypeError("fetch failed");
      if (url.includes("googleapis")) return new Response("unauthorized", { status: 401 });
      if (url.endsWith("11434/v1/models")) return Response.json({ data: [{ id: "qwen3:8b" }] });
      return ok("local");
    });
    const q = new QuotaTracker();
    const r = new Router(() => c, q, f);
    const res = await r.chat(body);
    expect(res.headers.get("x-ofr-provider")).toBe("ollama");
    expect(res.headers.get("x-ofr-model")).toBe("qwen3:8b");
    expect(q.providerCooldowns["gemini"]).toBeDefined();
  });

  test("bad request is returned to the client without trying others", async () => {
    const c = cfg();
    const f = mockFetch(() => new Response('{"error":"messages is invalid"}', { status: 400 }));
    const r = new Router(() => c, new QuotaTracker(), f);
    const res = await r.chat(body);
    expect(res.status).toBe(400);
    expect(f.calls.length).toBe(1);
  });

  test("skips providers without keys and returns 503 when everything is exhausted", async () => {
    const c = cfg();
    c.providers.find((p) => p.id === "gemini")!.apiKey = undefined;
    const f = mockFetch((url) => (url.includes("/models") ? Response.json({ data: [] }) : new Response("down", { status: 502 })));
    const r = new Router(() => c, new QuotaTracker(), f);
    const res = await r.chat(body);
    expect(res.status).toBe(503);
    const j: any = await res.json();
    expect(j.error.attempts.map((a: any) => a.outcome)).toEqual(["failed", "skipped", "skipped"]);
  });

  test("direct provider/model requests bypass routes", async () => {
    const c = cfg();
    const f = mockFetch(() => ok("x"));
    const r = new Router(() => c, new QuotaTracker(), f);
    await r.chat({ ...body, model: "mistral/mistral-small-latest" });
    expect(f.calls[0]).toContain("api.mistral.ai");
  });

  test("OpenRouter discovery keeps only :free models", async () => {
    const c = cfg();
    const f = mockFetch(() => Response.json({ data: [{ id: "a/b:free" }, { id: "a/paid" }] }));
    const r = new Router(() => c, new QuotaTracker(), f);
    expect(await r.listModels("openrouter")).toEqual(["a/b:free"]);
  });
});

describe("streaming", () => {
  test("usage sniffer records tokens and passes bytes through", async () => {
    let usage: any;
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n';
    const out = await new Response(new Response(sse).body!.pipeThrough(usageSniffer((u) => (usage = u)))).text();
    expect(out).toBe(sse);
    expect(usage.total_tokens).toBe(3);
  });
});

describe("server", () => {
  const make = () => {
    const c = cfg();
    const r = new Router(() => c, new QuotaTracker(), mockFetch(() => ok("x")));
    return createHandler({ router: r, getConfig: () => c, saveConfig: () => {}, adminToken: "t".repeat(48), version: "test" });
  };
  test("blocks foreign browser origins", async () => {
    const res = await make()(new Request("http://127.0.0.1:4141/v1/models", { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
  });
  test("admin requires the token and never returns raw keys", async () => {
    const h = make();
    expect((await h(new Request("http://x/admin/config"))).status).toBe(401);
    const res = await h(new Request("http://x/admin/config", { headers: { authorization: `Bearer ${"t".repeat(48)}` } }));
    const j: any = await res.json();
    expect(JSON.stringify(j)).not.toContain("key-groq");
  });
  test("chat completions end to end", async () => {
    const res = await make()(new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify(body) }));
    expect(res.status).toBe(200);
  });
});
