// SQLite storage (bun:sqlite, WAL): request log + FTS, cache, per-client daily stats.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { isFallback, type Attempt } from "./router";

export interface LogRow {
  id?: number;
  ts: number;
  client: string;
  api: "openai" | "anthropic" | "embeddings";
  requested: string;
  task?: string | null;
  taskScore?: number | null;
  taskReason?: string | null;
  served?: string | null;
  attempts: Attempt[];
  status: number;
  stream: boolean;
  cache?: string | null;
  ttfbMs?: number | null;
  ms: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  error?: string | null;
  requestBody?: string | null;
  responseBody?: string | null;
}

export interface LogQuery {
  client?: string;
  route?: string;
  task?: string;
  status?: "ok" | "error";
  q?: string;
  since?: number;
  limit?: number;
  before?: number; // id cursor
}

export interface ClientDay {
  client: string;
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  errors: number;
  fallbacks: number;
  cacheHits: number;
  latencyTotal: number;
}

const BODY_CAP = 32 * 1024;
const cap = (s?: string | null) => (s == null ? null : s.length > BODY_CAP ? s.slice(0, BODY_CAP) + "…[truncated]" : s);

export class Store {
  readonly db: Database;
  private pending: LogRow[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private hasFts = true;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:" && existsSync(path)) chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, client TEXT NOT NULL, api TEXT NOT NULL, requested TEXT NOT NULL,
        task TEXT, task_score REAL, task_reason TEXT, served TEXT, attempts TEXT NOT NULL,
        status INTEGER NOT NULL, stream INTEGER NOT NULL, cache TEXT, ttfb_ms INTEGER, ms INTEGER NOT NULL,
        prompt_tokens INTEGER, completion_tokens INTEGER, error TEXT,
        request_body TEXT, response_body TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
      CREATE INDEX IF NOT EXISTS requests_client ON requests(client, ts);
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL,
        last_hit INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL,
        system_hash TEXT, embedding BLOB, served TEXT, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_scope ON cache(scope, kind);
      CREATE TABLE IF NOT EXISTS client_daily (
        client TEXT NOT NULL, day TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        fallbacks INTEGER NOT NULL DEFAULT 0, cache_hits INTEGER NOT NULL DEFAULT 0,
        latency_total INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (client, day)
      );
    `);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(request_body, response_body, content='requests', content_rowid='id');`);
    } catch {
      this.hasFts = false;
    }
  }

  /** Queue a log row; rows are flushed in batches off the request path. */
  log(row: LogRow, keepBodies: boolean) {
    if (!keepBodies) {
      row.requestBody = null;
      row.responseBody = null;
    }
    this.pending.push(row);
    if (!this.timer) this.timer = setInterval(() => this.flush(), 250);
  }

  flush() {
    if (!this.pending.length) return;
    const rows = this.pending.splice(0);
    const ins = this.db.prepare(`INSERT INTO requests (ts, client, api, requested, task, task_score, task_reason, served, attempts, status, stream, cache, ttfb_ms, ms, prompt_tokens, completion_tokens, error, request_body, response_body)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const fts = this.hasFts ? this.db.prepare(`INSERT INTO requests_fts (rowid, request_body, response_body) VALUES (?,?,?)`) : null;
    const day = this.db.prepare(`INSERT INTO client_daily (client, day, requests, prompt_tokens, completion_tokens, errors, fallbacks, cache_hits, latency_total)
      VALUES (?,?,1,?,?,?,?,?,?)
      ON CONFLICT(client, day) DO UPDATE SET requests = requests + 1, prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens, errors = errors + excluded.errors,
        fallbacks = fallbacks + excluded.fallbacks, cache_hits = cache_hits + excluded.cache_hits, latency_total = latency_total + excluded.latency_total`);
    this.db.transaction(() => {
      for (const r of rows) {
        const res = ins.run(r.ts, r.client, r.api, r.requested, r.task ?? null, r.taskScore ?? null, r.taskReason ?? null, r.served ?? null,
          JSON.stringify(r.attempts), r.status, r.stream ? 1 : 0, r.cache ?? null, r.ttfbMs ?? null, r.ms, r.promptTokens ?? null,
          r.completionTokens ?? null, r.error ?? null, cap(r.requestBody), cap(r.responseBody));
        if (fts && (r.requestBody || r.responseBody)) fts.run(Number(res.lastInsertRowid), cap(r.requestBody), cap(r.responseBody));
        const fallbacks = r.status < 400 && isFallback(r.attempts) ? 1 : 0;
        day.run(r.client, localDay(r.ts), r.promptTokens ?? 0, r.completionTokens ?? 0, r.status >= 400 ? 1 : 0, fallbacks,
          r.cache && r.cache !== "miss" ? 1 : 0, r.ms);
      }
    })();
  }

  queryLogs(q: LogQuery): LogRow[] {
    this.flush();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.client) { where.push("r.client = ?"); args.push(q.client); }
    if (q.route) { where.push("(r.requested = ? OR r.served LIKE ?)"); args.push(q.route, `${q.route}%`); }
    if (q.task) { where.push("r.task = ?"); args.push(q.task); }
    if (q.status === "ok") where.push("r.status < 400");
    if (q.status === "error") where.push("r.status >= 400");
    if (q.since) { where.push("r.ts >= ?"); args.push(q.since); }
    if (q.before) { where.push("r.id < ?"); args.push(q.before); }
    let from = "requests r";
    if (q.q) {
      if (this.hasFts) {
        from = "requests r JOIN requests_fts f ON f.rowid = r.id";
        where.push("(requests_fts MATCH ? )");
        args.push(q.q.replace(/["*]/g, " ").trim().split(/\s+/).map((w) => `"${w}"`).join(" "));
      } else {
        where.push("(r.request_body LIKE ? OR r.response_body LIKE ? OR r.error LIKE ?)");
        args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
      }
    }
    const sql = `SELECT r.* FROM ${from} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.id DESC LIMIT ?`;
    args.push(Math.min(q.limit ?? 100, 500));
    return (this.db.prepare(sql).all(...args) as any[]).map(rowToLog);
  }

  getLog(id: number): LogRow | undefined {
    this.flush();
    const r = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as any;
    return r ? rowToLog(r) : undefined;
  }

  clientStats(days = 30): ClientDay[] {
    this.flush();
    const since = localDay(Date.now() - days * 86_400_000);
    return (this.db.prepare("SELECT * FROM client_daily WHERE day >= ? ORDER BY day DESC").all(since) as any[]).map((r) => ({
      client: r.client, day: r.day, requests: r.requests, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
      errors: r.errors, fallbacks: r.fallbacks, cacheHits: r.cache_hits, latencyTotal: r.latency_total,
    }));
  }

  /** p50 / p95 latency per client over the last N days. */
  clientLatency(days = 7): Record<string, { p50: number; p95: number }> {
    this.flush();
    const rows = this.db.prepare("SELECT client, ms FROM requests WHERE ts >= ? AND status < 400 ORDER BY client, ms").all(Date.now() - days * 86_400_000) as { client: string; ms: number }[];
    const by: Record<string, number[]> = {};
    for (const r of rows) (by[r.client] ??= []).push(r.ms);
    const out: Record<string, { p50: number; p95: number }> = {};
    for (const [c, arr] of Object.entries(by)) out[c] = { p50: arr[Math.floor(arr.length * 0.5)] ?? 0, p95: arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))] ?? 0 };
    return out;
  }

  /** Delete bodies older than the retention window and log rows older than 90 days. */
  prune(retentionDays: number) {
    this.flush();
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const ids = this.db.prepare("SELECT id FROM requests WHERE ts < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)").all(cutoff) as { id: number }[];
    if (this.hasFts) {
      const del = this.db.prepare("INSERT INTO requests_fts(requests_fts, rowid, request_body, response_body) SELECT 'delete', id, request_body, response_body FROM requests WHERE id = ?");
      for (const { id } of ids) del.run(id);
    }
    this.db.prepare("UPDATE requests SET request_body = NULL, response_body = NULL WHERE ts < ?").run(cutoff);
    this.db.prepare("DELETE FROM requests WHERE ts < ?").run(Date.now() - 90 * 86_400_000);
  }

  purgeBodies() {
    this.flush();
    if (this.hasFts) this.db.exec("DELETE FROM requests_fts;");
    this.db.exec("UPDATE requests SET request_body = NULL, response_body = NULL;");
  }

  close() {
    this.flush();
    if (this.timer) clearInterval(this.timer);
    this.db.close();
  }
}

function rowToLog(r: any): LogRow {
  return {
    id: r.id, ts: r.ts, client: r.client, api: r.api, requested: r.requested, task: r.task, taskScore: r.task_score,
    taskReason: r.task_reason, served: r.served, attempts: JSON.parse(r.attempts), status: r.status, stream: !!r.stream,
    cache: r.cache, ttfbMs: r.ttfb_ms, ms: r.ms, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    error: r.error, requestBody: r.request_body, responseBody: r.response_body,
  };
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
