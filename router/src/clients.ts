// Per-client keys (like LiteLLM virtual keys), identification and limits.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig, ClientConfig } from "./config";

export interface ClientIdentity {
  id: string; // client id, "hdr:<name>", "ua:<family>" or "anonymous"
  name: string;
  via: "key" | "admin" | "header" | "user-agent" | "anonymous";
  client?: ClientConfig;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newClientKey(): string {
  return "ofr-" + randomBytes(24).toString("base64url");
}

export function createClient(name: string, opts: Partial<ClientConfig> = {}): { client: ClientConfig; key: string } {
  const key = newClientKey();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "client";
  return {
    key,
    client: {
      id: `${id}-${randomBytes(3).toString("hex")}`,
      name,
      keyHash: hashKey(key),
      keyPrefix: key.slice(0, 8),
      enabled: true,
      createdAt: Date.now(),
      ...opts,
    },
  };
}

function eqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const UA_FAMILIES: [RegExp, string][] = [
  [/claude-cli|claude-code/i, "claude-code"],
  [/cursor/i, "cursor"],
  [/aider/i, "aider"],
  [/continue/i, "continue"],
  [/cline|roo-?code/i, "cline"],
  [/zed/i, "zed"],
  [/openai\/python|OpenAI\/Python/i, "openai-python"],
  [/openai\/js|OpenAI\/JS|openai-node/i, "openai-node"],
  [/anthropic-sdk|Anthropic\/(Python|JS)/i, "anthropic-sdk"],
  [/curl\//i, "curl"],
  [/python-requests|httpx|aiohttp/i, "python-http"],
];

export function uaFamily(ua: string | null): string | undefined {
  if (!ua) return undefined;
  for (const [re, name] of UA_FAMILIES) if (re.test(ua)) return name;
  return undefined;
}

export function presentedKey(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || undefined;
  return req.headers.get("x-api-key")?.trim() || undefined;
}

/**
 * Identify the caller. Returns null when strict mode rejects the request.
 * Order: client key → admin token (the app itself) → X-OFR-Client → User-Agent → anonymous.
 */
export function identify(req: Request, cfg: AppConfig, adminToken: string): ClientIdentity | null {
  const key = presentedKey(req);
  if (key) {
    const h = hashKey(key);
    const client = cfg.clients.find((c) => eqHex(c.keyHash, h));
    if (client) return client.enabled ? { id: client.id, name: client.name, via: "key", client } : null;
    if (key.length === adminToken.length && eqHex(hashKey(key), hashKey(adminToken))) return { id: "app", name: "OpenFOC app", via: "admin" };
  }
  if (cfg.requireClientKeys) return null;
  const hdr = req.headers.get("x-ofr-client")?.trim().slice(0, 48).replace(/[^\w .-]/g, "");
  if (hdr) return { id: `hdr:${hdr}`, name: hdr, via: "header" };
  const fam = uaFamily(req.headers.get("user-agent"));
  if (fam) return { id: `ua:${fam}`, name: fam, via: "user-agent" };
  return { id: "anonymous", name: "anonymous", via: "anonymous" };
}

/** Sliding-window per-client limits, independent of provider quotas. */
export class ClientLimiter {
  private recent = new Map<string, number[]>();
  private daily = new Map<string, { day: string; requests: number; tokens: number }>();

  constructor(private clock: () => number = Date.now) {}

  private day(id: string) {
    const d = new Date(this.clock()).toDateString();
    let s = this.daily.get(id);
    if (!s || s.day !== d) this.daily.set(id, (s = { day: d, requests: 0, tokens: 0 }));
    return s;
  }

  /** Returns ms to wait if limited, else 0. Counts the request when allowed. */
  take(client: ClientConfig | undefined): number {
    if (!client?.limits) return 0;
    const now = this.clock();
    const arr = (this.recent.get(client.id) ?? []).filter((t) => now - t < 60_000);
    const d = this.day(client.id);
    if (client.limits.rpm && arr.length >= client.limits.rpm) return 60_000 - (now - arr[0]!);
    const msToMidnight = () => {
      const t = new Date(now);
      t.setHours(24, 0, 0, 0);
      return t.getTime() - now;
    };
    if (client.limits.rpd && d.requests >= client.limits.rpd) return msToMidnight();
    if (client.limits.tokensPerDay && d.tokens >= client.limits.tokensPerDay) return msToMidnight();
    arr.push(now);
    this.recent.set(client.id, arr);
    d.requests++;
    return 0;
  }

  addTokens(clientId: string, tokens: number) {
    this.day(clientId).tokens += tokens;
  }
}
