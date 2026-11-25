// HTTP layer: OpenAI- and Anthropic-compatible /v1 API + token-protected /admin API for the desktop UI.
import { redactConfig, applyUpdate, type AppConfig, type ClientConfig } from "./config";
import { createClient, hashKey, identify, newClientKey } from "./clients";
import { countTokens } from "./anthropic";
import { isFallback, type Router } from "./router";
import type { Gateway } from "./gateway";
import type { Classifier } from "./classify";
import type { ResponseCache } from "./cache";
import type { Store } from "./db";
import type { SecretStore } from "./secrets";

export interface ServerDeps {
  router: Router;
  gateway: Gateway;
  classifier: Classifier;
  cache: ResponseCache;
  store: Store;
  secrets: SecretStore;
  getConfig: () => AppConfig;
  saveConfig: (cfg: AppConfig) => void;
  adminToken: string;
  version: string;
}

// Browser pages may not call the router; only the app's own webview (and Vite in dev).
const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"]);

function cors(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, x-api-key, x-ofr-task, x-ofr-client, x-ofr-cache, anthropic-version",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-expose-headers": "x-ofr-provider, x-ofr-model, x-ofr-attempts, x-ofr-task, x-ofr-cache, x-ofr-client",
    vary: "origin",
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
}

function oaiError(message: string, status: number, type = "invalid_request_error") {
  return json({ error: { message, type } }, status);
}

function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ACCOUNT_RE = /^(provider|client):[\w.-]{1,64}$/;

export function createHandler(deps: ServerDeps) {
  const { router, gateway, classifier, cache, store, secrets, getConfig, saveConfig, adminToken, version } = deps;

  async function readJson(req: Request): Promise<any> {
    try {
      return await req.json();
    } catch {
      return undefined;
    }
  }

  function clientsView() {
    const cfg = getConfig();
    const stats = store.clientStats(30);
    const lat = store.clientLatency(7);
    const ids = new Set([...cfg.clients.map((c) => c.id), ...stats.map((s) => s.client)]);
    return [...ids].map((id) => {
      const c = cfg.clients.find((x) => x.id === id);
      const days = stats.filter((s) => s.client === id);
      const sum = days.reduce(
        (a, s) => ({ requests: a.requests + s.requests, promptTokens: a.promptTokens + s.promptTokens, completionTokens: a.completionTokens + s.completionTokens, errors: a.errors + s.errors, fallbacks: a.fallbacks + s.fallbacks, cacheHits: a.cacheHits + s.cacheHits }),
        { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, fallbacks: 0, cacheHits: 0 },
      );
      const { keyHash: _h, ...safe } = c ?? ({} as ClientConfig);
      return {
        id,
        name: c?.name ?? id.replace(/^(ua|hdr):/, ""),
        kind: c ? "key" : id.startsWith("ua:") ? "user-agent" : id.startsWith("hdr:") ? "header" : id === "app" ? "app" : "anonymous",
        config: c ? safe : undefined,
        totals30d: sum,
        latency7d: lat[id],
        days: days.map(({ client: _c, ...d }) => d),
      };
    });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = req.headers.get("origin");

    if (origin && !ALLOWED_ORIGINS.has(origin)) return oaiError("Origin not allowed", 403, "forbidden");
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    if (path === "/" || path === "/health") return json({ ok: true, name: "openfocairouter", version, secretsReady: !secrets.managed || secretsReadyFlag.ready });

    // ---------- Public APIs ----------
    if (path.startsWith("/v1")) {
      // In the desktop app, give the shell a moment to deliver Keychain secrets after launch.
      for (let i = 0; secrets.managed && !secretsReadyFlag.ready && i < 40; i++) await Bun.sleep(50);
      if (path === "/v1/models" && req.method === "GET") {
        if (!identify(req, getConfig(), adminToken)) return oaiError("A valid OpenFOC client key is required.", 401, "authentication_error");
        const created = Math.floor(Date.now() / 1000);
        return json({ object: "list", data: router.advertisedModels().map((id) => ({ id, object: "model", created, owned_by: "openfocairouter" })) });
      }
      if (path === "/v1/chat/completions" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return oaiError("Request body must be JSON", 400);
        return gateway.chat(req, body, "openai");
      }
      if (path === "/v1/messages" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return json({ type: "error", error: { type: "invalid_request_error", message: "Request body must be JSON" } }, 400);
        return gateway.chat(req, body, "anthropic");
      }
      if (path === "/v1/messages/count_tokens" && req.method === "POST") {
        if (!identify(req, getConfig(), adminToken)) return json({ type: "error", error: { type: "authentication_error", message: "client key required" } }, 401);
        const body = await readJson(req);
        return json({ input_tokens: countTokens(body ?? {}) });
      }
      if (path === "/v1/embeddings" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return oaiError("Request body must be JSON", 400);
        return gateway.embeddings(req, body);
      }
      return oaiError(`Not supported: ${req.method} ${path}. Supported: GET /v1/models, POST /v1/chat/completions, /v1/messages, /v1/embeddings`, 404);
    }

    // ---------- Admin API (desktop UI only) ----------
    if (path.startsWith("/admin")) {
      if (!safeEqual(bearer(req), adminToken)) return oaiError("Admin token required", 401, "authentication_error");
      const keyFor = (id: string) => secrets.providerKey(id) ?? getConfig().providers.find((p) => p.id === id)?.apiKey;

      if (path === "/admin/config" && req.method === "GET") return json({ ...redactConfig(getConfig(), keyFor), secretsManaged: secrets.managed });
      if (path === "/admin/config" && req.method === "PUT") {
        const update = (await readJson(req)) as AppConfig;
        if (!Array.isArray(update?.providers) || !Array.isArray(update?.routes)) return oaiError("Invalid config", 400);
        saveConfig(applyUpdate(getConfig(), update));
        return json({ ...redactConfig(getConfig(), keyFor), secretsManaged: secrets.managed });
      }

      // Secrets: the desktop app writes the Keychain itself and streams to us over stdin;
      // this endpoint serves browser dev mode and headless runs.
      if (path === "/admin/secrets" && req.method === "PUT") {
        const b = await readJson(req);
        if (!b || !ACCOUNT_RE.test(String(b.account))) return oaiError("account must be provider:<id> or client:<id>", 400);
        const value = typeof b.value === "string" && b.value.trim() ? b.value.trim() : undefined;
        secrets.set(b.account, value);
        if (!secrets.managed && b.account.startsWith("provider:")) {
          const id = b.account.slice(9);
          const cfg = getConfig();
          saveConfig({ ...cfg, providers: cfg.providers.map((p) => (p.id === id ? { ...p, apiKey: value } : p)) });
        }
        if (b.account.startsWith("provider:")) router.quota.clearProvider(b.account.slice(9));
        return json({ ok: true });
      }

      if (path === "/admin/usage" && req.method === "GET") {
        return json({ ...router.quota.snapshot(), events: router.events.slice(0, 50).map((e) => ({ ...e, fallback: isFallback(e.attempts) })), scores: router.balancer.snapshot(), cache: cache.stats(), now: Date.now() });
      }
      if (path === "/admin/usage/reset" && req.method === "POST") {
        router.quota.reset();
        return json({ ok: true });
      }

      // Clients
      if (path === "/admin/clients" && req.method === "GET") return json({ clients: clientsView() });
      if (path === "/admin/clients" && req.method === "POST") {
        const b = (await readJson(req)) ?? {};
        const name = String(b.name ?? "").trim().slice(0, 48);
        if (!name) return oaiError("name is required", 400);
        const { client, key } = createClient(name, { limits: b.limits, localOnly: !!b.localOnly, allowedRoutes: b.allowedRoutes });
        const cfg = getConfig();
        saveConfig({ ...cfg, clients: [...cfg.clients, client] });
        const { keyHash: _h, ...safe } = client;
        return json({ client: safe, key }); // plaintext key shown once
      }
      const cm = path.match(/^\/admin\/clients\/([\w.-]+)(\/rotate)?$/);
      if (cm) {
        const cfg = getConfig();
        const c = cfg.clients.find((x) => x.id === cm[1]);
        if (!c) return oaiError("Unknown client", 404);
        if (cm[2] && req.method === "POST") {
          const key = newClientKey();
          saveConfig({ ...cfg, clients: cfg.clients.map((x) => (x.id === c.id ? { ...x, keyHash: hashKey(key), keyPrefix: key.slice(0, 8) } : x)) });
          return json({ key });
        }
        if (!cm[2] && req.method === "DELETE") {
          saveConfig({ ...cfg, clients: cfg.clients.filter((x) => x.id !== c.id) });
          return json({ ok: true });
        }
      }

      // Logs
      if (path === "/admin/logs" && req.method === "GET") {
        const p = url.searchParams;
        const rows = store.queryLogs({
          client: p.get("client") || undefined, route: p.get("route") || undefined, task: p.get("task") || undefined,
          status: (p.get("status") as "ok" | "error") || undefined, q: p.get("q") || undefined,
          since: p.get("since") ? Number(p.get("since")) : undefined, before: p.get("before") ? Number(p.get("before")) : undefined,
          limit: p.get("limit") ? Number(p.get("limit")) : 100,
        });
        return json({ logs: rows.map(({ requestBody: _a, responseBody: _b, ...r }) => r) });
      }
      const lm = path.match(/^\/admin\/logs\/(\d+)$/);
      if (lm && req.method === "GET") {
        const row = store.getLog(Number(lm[1]));
        return row ? json(row) : oaiError("Not found", 404);
      }
      if (path === "/admin/logs/purge-bodies" && req.method === "POST") {
        store.purgeBodies();
        return json({ ok: true });
      }

      // Classifier test box
      if (path === "/admin/classify" && req.method === "POST") {
        const b = (await readJson(req)) ?? {};
        const body = Array.isArray(b.messages) ? b : { messages: [{ role: "user", content: String(b.text ?? "") }] };
        const d = await classifier.classify(body, { clientId: `test:${Date.now()}` });
        return json(d);
      }

      if (path === "/admin/cache/purge" && req.method === "POST") {
        cache.purge();
        return json({ ok: true });
      }

      const m = path.match(/^\/admin\/providers\/([\w-]+)\/(models|test|clear)$/);
      if (m) {
        const [, id, action] = m;
        const p = getConfig().providers.find((x) => x.id === id);
        if (!p) return oaiError(`Unknown provider ${id}`, 404);
        if (action === "clear") {
          router.quota.clearProvider(p.id);
          return json({ ok: true });
        }
        if (action === "models") {
          try {
            return json({ models: await router.listModels(p.id, url.searchParams.has("refresh")) });
          } catch (e) {
            return json({ models: [], error: (e as Error).message }, 200);
          }
        }
        const t0 = Date.now();
        try {
          const models = await router.listModels(p.id, true);
          router.quota.clearProvider(p.id);
          return json({ ok: true, detail: `Connected · ${models.length} models`, ms: Date.now() - t0 });
        } catch (e) {
          return json({ ok: false, detail: (e as Error).message, ms: Date.now() - t0 });
        }
      }
      return oaiError("Unknown admin endpoint", 404);
    }

    return oaiError("Not found", 404);
  }

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    let res: Response;
    try {
      res = await route(req);
    } catch (e) {
      console.error("[ofr] handler error", e);
      res = oaiError(`Router error: ${(e as Error).message}`, 500, "server_error");
    }
    for (const [k, v] of Object.entries(cors(origin))) res.headers.set(k, v);
    return res;
  };
}

/** Set by index.ts once the shell has delivered Keychain secrets. */
export const secretsReadyFlag = { ready: false };
