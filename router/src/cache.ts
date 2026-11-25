// Response cache: exact-match (default) and semantic (opt-in, local embeddings only).
import { createHash } from "node:crypto";
import type { CacheConfig } from "./config";
import type { Store } from "./db";
import { cosine, type Embedder } from "./embedder";
import { textOf } from "./classify";

export interface CacheHit {
  kind: "hit" | "semantic-hit";
  served: string;
  body: any; // OpenAI chat completion JSON (or embeddings JSON)
}

const IGNORED = new Set(["stream", "stream_options", "user", "metadata", "n"]);

function stable(v: any): any {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().filter((k) => !IGNORED.has(k)).map((k) => [k, stable(v[k])]));
  return v;
}

export function cacheKey(kind: string, route: string, body: any): string {
  return createHash("sha256").update(kind + "\u0000" + route + "\u0000" + JSON.stringify(stable(body))).digest("hex");
}

/** Only deterministic-ish, side-effect-free chat requests are cached. */
export function cacheable(body: any, cfg: CacheConfig, force: boolean): boolean {
  if (force) return true;
  const temp = body?.temperature ?? 1;
  if (temp > cfg.maxTemperature) return false;
  if (body?.tool_choice && body.tool_choice !== "auto" && body.tool_choice !== "none") return false;
  if ((body?.messages ?? []).some((m: any) => m.role === "tool" || m.tool_calls)) return false;
  return true;
}

function systemHash(body: any): string {
  const sys = (body?.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => textOf(m.content)).join("\n");
  return createHash("sha256").update(sys + "\u0000" + JSON.stringify(body?.tools ?? null)).digest("hex").slice(0, 32);
}

function singleTurnText(body: any): string | undefined {
  const turns = (body?.messages ?? []).filter((m: any) => m.role !== "system");
  return turns.length === 1 && turns[0].role === "user" ? textOf(turns[0].content) : undefined;
}

export class ResponseCache {
  constructor(private store: Store, private embedder: Embedder | undefined, private getCfg: () => CacheConfig, private clock: () => number = Date.now) {}

  get(kind: string, scope: string, route: string, body: any): CacheHit | undefined {
    const cfg = this.getCfg();
    const key = cacheKey(kind, route, body);
    const row = this.store.db.prepare("SELECT * FROM cache WHERE key = ? AND scope = ?").get(key, scope) as any;
    if (!row) return undefined;
    if (this.clock() - row.created > cfg.ttlHours * 3_600_000) {
      this.store.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
      return undefined;
    }
    this.store.db.prepare("UPDATE cache SET hits = hits + 1, last_hit = ? WHERE key = ?").run(this.clock(), key);
    return { kind: "hit", served: row.served, body: JSON.parse(row.body) };
  }

  async getSemantic(scope: string, route: string, body: any): Promise<CacheHit | undefined> {
    const cfg = this.getCfg();
    const text = singleTurnText(body);
    if (!text || !this.embedder) return undefined;
    const res = await this.embedder.embed([text.slice(0, 2000)], 150);
    if (!res) return undefined;
    const v = res.vectors[0]!;
    const sh = systemHash(body) + "|" + route + "|" + res.model;
    const rows = this.store.db
      .prepare("SELECT key, embedding, served, body, created FROM cache WHERE scope = ? AND kind = 'chat-sem' AND system_hash = ? ORDER BY last_hit DESC LIMIT 500")
      .all(scope, sh) as any[];
    let best: { row: any; s: number } | undefined;
    for (const r of rows) {
      if (this.clock() - r.created > cfg.ttlHours * 3_600_000) continue;
      const e = new Float32Array(new Uint8Array(r.embedding).buffer);
      const s = cosine(v, e);
      if (s >= cfg.semanticThreshold && (!best || s > best.s)) best = { row: r, s };
    }
    if (!best) return undefined;
    this.store.db.prepare("UPDATE cache SET hits = hits + 1, last_hit = ? WHERE key = ?").run(this.clock(), best.row.key);
    return { kind: "semantic-hit", served: best.row.served, body: JSON.parse(best.row.body) };
  }

  put(kind: string, scope: string, route: string, body: any, served: string, response: any) {
    const json = JSON.stringify(response);
    const key = cacheKey(kind, route, body);
    this.store.db
      .prepare("INSERT OR REPLACE INTO cache (key, scope, kind, created, last_hit, hits, bytes, served, body) VALUES (?,?,?,?,?,0,?,?,?)")
      .run(key, scope, kind, this.clock(), this.clock(), json.length, served, json);
    this.evict();
  }

  async putSemantic(scope: string, route: string, body: any, served: string, response: any) {
    const text = singleTurnText(body);
    if (!text || !this.embedder) return;
    const res = await this.embedder.embed([text.slice(0, 2000)], 2000);
    if (!res) return;
    const v = res.vectors[0]!;
    const json = JSON.stringify(response);
    const key = "sem:" + cacheKey("chat", route, body);
    this.store.db
      .prepare("INSERT OR REPLACE INTO cache (key, scope, kind, created, last_hit, hits, bytes, system_hash, embedding, served, body) VALUES (?,?,?,?,?,0,?,?,?,?,?)")
      .run(key, scope, "chat-sem", this.clock(), this.clock(), json.length + v.byteLength, systemHash(body) + "|" + route + "|" + res.model, new Uint8Array(v.buffer), served, json);
  }

  evict() {
    const max = this.getCfg().maxMb * 1024 * 1024;
    const total = (this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM cache").get() as any).b as number;
    if (total <= max) return;
    // Drop least-recently-hit rows until ~90% of the cap.
    let excess = total - max * 0.9;
    const rows = this.store.db.prepare("SELECT key, bytes FROM cache ORDER BY last_hit ASC").all() as { key: string; bytes: number }[];
    const del = this.store.db.prepare("DELETE FROM cache WHERE key = ?");
    for (const r of rows) {
      if (excess <= 0) break;
      del.run(r.key);
      excess -= r.bytes;
    }
  }

  purge() {
    this.store.db.exec("DELETE FROM cache;");
  }

  stats(): { entries: number; bytes: number; hits: number } {
    const r = this.store.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b, COALESCE(SUM(hits),0) AS h FROM cache").get() as any;
    return { entries: r.n, bytes: r.b, hits: r.h };
  }
}

/** Replay a cached OpenAI chat completion as an SSE stream. */
export function replayAsSSE(json: any): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const msg = json?.choices?.[0]?.message ?? {};
  const base = { id: json?.id ?? "cache", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: json?.model };
  const chunks: any[] = [];
  chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  const text: string = typeof msg.content === "string" ? msg.content : "";
  for (let i = 0; i < text.length; i += 400) chunks.push({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 400) }, finish_reason: null }] });
  if (msg.tool_calls?.length) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((t: any, index: number) => ({ index, ...t })) }, finish_reason: null }] });
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: json?.choices?.[0]?.finish_reason ?? "stop" }], usage: json?.usage });
  return new ReadableStream({
    start(ctl) {
      for (const c of chunks) ctl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      ctl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctl.close();
    },
  });
}
