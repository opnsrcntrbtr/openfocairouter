import { describe, expect, test } from "bun:test";
import { ADMIN, cfg, chatBody, fakeEmbed, localAware, mockFetch, okChat, stack } from "./helpers";
import { rules } from "../src/classify";
import { defaultConfig } from "../src/config";
import { Balancer } from "../src/balance";

const sseOf = (texts: string[], usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }) =>
  new Response(
    texts.map((t) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`).join("") +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

describe("server security", () => {
  test("blocks foreign browser origins", async () => {
    const s = stack();
    const res = await s.call("/v1/models", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
  test("admin requires the token and never returns raw keys", async () => {
    const s = stack();
    s.config().providers[0]!.apiKey = "key-raw-groq";
    expect((await s.call("/admin/config")).status).toBe(401);
    const txt = await (await s.admin("/admin/config")).text();
    expect(txt).not.toContain("key-raw-groq");
    expect(txt).not.toContain("key-groq");
  });
  test("/admin/secrets sets a provider key (headless mode)", async () => {
    const s = stack();
    s.secrets.set("provider:mistral", undefined);
    const r = await s.admin("/admin/secrets", { method: "PUT", body: JSON.stringify({ account: "provider:mistral", value: "new" }) });
    expect(r.status).toBe(200);
    expect(s.secrets.providerKey("mistral")).toBe("new");
    expect((await s.admin("/admin/secrets", { method: "PUT", body: JSON.stringify({ account: "../etc", value: "x" }) })).status).toBe(400);
  });
});

describe("clients", () => {
  test("create → key works, stats are per client, list never shows hashes", async () => {
    const s = stack();
    const r: any = await (await s.admin("/admin/clients", { json: { name: "Cursor" } })).json();
    expect(r.key).toStartWith("ofr-");
    const res = await s.call("/v1/chat/completions", { json: chatBody(), headers: { authorization: `Bearer ${r.key}` } });
    expect(res.headers.get("x-ofr-client")).toBe(r.client.id);
    await s.call("/v1/chat/completions", { json: chatBody("x"), headers: { "user-agent": "aider/0.80" } });
    s.store.flush();
    const list: any = await (await s.admin("/admin/clients")).json();
    expect(JSON.stringify(list)).not.toContain("keyHash");
    const ids = list.clients.map((c: any) => c.id);
    expect(ids).toContain(r.client.id);
    expect(ids).toContain("ua:aider");
    expect(list.clients.find((c: any) => c.id === r.client.id).totals30d.requests).toBe(1);
  });
  test("strict mode rejects unkeyed callers; disabled and rotated keys stop working", async () => {
    const s = stack();
    const r: any = await (await s.admin("/admin/clients", { json: { name: "aider" } })).json();
    s.config().requireClientKeys = true;
    expect((await s.call("/v1/chat/completions", { json: chatBody() })).status).toBe(401);
    expect((await s.call("/v1/chat/completions", { json: chatBody(), headers: { "x-api-key": r.key } })).status).toBe(200);
    const rot: any = await (await s.admin(`/admin/clients/${r.client.id}/rotate`, { method: "POST" })).json();
    expect((await s.call("/v1/chat/completions", { json: chatBody(), headers: { "x-api-key": r.key } })).status).toBe(401);
    expect((await s.call("/v1/chat/completions", { json: chatBody(), headers: { "x-api-key": rot.key } })).status).toBe(200);
  });
  test("client RPM limit returns ofr_client_limit 429 without touching providers", async () => {
    const f = mockFetch(localAware((u) => okChat(u)));
    const s = stack({ fetch: f });
    const r: any = await (await s.admin("/admin/clients", { json: { name: "script", limits: { rpm: 1 } } })).json();
    const h = { authorization: `Bearer ${r.key}`, "cache-control": "no-cache" };
    expect((await s.call("/v1/chat/completions", { json: chatBody(), headers: h })).status).toBe(200);
    const n = f.calls.length;
    const res = await s.call("/v1/chat/completions", { json: chatBody(), headers: h });
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error.type).toBe("ofr_client_limit");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(f.calls.length).toBe(n);
  });
  test("local-only clients never reach cloud providers", async () => {
    const f = mockFetch(localAware((u) => okChat(u)));
    const s = stack({ fetch: f });
    const r: any = await (await s.admin("/admin/clients", { json: { name: "private", localOnly: true } })).json();
    const res = await s.call("/v1/chat/completions", { json: chatBody(), headers: { authorization: `Bearer ${r.key}` } });
    expect(res.headers.get("x-ofr-provider")).toBe("ollama");
    expect(f.calls.some((u: string) => u.includes("groq") || u.includes("googleapis"))).toBe(false);
  });
});

describe("cache", () => {
  test("exact hit at temperature 0 uses no provider quota and is logged", async () => {
    const f = mockFetch(localAware((u) => okChat(u)));
    const s = stack({ fetch: f });
    const body = chatBody("what is 2+2", { temperature: 0 });
    const a = await s.call("/v1/chat/completions", { json: body });
    expect(a.headers.get("x-ofr-cache")).toBe("miss");
    const n = f.calls.length;
    const b = await s.call("/v1/chat/completions", { json: body });
    expect(b.headers.get("x-ofr-cache")).toBe("hit");
    expect(f.calls.length).toBe(n);
    expect(((await b.json()) as any).choices[0].message.content).toContain("hi from");
    const logs: any = await (await s.admin("/admin/logs")).json();
    expect(logs.logs[0].cache).toBe("hit");
  });
  test("high temperature and tool results bypass the cache; no-cache header bypasses", async () => {
    const s = stack();
    expect((await s.call("/v1/chat/completions", { json: chatBody("a", { temperature: 0.9 }) })).headers.get("x-ofr-cache")).toBe("bypass");
    const toolMsg = { model: "auto", temperature: 0, messages: [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "1", content: "r" }] };
    expect((await s.call("/v1/chat/completions", { json: toolMsg })).headers.get("x-ofr-cache")).toBe("bypass");
    expect((await s.call("/v1/chat/completions", { json: chatBody("b", { temperature: 0 }), headers: { "cache-control": "no-cache" } })).headers.get("x-ofr-cache")).toBe("bypass");
  });
  test("streamed responses are cached and replayed as SSE", async () => {
    const f = mockFetch(localAware(() => sseOf(["Hel", "lo"])));
    const s = stack({ fetch: f });
    const body = chatBody("greet", { temperature: 0, stream: true });
    const first = await (await s.call("/v1/chat/completions", { json: body })).text();
    expect(first).toContain("Hel");
    const second = await s.call("/v1/chat/completions", { json: body });
    expect(second.headers.get("x-ofr-cache")).toBe("hit");
    const txt = await second.text();
    expect(txt).toContain("Hello");
    expect(txt).toContain("[DONE]");
  });
  test("semantic cache (opt-in per client) matches near-identical prompts", async () => {
    const c = cfg();
    c.cache.semantic = true;
    c.cache.semanticThreshold = 0.9;
    const f = mockFetch(localAware((u) => okChat(u)));
    const s = stack({ config: c, fetch: f });
    const r: any = await (await s.admin("/admin/clients", { json: { name: "sem" } })).json();
    s.config().clients = s.config().clients.map((x) => ({ ...x, semanticCache: true }));
    const h = { authorization: `Bearer ${r.key}` };
    await s.call("/v1/chat/completions", { json: chatBody("What is the capital city of France please", { temperature: 0 }), headers: h });
    await new Promise((r) => setTimeout(r, 20)); // putSemantic is async
    const res = await s.call("/v1/chat/completions", { json: chatBody("what is the capital city of France?", { temperature: 0 }), headers: h });
    expect(res.headers.get("x-ofr-cache")).toBe("semantic-hit");
  });
});

describe("task routing", () => {
  test("rules: images → vision, long → long-context, code → coding, short → quick", () => {
    const t = defaultConfig().taskRouting;
    expect(rules({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }] }, t)?.task).toBe("vision");
    expect(rules({ messages: [{ role: "user", content: "x".repeat(200_000) }] }, t)?.task).toBe("long-context");
    expect(rules({ messages: [{ role: "user", content: "fix this:\n```js\nconst a = 1\n```" }] }, t)?.task).toBe("coding");
    expect(rules({ messages: [{ role: "user", content: "hi" }] }, t)?.task).toBe("quick");
    expect(rules({ messages: [{ role: "user", content: "Compare three options for a migration strategy and recommend one with careful reasoning about trade-offs in a medium sized team setting" }, { role: "assistant", content: "ok" }, { role: "user", content: "and the costs over five years for the infrastructure team considering hiring?" }] }, t)).toBeUndefined();
  });

  test("auto:task uses local embeddings to pick the coding route; override header wins", async () => {
    const f = mockFetch(localAware((u) => okChat(u)));
    const s = stack({ fetch: f });
    const prompt = "Please refactor this class and add unit tests for the payment service, fix the TypeError too";
    const res = await s.call("/v1/chat/completions", { json: { model: "auto:task", messages: [{ role: "system", content: "be helpful" }, { role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: prompt }] } });
    expect(res.headers.get("x-ofr-task")).toBe("coding");
    expect(res.headers.get("x-ofr-task-reason")).toBe("embedding");
    expect(res.headers.get("x-ofr-provider")).toBe("mistral");
    const o = await s.call("/v1/chat/completions", { json: { model: "auto", messages: [{ role: "user", content: "anything" }] }, headers: { "x-ofr-task": "reasoning" } });
    expect(o.headers.get("x-ofr-task")).toBe("reasoning");
    expect(o.headers.get("x-ofr-model")).toBe("think");
  });

  test("plain 'auto' is not classified unless task routing is enabled", async () => {
    const s = stack();
    const a = await s.call("/v1/chat/completions", { json: chatBody("hi") });
    expect(a.headers.get("x-ofr-task")).toBeNull();
    s.config().taskRouting.enabled = true;
    const b = await s.call("/v1/chat/completions", { json: chatBody("hi there") });
    expect(b.headers.get("x-ofr-task")).toBe("quick");
    expect(b.headers.get("x-ofr-model")).toBe("fast");
  });

  test("stickiness keeps a conversation on its task; images force a switch", async () => {
    const s = stack();
    const sys = { role: "system", content: "You are a coding assistant" };
    const first = { role: "user", content: "```py\nprint(1)\n```" };
    const a = await s.call("/v1/chat/completions", { json: { model: "auto:task", messages: [sys, first] } });
    expect(a.headers.get("x-ofr-task")).toBe("coding");
    const b = await s.call("/v1/chat/completions", { json: { model: "auto:task", messages: [sys, first, { role: "assistant", content: "ok" }, { role: "user", content: "thanks, what about the weather?" }] } });
    expect(b.headers.get("x-ofr-task-reason")).toBe("sticky");
    const c = await s.call("/v1/chat/completions", { json: { model: "auto:task", messages: [sys, first, { role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }] } });
    expect(c.headers.get("x-ofr-task")).toBe("vision");
  });

  test("embedder unavailable → general, never blocks", async () => {
    const f = mockFetch((url) => (url.includes("/models") || url.includes("/embeddings") ? new Response("down", { status: 502 }) : okChat(url)));
    const s = stack({ fetch: f });
    const res = await s.call("/v1/chat/completions", { json: { model: "auto:task", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "tell me about the history of tea in detail please" }] } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ofr-task")).toBe("general");
    expect(res.headers.get("x-ofr-task-reason")).toBe("embedder-unavailable");
  });

  test("admin classify test box returns scores", async () => {
    const s = stack();
    const d: any = await (await s.admin("/admin/classify", { json: { text: "Prove that the square root of two is irrational using a step by step logical argument, and then estimate the probability that a random fraction chosen from a fixed range is in lowest terms, showing the reasoning for each step clearly" } })).json();
    expect(d.task).toBe("reasoning");
    expect(d.scores.reasoning).toBeGreaterThan(d.scores.coding);
  });
});

describe("load balancing", () => {
  test("latency strategy reorders within a tier, never across tiers", () => {
    const b = new Balancer(() => 0.5);
    const route = { name: "r", description: "", targets: [], strategy: "latency" as const };
    b.record("slow", true, 2000);
    b.record("quick", true, 100);
    b.record("local", true, 5);
    const order = b.order(route, [
      { label: "slow", local: false, quotaUsed: 0 },
      { label: "quick", local: false, quotaUsed: 0 },
      { label: "local", local: true, quotaUsed: 0 },
    ]);
    expect(order.map((t) => t.label)).toEqual(["quick", "slow", "local"]);
  });
  test("errors and quota pressure push a target down; ordered strategy keeps written order", () => {
    const b = new Balancer(() => 0.5);
    for (let i = 0; i < 5; i++) b.record("flaky", false);
    b.record("flaky", true, 100);
    b.record("steady", true, 150);
    const views = [{ label: "flaky", local: false, quotaUsed: 0 }, { label: "steady", local: false, quotaUsed: 0 }];
    expect(b.order({ name: "r", description: "", targets: [], strategy: "latency" }, views)[0]!.label).toBe("steady");
    expect(b.order({ name: "r", description: "", targets: [] }, views)[0]!.label).toBe("flaky");
    const busy = [{ label: "a", local: false, quotaUsed: 0.95 }, { label: "b", local: false, quotaUsed: 0 }];
    b.record("a", true, 100);
    b.record("b", true, 150);
    expect(b.order({ name: "r", description: "", targets: [], strategy: "latency" }, busy)[0]!.label).toBe("b");
  });
  test("balanced spreads picks across targets", () => {
    let i = 0;
    const seq = [0.1, 0.5, 0.9, 0.5];
    const b = new Balancer(() => seq[i++ % seq.length]!);
    b.record("x", true, 100);
    b.record("y", true, 100);
    const r = { name: "r", description: "", targets: [], strategy: "balanced" as const };
    const v = [{ label: "x", local: false, quotaUsed: 0 }, { label: "y", local: false, quotaUsed: 0 }];
    const firsts = new Set([b.order(r, v)[0]!.label, b.order(r, v)[0]!.label]);
    expect(firsts.size).toBe(2);
  });
});

describe("embeddings", () => {
  test("served by the local route with space header; falls back only within the route", async () => {
    const c = cfg();
    c.embeddingRoutes = [{ name: "embed", description: "", space: "nomic", targets: ["omlx/*embed", "ollama/*embed"] }];
    const s = stack({ config: c });
    const res = await s.call("/v1/embeddings", { json: { input: ["hello world", "bye"] } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ofr-embedding-space")).toBe("nomic");
    expect(res.headers.get("x-ofr-model")).toBe("nomic-embed-text");
    const j: any = await res.json();
    expect(j.data.length).toBe(2);
    expect(j.data[0].embedding).toEqual(fakeEmbed("hello world"));
    const again = await s.call("/v1/embeddings", { json: { input: ["hello world", "bye"] } });
    expect(again.headers.get("x-ofr-cache")).toBe("hit");
  });
  test("cloud embedders are skipped for local-only clients", async () => {
    const c = cfg();
    c.embeddingRoutes = [{ name: "embed", description: "", space: "gem", targets: ["gemini/text-embedding-004"] }];
    const s = stack({ config: c });
    const r: any = await (await s.admin("/admin/clients", { json: { name: "p", localOnly: true } })).json();
    const res = await s.call("/v1/embeddings", { json: { input: "x" }, headers: { authorization: `Bearer ${r.key}` } });
    expect(res.status).toBe(503);
  });
});

describe("request log", () => {
  test("records fallback trail, filters by status, and searches bodies when enabled", async () => {
    const f = mockFetch(localAware((url) => (url.includes("groq") ? new Response("x", { status: 500 }) : okChat(url))));
    const c = cfg();
    c.logging.bodies = true;
    const s = stack({ config: c, fetch: f });
    await s.call("/v1/chat/completions", { json: chatBody("find the unicorn") });
    const logs: any = await (await s.admin("/admin/logs?status=ok")).json();
    expect(logs.logs[0].attempts.map((a: any) => a.outcome)).toEqual(["failed", "ok"]);
    const hit: any = await (await s.admin("/admin/logs?q=unicorn")).json();
    expect(hit.logs.length).toBe(1);
    const detail: any = await (await s.admin(`/admin/logs/${hit.logs[0].id}`)).json();
    expect(detail.requestBody).toContain("unicorn");
    expect(detail.requestBody).not.toContain(ADMIN);
  });
  test("bodies are not stored by default", async () => {
    const s = stack();
    await s.call("/v1/chat/completions", { json: chatBody("secret prompt") });
    const logs: any = await (await s.admin("/admin/logs")).json();
    const detail: any = await (await s.admin(`/admin/logs/${logs.logs[0].id}`)).json();
    expect(detail.requestBody).toBeNull();
  });
});
