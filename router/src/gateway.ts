// The request pipeline shared by /v1/chat/completions, /v1/messages and /v1/embeddings:
// identify client → limits → translate → cache → classify → route/fallback → log.
import type { AppConfig } from "./config";
import { identify, ClientLimiter, type ClientIdentity } from "./clients";
import { anthropicError, anthropicRoute, fromOpenAI, toAnthropicStream, toOpenAI } from "./anthropic";
import { cacheable, replayAsSSE, type ResponseCache, type CacheHit } from "./cache";
import type { Classifier, TaskDecision } from "./classify";
import type { Store, LogRow } from "./db";
import type { Router, Usage } from "./router";

type Api = "openai" | "anthropic";

export interface GatewayDeps {
  router: Router;
  classifier: Classifier;
  cache: ResponseCache;
  store: Store;
  limiter: ClientLimiter;
  getConfig: () => AppConfig;
  adminToken: string;
  clock?: () => number;
}

function errorFor(api: Api, status: number, message: string, type: string, extra: Record<string, string> = {}): Response {
  if (api === "anthropic") {
    const r = anthropicError(status, message);
    for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
    return r;
  }
  return new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "content-type": "application/json", ...extra } });
}

/** Wrap a stream so we learn when it ends (normally or because the client hung up). */
export function tapStream(stream: ReadableStream<Uint8Array>, onChunk: (c: Uint8Array) => void, onEnd: (cancelled: boolean) => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let ended = false;
  const finish = (cancelled: boolean) => {
    if (ended) return;
    ended = true;
    onEnd(cancelled);
  };
  return new ReadableStream({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(false);
          ctl.close();
          return;
        }
        onChunk(value);
        ctl.enqueue(value);
      } catch (e) {
        finish(true);
        ctl.error(e);
      }
    },
    cancel(reason) {
      finish(true);
      return reader.cancel(reason);
    },
  });
}

/** Rebuild a chat completion JSON from OpenAI SSE chunks (for caching streamed responses). */
export class SSEAccumulator {
  private dec = new TextDecoder();
  private buf = "";
  text = "";
  finish: string | null = null;
  usage: Usage | undefined;
  tools = new Map<number, { id?: string; name: string; args: string }>();

  push(chunk: Uint8Array) {
    this.buf += this.dec.decode(chunk, { stream: true });
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) this.line(line.trim());
  }

  private line(l: string) {
    if (!l.startsWith("data:")) return;
    const d = l.slice(5).trim();
    if (d === "[DONE]") return;
    try {
      const c = JSON.parse(d);
      if (c.usage) this.usage = c.usage;
      const ch = c.choices?.[0];
      if (!ch) return;
      if (typeof ch.delta?.content === "string") this.text += ch.delta.content;
      for (const tc of ch.delta?.tool_calls ?? []) {
        const t = this.tools.get(tc.index ?? 0) ?? { name: "", args: "" };
        if (tc.id) t.id = tc.id;
        if (tc.function?.name) t.name += tc.function.name;
        if (tc.function?.arguments) t.args += tc.function.arguments;
        this.tools.set(tc.index ?? 0, t);
      }
      if (ch.finish_reason) this.finish = ch.finish_reason;
    } catch {
      /* partial */
    }
  }

  toJSON(model: string): any {
    const tool_calls = [...this.tools.values()].map((t, i) => ({ id: t.id ?? `call_${i}`, type: "function", function: { name: t.name, arguments: t.args } }));
    return {
      id: "chatcmpl-cache",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: this.text || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: this.finish ?? "stop" }],
      usage: this.usage,
    };
  }
}

export class Gateway {
  private clock: () => number;

  constructor(private d: GatewayDeps) {
    this.clock = d.clock ?? Date.now;
  }

  private log(row: LogRow) {
    const cfg = this.d.getConfig();
    this.d.store.log(row, cfg.logging.bodies);
    this.d.router.record({
      at: row.ts, requested: row.requested, served: row.served ?? undefined, attempts: row.attempts, stream: row.stream,
      ms: row.ms, ok: row.status < 400, client: row.client, task: row.task ?? undefined,
    });
  }

  private identifyOr(req: Request, api: Api): ClientIdentity | Response {
    const cfg = this.d.getConfig();
    const who = identify(req, cfg, this.d.adminToken);
    if (!who) return errorFor(api, 401, "A valid OpenFOC client key is required (Settings → Clients). Send it as a Bearer token or x-api-key.", "authentication_error");
    const wait = this.d.limiter.take(who.client);
    if (wait > 0) {
      return errorFor(api, 429, `Client "${who.name}" reached its OpenFOC limit. Try again in ${Math.ceil(wait / 1000)}s.`, "ofr_client_limit", { "retry-after": String(Math.ceil(wait / 1000)) });
    }
    return who;
  }

  /** Decide the route, classifying the task when asked to. */
  private async chooseRoute(req: Request, body: any, requested: string, who: ClientIdentity): Promise<{ route: string; task?: TaskDecision }> {
    const cfg = this.d.getConfig();
    let override = req.headers.get("x-ofr-task")?.trim() || undefined;
    if (requested.startsWith("auto:") && requested !== "auto:task") override ??= requested.slice(5);
    const wantTask = !!override || requested === "auto:task" || (requested === "auto" && cfg.taskRouting.enabled);
    if (!wantTask) return { route: requested };
    const task = await this.d.classifier.classify(body, { clientId: who.id, override });
    return { route: task.route, task };
  }

  async chat(req: Request, original: any, api: Api): Promise<Response> {
    const t0 = this.clock();
    const cfg = this.d.getConfig();
    const who = this.identifyOr(req, api);
    if (who instanceof Response) return who;

    let body: any;
    try {
      body = api === "anthropic" ? toOpenAI(original) : original;
    } catch (e) {
      return errorFor(api, 400, `Could not translate request: ${(e as Error).message}`, "invalid_request_error");
    }
    if (!Array.isArray(body?.messages) || !body.messages.length) return errorFor(api, 400, "`messages` must be a non-empty array", "invalid_request_error");
    const displayModel = String(original?.model ?? cfg.defaultRoute);
    const requested = api === "anthropic" ? anthropicRoute(original?.model, cfg) : displayModel;
    const { route, task } = await this.chooseRoute(req, body, requested, who);
    const stream = !!body.stream;

    const headers = new Headers({ "x-ofr-client": who.id, "access-control-expose-headers": "x-ofr-provider, x-ofr-model, x-ofr-attempts, x-ofr-task, x-ofr-cache, x-ofr-client" });
    if (task) {
      headers.set("x-ofr-task", task.task);
      headers.set("x-ofr-task-reason", task.reason);
      if (task.score !== undefined) headers.set("x-ofr-task-score", String(task.score));
    }
    const baseLog = {
      ts: t0, client: who.id, api, requested: displayModel, task: task?.task ?? null, taskScore: task?.score ?? null,
      taskReason: task?.reason ?? null, stream, requestBody: JSON.stringify(original),
    };

    // ---- cache ----
    const noCache = /no-cache|no-store/i.test(req.headers.get("cache-control") ?? "");
    const force = req.headers.get("x-ofr-cache")?.toLowerCase() === "force";
    const cacheOn = cfg.cache.exact && who.client?.cache !== false && !noCache && cacheable(body, cfg.cache, force);
    const semanticOn = cacheOn && cfg.cache.semantic && !!who.client?.semanticCache;
    if (cacheOn) {
      let hit: CacheHit | undefined = this.d.cache.get("chat", who.id, route, body);
      if (!hit && semanticOn) hit = await this.d.cache.getSemantic(who.id, route, body);
      if (hit) {
        headers.set("x-ofr-cache", hit.kind);
        headers.set("x-ofr-model", hit.served);
        headers.set("x-ofr-provider", hit.served.split("/")[0] ?? "");
        headers.set("x-ofr-attempts", "0");
        this.log({ ...baseLog, served: hit.served, attempts: [], status: 200, cache: hit.kind, ttfbMs: 0, ms: this.clock() - t0, responseBody: JSON.stringify(hit.body) });
        return this.respond(api, hit.body, stream ? replayAsSSE(hit.body) : undefined, displayModel, headers);
      }
    }
    headers.set("x-ofr-cache", cacheOn ? "miss" : "bypass");

    // ---- route + fallback ----
    const out = await this.d.router.execute(body, { route, localOnly: who.client?.localOnly, allowedRoutes: who.client?.allowedRoutes });
    headers.set("x-ofr-attempts", String(out.attempts.length));
    if (!out.ok) {
      let message = out.body;
      try {
        message = JSON.parse(out.body)?.error?.message ?? out.body;
      } catch {
        /* not JSON */
      }
      this.log({ ...baseLog, served: null, attempts: out.attempts, status: out.status, ms: this.clock() - t0, error: String(message).slice(0, 500) });
      if (api === "anthropic") {
        const r = anthropicError(out.status, String(message));
        headers.forEach((v, k) => r.headers.set(k, v));
        return r;
      }
      headers.set("content-type", out.contentType);
      if (out.status === 503) headers.set("retry-after", "30");
      return new Response(out.body, { status: out.status, headers });
    }

    headers.set("x-ofr-provider", out.providerId);
    headers.set("x-ofr-model", out.model);
    const served = out.key;

    if (out.json) {
      out.json.model = served;
      const u = out.json.usage as Usage | undefined;
      this.d.limiter.addTokens(who.id, (u?.total_tokens ?? 0) || (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0));
      if (cacheOn) {
        this.d.cache.put("chat", who.id, route, body, served, out.json);
        if (semanticOn) this.d.cache.putSemantic(who.id, route, body, served, out.json).catch(() => {});
      }
      this.log({ ...baseLog, served, attempts: out.attempts, status: 200, cache: cacheOn ? "miss" : null, ttfbMs: out.ttfbMs, ms: this.clock() - t0,
        promptTokens: u?.prompt_tokens ?? null, completionTokens: u?.completion_tokens ?? null, responseBody: JSON.stringify(out.json) });
      return this.respond(api, out.json, undefined, displayModel, headers);
    }

    // streaming
    const acc = new SSEAccumulator();
    const tapped = tapStream(out.stream!, (c) => acc.push(c), (cancelled) => {
      const u = acc.usage;
      this.d.limiter.addTokens(who.id, (u?.total_tokens ?? 0) || (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0));
      const full = acc.toJSON(served);
      if (cacheOn && !cancelled && (acc.text || acc.tools.size)) {
        this.d.cache.put("chat", who.id, route, body, served, full);
        if (semanticOn) this.d.cache.putSemantic(who.id, route, body, served, full).catch(() => {});
      }
      this.log({ ...baseLog, served, attempts: out.attempts, status: cancelled ? 499 : 200, cache: cacheOn ? "miss" : null, ttfbMs: out.ttfbMs,
        ms: this.clock() - t0, promptTokens: u?.prompt_tokens ?? null, completionTokens: u?.completion_tokens ?? null,
        error: cancelled ? "client closed the stream" : null, responseBody: acc.text || JSON.stringify(full.choices[0].message) });
    });
    return this.respond(api, undefined, tapped, displayModel, headers);
  }

  private respond(api: Api, json: any, stream: ReadableStream<Uint8Array> | undefined, displayModel: string, headers: Headers): Response {
    if (stream) {
      headers.set("content-type", "text/event-stream");
      headers.set("cache-control", "no-cache");
      const s = api === "anthropic" ? stream.pipeThrough(toAnthropicStream(displayModel)) : stream;
      return new Response(s, { status: 200, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(api === "anthropic" ? fromOpenAI(json, displayModel) : json), { status: 200, headers });
  }

  async embeddings(req: Request, body: any): Promise<Response> {
    const t0 = this.clock();
    const cfg = this.d.getConfig();
    const who = this.identifyOr(req, "openai");
    if (who instanceof Response) return who;
    if (body?.input === undefined) return errorFor("openai", 400, "`input` is required", "invalid_request_error");
    const requested = String(body.model ?? cfg.defaultEmbeddingRoute);
    const headers = new Headers({ "content-type": "application/json", "x-ofr-client": who.id });
    const cacheOn = cfg.cache.exact && who.client?.cache !== false;
    const baseLog = { ts: t0, client: who.id, api: "embeddings" as const, requested, stream: false, requestBody: null };
    if (cacheOn) {
      const hit = this.d.cache.get("emb", who.id, requested, body);
      if (hit) {
        headers.set("x-ofr-cache", "hit");
        headers.set("x-ofr-model", hit.served);
        if (hit.body?.ofr_space) headers.set("x-ofr-embedding-space", hit.body.ofr_space);
        this.log({ ...baseLog, served: hit.served, attempts: [], status: 200, cache: "hit", ms: this.clock() - t0 });
        return new Response(JSON.stringify(hit.body), { status: 200, headers });
      }
    }
    const out = await this.d.router.embed(body, { localOnly: who.client?.localOnly });
    if (!out.ok) {
      this.log({ ...baseLog, served: null, attempts: out.attempts, status: out.status, ms: this.clock() - t0, error: out.body.slice(0, 500) });
      return new Response(out.body, { status: out.status, headers });
    }
    out.json.model = out.key;
    if (out.space) {
      out.json.ofr_space = out.space;
      headers.set("x-ofr-embedding-space", out.space);
    }
    headers.set("x-ofr-provider", out.providerId);
    headers.set("x-ofr-model", out.model);
    headers.set("x-ofr-cache", cacheOn ? "miss" : "bypass");
    if (cacheOn) this.d.cache.put("emb", who.id, requested, body, out.key, out.json);
    this.log({ ...baseLog, served: out.key, attempts: out.attempts, status: 200, cache: cacheOn ? "miss" : null, ttfbMs: out.ttfbMs, ms: this.clock() - t0,
      promptTokens: out.json?.usage?.prompt_tokens ?? null });
    return new Response(JSON.stringify(out.json), { status: 200, headers });
  }
}
