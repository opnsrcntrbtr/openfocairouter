// Core routing: resolve a requested model to an ordered chain of targets and
// fall back across providers on rate limits, outages and stale models.
// Shared by the OpenAI, Anthropic and embeddings APIs.
import { isEmbeddingModel, parseTarget, providerHas, type AppConfig, type ProviderConfig, type RouteConfig } from "./config";
import { QuotaTracker, retryAfterMs } from "./quota";
import { Balancer, type TargetView } from "./balance";
import type { SecretStore } from "./secrets";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface Target {
  providerId: string;
  model: string; // may be "*" (first chat model) or "*embed" (first embedding model)
  label: string; // as written in the route
}

export interface Attempt {
  target: string;
  outcome: "ok" | "skipped" | "failed";
  status?: number;
  reason?: string;
  ms?: number;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type Outcome =
  | {
      ok: true;
      providerId: string;
      model: string;
      key: string;
      attempts: Attempt[];
      ttfbMs: number;
      json?: any; // non-streaming body
      stream?: ReadableStream<Uint8Array>; // upstream SSE, usage-sniffed
      done: Promise<Usage | undefined>; // resolves when the response body has been fully consumed
    }
  | { ok: false; status: number; body: string; contentType: string; attempts: Attempt[]; providerId?: string };

export interface ExecOptions {
  route: string; // route name or provider/model
  localOnly?: boolean;
  allowedRoutes?: string[];
}

export interface RouterEvent {
  at: number;
  requested: string;
  served?: string;
  attempts: Attempt[];
  stream: boolean;
  ms: number;
  ok: boolean;
  client?: string;
  task?: string;
}

const MODEL_GONE = /(model|deployment).{0,60}(not found|not exist|does not exist|decommission|deprecated|not supported|unavailable|unknown|invalid model)|no endpoints found/i;
const BAD_KEY = /api[_ -]?key|unauthori[sz]ed|invalid.{0,20}(token|credential)/i;
const NO_TOOLS = /tool.{0,40}(not supported|unsupported|not available)|does not support tools|function calling is not/i;
// Providers known to accept stream_options.include_usage (others send usage anyway or reject unknown fields).
const STREAM_USAGE = new Set(["groq", "openrouter", "cerebras", "github", "nvidia"]);
const TOO_LARGE = /(context|token|length|too (large|long)|maximum|exceed)/i;

export function providerUrl(p: ProviderConfig, path: string): string {
  return p.baseUrl.replace(/\/+$/, "") + path;
}

/** Decide what to do with a non-2xx upstream response. */
export function classify(status: number, body: string): { fallback: boolean; cooldown: "backoff" | "none" | "header"; providerWide?: boolean } {
  if (status === 429) return { fallback: true, cooldown: "header" };
  if (status === 401 || status === 403) return { fallback: true, cooldown: "backoff", providerWide: true };
  if (status === 404) return { fallback: true, cooldown: "backoff" };
  if (status === 408 || status === 425 || status >= 500) return { fallback: true, cooldown: "backoff" };
  if (status === 413) return { fallback: true, cooldown: "none" };
  if (status === 400 || status === 422) {
    if (BAD_KEY.test(body)) return { fallback: true, cooldown: "backoff", providerWide: true };
    if (MODEL_GONE.test(body)) return { fallback: true, cooldown: "backoff" };
    if (NO_TOOLS.test(body)) return { fallback: true, cooldown: "none" };
    if (TOO_LARGE.test(body)) return { fallback: true, cooldown: "none" };
  }
  return { fallback: false, cooldown: "none" };
}

export class Router {
  private modelCache = new Map<string, { at: number; models: string[] }>();
  readonly balancer: Balancer;
  events: RouterEvent[] = [];

  constructor(
    private getConfig: () => AppConfig,
    readonly quota: QuotaTracker,
    private fetchImpl: FetchFn = (i, init) => fetch(i, init),
    private clock: () => number = Date.now,
    private secrets?: SecretStore,
    balancer?: Balancer,
  ) {
    this.balancer = balancer ?? new Balancer();
  }

  config(): AppConfig {
    return this.getConfig();
  }

  provider(id: string): ProviderConfig | undefined {
    return this.getConfig().providers.find((p) => p.id === id);
  }

  apiKey(p: ProviderConfig): string | undefined {
    return this.secrets?.providerKey(p.id) ?? p.apiKey;
  }

  authHeaders(p: ProviderConfig): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...(p.headers ?? {}) };
    const key = this.apiKey(p);
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  usable(p: ProviderConfig | undefined): boolean {
    return !!p && p.enabled && (p.kind === "local" || !!this.apiKey(p));
  }

  routeConfig(name: string): RouteConfig | undefined {
    return this.getConfig().routes.find((r) => r.name === name);
  }

  /** "auto" → route chain; "groq/llama..." → that one target; unknown → default route. */
  resolveTargets(requested: string | undefined): { route: RouteConfig; targets: Target[] } {
    const cfg = this.getConfig();
    const name = requested?.trim() || cfg.defaultRoute;
    let route = cfg.routes.find((r) => r.name === name);
    if (!route) {
      const t = parseTarget(name);
      route = t && this.provider(t.providerId)
        ? { name, description: "direct", targets: [name] }
        : cfg.routes.find((r) => r.name === cfg.defaultRoute) ?? { name: "empty", description: "", targets: [] };
    }
    const targets = route.targets
      .map((label) => {
        const t = parseTarget(label);
        return t ? { ...t, label } : null;
      })
      .filter((t): t is Target => !!t);
    return { route, targets };
  }

  async listModels(providerId: string, force = false): Promise<string[]> {
    const p = this.provider(providerId);
    if (!p) throw new Error(`Unknown provider ${providerId}`);
    const cached = this.modelCache.get(providerId);
    if (!force && cached && this.clock() - cached.at < 10 * 60_000) return cached.models;
    const res = await this.fetchImpl(p.modelsUrl ?? providerUrl(p, "/models"), {
      headers: this.authHeaders(p),
      signal: AbortSignal.timeout(p.kind === "local" ? 2_000 : 8_000),
    });
    if (!res.ok) throw new Error(`${p.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const arr: any[] = Array.isArray(json) ? json : json.data ?? json.models ?? [];
    let models = arr
      .map((m) => (typeof m === "string" ? m : m.id ?? m.name))
      .filter((m): m is string => typeof m === "string")
      .map((m) => m.replace(/^models\//, "")); // Gemini prefixes ids with models/
    if (p.modelFilter === "free-suffix") models = models.filter((m) => m.endsWith(":free"));
    models.sort();
    this.modelCache.set(providerId, { at: this.clock(), models });
    return models;
  }

  /** Resolve "*" (first chat model) and "*embed" (first embedding model). */
  async resolveModel(p: ProviderConfig, model: string): Promise<{ model?: string; reason?: string }> {
    if (model !== "*" && model !== "*embed") return { model };
    let models: string[];
    try {
      models = await this.listModels(p.id);
    } catch (e) {
      return { reason: p.kind === "local" ? "not running" : `not reachable: ${(e as Error).message.slice(0, 80)}` };
    }
    const want = model === "*embed";
    const pick = models.find((m) => isEmbeddingModel(p, m) === want);
    return pick ? { model: pick } : { reason: want ? "no embedding model loaded" : "no chat model loaded" };
  }

  /** Models advertised on /v1/models: routes first, then every cached provider model. */
  advertisedModels(): string[] {
    const cfg = this.getConfig();
    const out = [...cfg.routes.map((r) => r.name), "auto:task", ...cfg.embeddingRoutes.map((r) => r.name)];
    for (const p of cfg.providers) {
      if (!this.usable(p)) continue;
      for (const m of this.modelCache.get(p.id)?.models ?? []) out.push(`${p.id}/${m}`);
    }
    return out;
  }

  record(ev: RouterEvent) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.length = 200;
  }

  private quotaUsed(p: ProviderConfig, label: string): number {
    const s = this.quota.targets[label];
    if (!s || !p.limits) return 0;
    const rpm = p.limits.rpm ? s.recent.length / p.limits.rpm : 0;
    const rpd = p.limits.rpd ? s.requestsToday / p.limits.rpd : 0;
    return Math.min(1, Math.max(rpm, rpd));
  }

  /** Run a chat completion through the route chain. Body is OpenAI chat format. */
  async execute(body: any, opts: ExecOptions): Promise<Outcome> {
    const stream = !!body?.stream;
    const { route, targets } = this.resolveTargets(opts.route);
    const attempts: Attempt[] = [];

    if (opts.allowedRoutes?.length && !opts.allowedRoutes.includes(route.name)) {
      return { ok: false, status: 403, contentType: "application/json", attempts, body: JSON.stringify({ error: { message: `This client may not use route "${route.name}"`, type: "ofr_route_not_allowed" } }) };
    }

    const views: (TargetView & { t: Target })[] = targets.map((t) => {
      const p = this.provider(t.providerId);
      return { t, label: t.label, local: p?.kind === "local", quotaUsed: p ? this.quotaUsed(p, t.label) : 0 };
    });
    const ordered = this.balancer.order(route, views) as typeof views;

    for (const { t } of ordered) {
      const p = this.provider(t.providerId);
      const label = t.label;
      if (!p || !this.usable(p)) {
        attempts.push({ target: label, outcome: "skipped", reason: !p ? "unknown provider" : !p.enabled ? "disabled" : "no API key" });
        continue;
      }
      if (opts.localOnly && p.kind !== "local") {
        attempts.push({ target: label, outcome: "skipped", reason: "client is local-only" });
        continue;
      }
      if (!providerHas(p, "chat")) {
        attempts.push({ target: label, outcome: "skipped", reason: "provider has no chat capability" });
        continue;
      }
      const r = await this.resolveModel(p, t.model);
      if (!r.model) {
        attempts.push({ target: label, outcome: "skipped", reason: r.reason });
        continue;
      }
      const model = r.model;
      const key = `${p.id}/${model}`;
      const limits = p.modelLimits?.[model] ?? p.limits;
      const gate = this.quota.check(p.id, key, limits);
      if (!gate.ok) {
        attempts.push({ target: key, outcome: "skipped", reason: gate.reason });
        continue;
      }

      this.quota.recordAttempt(key);
      const t0 = this.clock();
      const upstreamBody = { ...body, model };
      if (stream && STREAM_USAGE.has(p.id) && upstreamBody.stream_options === undefined) upstreamBody.stream_options = { include_usage: true };
      let res: Response;
      try {
        res = await this.fetchImpl(providerUrl(p, "/chat/completions"), {
          method: "POST",
          headers: this.authHeaders(p),
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(this.getConfig().requestTimeoutMs),
        });
      } catch (e) {
        const msg = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message;
        this.quota.recordFailure(key, 0, msg, p.kind === "local" ? 15_000 : "backoff");
        this.balancer.record(label, false);
        attempts.push({ target: key, outcome: "failed", reason: msg, ms: this.clock() - t0 });
        continue;
      }
      this.quota.recordHeaders(key, res.headers);
      const ttfbMs = this.clock() - t0;

      if (res.ok) {
        attempts.push({ target: key, outcome: "ok", status: res.status, ms: ttfbMs });
        this.balancer.record(label, true, ttfbMs);
        if (stream && res.body) {
          this.quota.recordSuccess(key, ttfbMs);
          let resolveDone!: (u: Usage | undefined) => void;
          const done = new Promise<Usage | undefined>((r) => (resolveDone = r));
          const s = res.body.pipeThrough(
            usageSniffer((u) => this.quota.recordTokens(key, u), resolveDone),
          );
          return { ok: true, providerId: p.id, model, key, attempts, ttfbMs, stream: s, done };
        }
        const json: any = await res.json().catch(() => null);
        if (!json) {
          this.quota.recordFailure(key, 502, "invalid JSON from provider", "backoff");
          attempts[attempts.length - 1] = { target: key, outcome: "failed", status: 502, reason: "invalid JSON", ms: ttfbMs };
          continue;
        }
        this.quota.recordSuccess(key, ttfbMs, json?.usage);
        return { ok: true, providerId: p.id, model, key, attempts, ttfbMs, json, done: Promise.resolve(json?.usage) };
      }

      const text = await res.text();
      const c = classify(res.status, text);
      const cooldown = c.cooldown === "header" ? retryAfterMs(res.headers, this.clock()) ?? "backoff" : c.cooldown;
      this.quota.recordFailure(key, res.status, text, cooldown);
      this.balancer.record(label, false);
      if (c.providerWide) this.quota.coolProvider(p.id, 10 * 60_000, `HTTP ${res.status}: check the API key`);
      attempts.push({ target: key, outcome: "failed", status: res.status, reason: text.slice(0, 160), ms: this.clock() - t0 });
      if (!c.fallback) {
        return { ok: false, status: res.status, body: text, contentType: res.headers.get("content-type") ?? "application/json", attempts, providerId: p.id };
      }
    }

    return {
      ok: false,
      status: 503,
      contentType: "application/json",
      attempts,
      body: JSON.stringify({
        error: {
          message: `No free provider could serve "${opts.route}" right now. All targets were rate-limited, failing, or not configured.`,
          type: "ofr_all_targets_exhausted",
          attempts,
        },
      }),
    };
  }

  /** Embeddings through an embedding route; fallback stays inside the route's vector space. */
  async embed(body: any, opts: { localOnly?: boolean } = {}): Promise<Outcome & { space?: string }> {
    const cfg = this.getConfig();
    const requested = String(body?.model ?? cfg.defaultEmbeddingRoute);
    let route = cfg.embeddingRoutes.find((r) => r.name === requested);
    if (!route) {
      const t = parseTarget(requested);
      route = t && this.provider(t.providerId)
        ? { name: requested, description: "direct", space: requested, targets: [requested] }
        : cfg.embeddingRoutes.find((r) => r.name === cfg.defaultEmbeddingRoute);
    }
    const attempts: Attempt[] = [];
    for (const label of route?.targets ?? []) {
      const pt = parseTarget(label);
      const p = pt && this.provider(pt.providerId);
      if (!pt || !p || !this.usable(p)) {
        attempts.push({ target: label, outcome: "skipped", reason: !p ? "unknown provider" : !p.enabled ? "disabled" : "no API key" });
        continue;
      }
      if (opts.localOnly && p.kind !== "local") {
        attempts.push({ target: label, outcome: "skipped", reason: "client is local-only" });
        continue;
      }
      if (!providerHas(p, "embeddings")) {
        attempts.push({ target: label, outcome: "skipped", reason: "provider has no embeddings capability" });
        continue;
      }
      const r = await this.resolveModel(p, pt.model === "*" ? "*embed" : pt.model);
      if (!r.model) {
        attempts.push({ target: label, outcome: "skipped", reason: r.reason });
        continue;
      }
      const key = `${p.id}/${r.model}`;
      const gate = this.quota.check(p.id, key, p.modelLimits?.[r.model] ?? p.limits);
      if (!gate.ok) {
        attempts.push({ target: key, outcome: "skipped", reason: gate.reason });
        continue;
      }
      this.quota.recordAttempt(key);
      const t0 = this.clock();
      try {
        const res = await this.fetchImpl(providerUrl(p, "/embeddings"), {
          method: "POST",
          headers: this.authHeaders(p),
          body: JSON.stringify({ ...body, model: r.model }),
          signal: AbortSignal.timeout(this.getConfig().requestTimeoutMs),
        });
        this.quota.recordHeaders(key, res.headers);
        const ms = this.clock() - t0;
        if (res.ok) {
          const json: any = await res.json();
          this.quota.recordSuccess(key, ms, json?.usage);
          attempts.push({ target: key, outcome: "ok", status: 200, ms });
          return { ok: true, providerId: p.id, model: r.model, key, attempts, ttfbMs: ms, json, done: Promise.resolve(json?.usage), space: route!.space };
        }
        const text = await res.text();
        const c = classify(res.status, text);
        this.quota.recordFailure(key, res.status, text, c.cooldown === "header" ? retryAfterMs(res.headers) ?? "backoff" : c.cooldown);
        if (c.providerWide) this.quota.coolProvider(p.id, 10 * 60_000, `HTTP ${res.status}: check the API key`);
        attempts.push({ target: key, outcome: "failed", status: res.status, reason: text.slice(0, 160), ms });
        if (!c.fallback) return { ok: false, status: res.status, body: text, contentType: "application/json", attempts };
      } catch (e) {
        this.quota.recordFailure(key, 0, (e as Error).message, p.kind === "local" ? 15_000 : "backoff");
        attempts.push({ target: key, outcome: "failed", reason: (e as Error).message, ms: this.clock() - t0 });
      }
    }
    return {
      ok: false,
      status: 503,
      contentType: "application/json",
      attempts,
      body: JSON.stringify({ error: { message: `No embedding provider could serve "${requested}" right now.`, type: "ofr_all_targets_exhausted", attempts } }),
    };
  }
}

/** Pass SSE through untouched while picking the usage object out of the final chunk. */
export function usageSniffer(onUsage: (u: Usage) => void, onDone?: (u: Usage | undefined) => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  let usage: Usage | undefined;
  const scan = (line: string) => {
    if (usage || !line.startsWith("data:") || !line.includes('"usage"')) return;
    try {
      const u = JSON.parse(line.slice(5).trim())?.usage;
      if (u && (u.total_tokens || u.prompt_tokens || u.completion_tokens)) {
        usage = u;
        onUsage(u);
      }
    } catch {
      /* partial or non-JSON line */
    }
  };
  return new TransformStream({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      if (usage) return;
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) scan(line);
    },
    flush() {
      if (buf) scan(buf);
      onDone?.(usage);
    },
  });
}
