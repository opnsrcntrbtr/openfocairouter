// HTTP layer: OpenAI-compatible /v1 API + token-protected /admin API for the desktop UI.
import { applyUpdate, redactConfig, type AppConfig } from "./config";
import { authHeaders, providerUrl, type Router } from "./router";

export interface ServerDeps {
  router: Router;
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
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-expose-headers": "x-ofr-provider, x-ofr-model, x-ofr-attempts",
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

export function createHandler(deps: ServerDeps) {
  const { router, getConfig, saveConfig, adminToken, version } = deps;

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = req.headers.get("origin");

    if (origin && !ALLOWED_ORIGINS.has(origin)) return oaiError("Origin not allowed", 403, "forbidden");
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    if (path === "/" || path === "/health") return json({ ok: true, name: "openfocairouter", version });

    // ---------- OpenAI-compatible API ----------
    if (path.startsWith("/v1")) {
      const cfg = getConfig();
      if (cfg.localApiKey && !safeEqual(bearer(req), cfg.localApiKey) && !safeEqual(bearer(req), adminToken)) {
        return oaiError("Invalid local API key. Set it in OpenFOC AI Router → Settings.", 401, "authentication_error");
      }
      if (path === "/v1/models" && req.method === "GET") {
        const created = Math.floor(Date.now() / 1000);
        return json({ object: "list", data: router.advertisedModels().map((id) => ({ id, object: "model", created, owned_by: "openfocairouter" })) });
      }
      if (path === "/v1/chat/completions" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return oaiError("Request body must be JSON", 400);
        }
        if (!Array.isArray(body?.messages)) return oaiError("`messages` must be an array", 400);
        return router.chat(body);
      }
      return oaiError(`Not supported: ${req.method} ${path}. Supported: GET /v1/models, POST /v1/chat/completions`, 404);
    }

    // ---------- Admin API (desktop UI only) ----------
    if (path.startsWith("/admin")) {
      if (!safeEqual(bearer(req), adminToken)) return oaiError("Admin token required", 401, "authentication_error");

      if (path === "/admin/config" && req.method === "GET") return json(redactConfig(getConfig()));
      if (path === "/admin/config" && req.method === "PUT") {
        const update = (await req.json()) as AppConfig;
        if (!Array.isArray(update?.providers) || !Array.isArray(update?.routes)) return oaiError("Invalid config", 400);
        saveConfig(applyUpdate(getConfig(), update));
        return json(redactConfig(getConfig()));
      }
      if (path === "/admin/usage" && req.method === "GET") {
        return json({ ...router.quota.snapshot(), events: router.events.slice(0, 50), now: Date.now() });
      }
      if (path === "/admin/usage/reset" && req.method === "POST") {
        router.quota.reset();
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
        // test: hit /models (cheap, no tokens spent)
        const t0 = Date.now();
        try {
          const res = await fetch(p.modelsUrl ?? providerUrl(p, "/models"), { headers: authHeaders(p), signal: AbortSignal.timeout(8000) });
          const ok = res.ok;
          const detail = ok ? "Connected" : `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
          if (ok) router.quota.clearProvider(p.id);
          return json({ ok, detail, ms: Date.now() - t0 });
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
