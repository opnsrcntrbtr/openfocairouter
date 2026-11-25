// Core routing: resolve a requested model to an ordered chain of targets and
// fall back across providers on rate limits, outages and stale models.
import { parseTarget, type AppConfig, type ProviderConfig } from "./config";
import { QuotaTracker, retryAfterMs } from "./quota";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface Target {
  providerId: string;
  model: string; // may be "*"
}

export interface Attempt {
  target: string;
  outcome: "ok" | "skipped" | "failed";
  status?: number;
  reason?: string;
  ms?: number;
}

export interface RouterEvent {
  at: number;
  requested: string;
  served?: string;
  attempts: Attempt[];
  stream: boolean;
  ms: number;
  ok: boolean;
}

const MODEL_GONE = /(model|deployment).{0,60}(not found|not exist|does not exist|decommission|deprecated|not supported|unavailable|unknown|invalid model)|no endpoints found/i;
const BAD_KEY = /api[_ -]?key|unauthori[sz]ed|invalid.{0,20}(token|credential)/i;
// Providers known to accept stream_options.include_usage (others send usage anyway or reject unknown fields).
const STREAM_USAGE = new Set(["groq", "openrouter", "cerebras", "github", "nvidia"]);
const TOO_LARGE = /(context|token|length|too (large|long)|maximum|exceed)/i;

export function providerUrl(p: ProviderConfig, path: string): string {
  return p.baseUrl.replace(/\/+$/, "") + path;
}

export function authHeaders(p: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...(p.headers ?? {}) };
  if (p.apiKey) h.authorization = `Bearer ${p.apiKey}`;
  return h;
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
    if (TOO_LARGE.test(body)) return { fallback: true, cooldown: "none" };
  }
  return { fallback: false, cooldown: "none" };
}

export class Router {
  private modelCache = new Map<string, { at: number; models: string[] }>();
  events: RouterEvent[] = [];

  constructor(
    private getConfig: () => AppConfig,
    readonly quota: QuotaTracker,
    private fetchImpl: FetchFn = (i, init) => fetch(i, init),
    private clock: () => number = Date.now,
  ) {}

  provider(id: string): ProviderConfig | undefined {
    return this.getConfig().providers.find((p) => p.id === id);
  }

  /** "auto" → route chain; "groq/llama..." → that one target; unknown → default route. */
  resolveTargets(requested: string | undefined): Target[] {
    const cfg = this.getConfig();
    const name = requested?.trim() || cfg.defaultRoute;
    const route = cfg.routes.find((r) => r.name === name);
    const raw = route ? route.targets : parseTarget(name) && this.provider(parseTarget(name)!.providerId) ? [name] : null;
    const list = raw ?? cfg.routes.find((r) => r.name === cfg.defaultRoute)?.targets ?? [];
    return list.map(parseTarget).filter((t): t is Target => !!t);
  }

  private usable(p: ProviderConfig | undefined): boolean {
    return !!p && p.enabled && (p.kind === "local" || !!p.apiKey);
  }

  async listModels(providerId: string, force = false): Promise<string[]> {
    const p = this.provider(providerId);
    if (!p) throw new Error(`Unknown provider ${providerId}`);
    const cached = this.modelCache.get(providerId);
    if (!force && cached && this.clock() - cached.at < 10 * 60_000) return cached.models;
    const res = await this.fetchImpl(p.modelsUrl ?? providerUrl(p, "/models"), {
      headers: authHeaders(p),
      signal: AbortSignal.timeout(8_000),
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

  /** Models advertised on /v1/models: routes first, then every cached provider model. */
  advertisedModels(): string[] {
    const cfg = this.getConfig();
    const out = cfg.routes.map((r) => r.name);
    for (const p of cfg.providers) {
      if (!this.usable(p)) continue;
      for (const m of this.modelCache.get(p.id)?.models ?? []) out.push(`${p.id}/${m}`);
    }
    return out;
  }

  private record(ev: RouterEvent) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.length = 200;
  }

  /** Handle POST /v1/chat/completions. */
  async chat(body: any): Promise<Response> {
    const started = this.clock();
    const requested = String(body?.model ?? this.getConfig().defaultRoute);
    const stream = !!body?.stream;
    const targets = this.resolveTargets(requested);
    const attempts: Attempt[] = [];
    let lastClientError: Response | undefined;

    for (const t of targets) {
      const p = this.provider(t.providerId);
      const label = `${t.providerId}/${t.model}`;
      if (!p || !this.usable(p)) {
        attempts.push({ target: label, outcome: "skipped", reason: !p ? "unknown provider" : !p.enabled ? "disabled" : "no API key" });
        continue;
      }
      let model = t.model;
      if (model === "*") {
        try {
          model = (await this.listModels(p.id))[0] ?? "";
        } catch (e) {
          attempts.push({ target: label, outcome: "skipped", reason: `not reachable: ${(e as Error).message.slice(0, 80)}` });
          continue;
        }
        if (!model) {
          attempts.push({ target: label, outcome: "skipped", reason: "no models installed" });
          continue;
        }
      }
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
      if (stream && STREAM_USAGE.has(p.id) && upstreamBody.stream_options === undefined) {
        upstreamBody.stream_options = { include_usage: true };
      }
      let res: Response;
      try {
        res = await this.fetchImpl(providerUrl(p, "/chat/completions"), {
          method: "POST",
          headers: authHeaders(p),
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(this.getConfig().requestTimeoutMs),
        });
      } catch (e) {
        const msg = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message;
        this.quota.recordFailure(key, 0, msg, p.kind === "local" ? 15_000 : "backoff");
        attempts.push({ target: key, outcome: "failed", reason: msg, ms: this.clock() - t0 });
        continue;
      }
      this.quota.recordHeaders(key, res.headers);

      if (res.ok) {
        const ms = this.clock() - t0;
        attempts.push({ target: key, outcome: "ok", status: res.status, ms });
        const headers = new Headers({
          "x-ofr-provider": p.id,
          "x-ofr-model": model,
          "x-ofr-attempts": String(attempts.length),
          "access-control-expose-headers": "x-ofr-provider, x-ofr-model, x-ofr-attempts",
        });
        this.record({ at: started, requested, served: key, attempts, stream, ms: this.clock() - started, ok: true });
        if (stream && res.body) {
          this.quota.recordSuccess(key, ms);
          headers.set("content-type", res.headers.get("content-type") ?? "text/event-stream");
          headers.set("cache-control", "no-cache");
          return new Response(res.body.pipeThrough(usageSniffer((u) => this.quota.recordTokens(key, u))), { status: 200, headers });
        }
        const json: any = await res.json();
        this.quota.recordSuccess(key, ms, json?.usage);
        if (json && typeof json === "object") json.model = key;
        headers.set("content-type", "application/json");
        return new Response(JSON.stringify(json), { status: 200, headers });
      }

      const text = await res.text();
      const c = classify(res.status, text);
      const cooldown = c.cooldown === "header" ? retryAfterMs(res.headers, this.clock()) ?? "backoff" : c.cooldown;
      this.quota.recordFailure(key, res.status, text, cooldown);
      if (c.providerWide) this.quota.coolProvider(p.id, 10 * 60_000, `HTTP ${res.status}: check the API key`);
      attempts.push({ target: key, outcome: "failed", status: res.status, reason: text.slice(0, 160), ms: this.clock() - t0 });
      if (!c.fallback) {
        lastClientError = new Response(text, {
          status: res.status,
          headers: { "content-type": res.headers.get("content-type") ?? "application/json", "x-ofr-provider": p.id },
        });
        break; // the request itself is bad; another provider will reject it too
      }
    }

    this.record({ at: started, requested, attempts, stream, ms: this.clock() - started, ok: false });
    if (lastClientError) return lastClientError;
    return new Response(
      JSON.stringify({
        error: {
          message: `No free provider could serve "${requested}" right now. All targets were rate-limited, failing, or not configured.`,
          type: "ofr_all_targets_exhausted",
          attempts,
        },
      }),
      { status: 503, headers: { "content-type": "application/json", "retry-after": "30" } },
    );
  }
}

/** Pass SSE through untouched while picking the usage object out of the final chunk. */
export function usageSniffer(onUsage: (u: any) => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  let seen = false;
  return new TransformStream({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      if (seen) return;
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
        try {
          const u = JSON.parse(line.slice(5).trim())?.usage;
          if (u && (u.total_tokens || u.prompt_tokens || u.completion_tokens)) {
            onUsage(u);
            seen = true;
            return;
          }
        } catch {
          /* partial or non-JSON line */
        }
      }
    },
  });
}
