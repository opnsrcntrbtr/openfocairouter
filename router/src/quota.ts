// Per-target usage, rate-limit and cooldown tracking.
import type { Limits } from "./config";

export interface TargetStats {
  day: string; // YYYY-MM-DD (local) the daily counters belong to
  requestsToday: number;
  tokensToday: number;
  promptTokensToday: number;
  completionTokensToday: number;
  successes: number;
  failures: number;
  recent: number[]; // request timestamps in the last 60s
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastStatus?: number;
  lastError?: string;
  lastUsedAt?: number;
  avgLatencyMs?: number;
  remainingRequests?: number; // from provider headers
  remainingTokens?: number;
}

export interface UsageSnapshot {
  targets: Record<string, TargetStats>;
  providerCooldowns: Record<string, { until: number; reason: string }>;
}

export type SkipReason = "provider-cooldown" | "cooldown" | "rpm" | "rpd" | "provider-remaining";

const MIN = 60_000;
const BASE_BACKOFF = 30_000;
const MAX_BACKOFF = 10 * MIN;

export function today(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyStats(now: number): TargetStats {
  return {
    day: today(now),
    requestsToday: 0,
    tokensToday: 0,
    promptTokensToday: 0,
    completionTokensToday: 0,
    successes: 0,
    failures: 0,
    recent: [],
    consecutiveFailures: 0,
  };
}

/** Parse durations like "2m59.56s", "7.66s", "120ms", "30" (seconds). Returns ms. */
export function parseDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(re)) {
    matched = true;
    const n = parseFloat(m[1]!);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * MIN : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? Math.round(total) : undefined;
}

/** Work out how long to wait from rate-limit headers. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = parseDuration(ra);
    if (secs !== undefined) return secs;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const resetReq = parseDuration(headers.get("x-ratelimit-reset-requests"));
  if (resetReq !== undefined) return resetReq;
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const n = Number(reset);
    // OpenRouter sends epoch ms; others may send epoch seconds or delta seconds.
    if (n > 1e12) return Math.max(0, n - now);
    if (n > 1e9) return Math.max(0, n * 1000 - now);
    return n * 1000;
  }
  return parseDuration(reset);
}

export class QuotaTracker {
  targets: Record<string, TargetStats> = {};
  providerCooldowns: Record<string, { until: number; reason: string }> = {};
  private dirty = false;

  constructor(snapshot?: Partial<UsageSnapshot>, private clock: () => number = Date.now) {
    if (snapshot?.targets) this.targets = snapshot.targets;
    if (snapshot?.providerCooldowns) this.providerCooldowns = snapshot.providerCooldowns;
  }

  private stats(key: string): TargetStats {
    const now = this.clock();
    let s = this.targets[key];
    if (!s) s = this.targets[key] = emptyStats(now);
    const d = today(now);
    if (s.day !== d) {
      Object.assign(s, {
        day: d,
        requestsToday: 0,
        tokensToday: 0,
        promptTokensToday: 0,
        completionTokensToday: 0,
        remainingRequests: undefined,
        remainingTokens: undefined,
      });
    }
    s.recent = s.recent.filter((t) => now - t < MIN);
    return s;
  }

  /** Can this target take a request right now? */
  check(providerId: string, key: string, limits?: Limits): { ok: true } | { ok: false; reason: SkipReason; retryInMs?: number } {
    const now = this.clock();
    const pc = this.providerCooldowns[providerId];
    if (pc && pc.until > now) return { ok: false, reason: "provider-cooldown", retryInMs: pc.until - now };
    const s = this.stats(key);
    if (s.cooldownUntil && s.cooldownUntil > now) return { ok: false, reason: "cooldown", retryInMs: s.cooldownUntil - now };
    if (limits?.rpm && s.recent.length >= limits.rpm) {
      return { ok: false, reason: "rpm", retryInMs: MIN - (now - s.recent[0]!) };
    }
    if (limits?.rpd && s.requestsToday >= limits.rpd) return { ok: false, reason: "rpd" };
    if (s.remainingRequests === 0) return { ok: false, reason: "provider-remaining" };
    return { ok: true };
  }

  /** Record that a request was sent (counts toward RPM/RPD whatever the outcome). */
  recordAttempt(key: string) {
    const s = this.stats(key);
    const now = this.clock();
    s.recent.push(now);
    s.requestsToday++;
    s.lastUsedAt = now;
    this.dirty = true;
  }

  recordHeaders(key: string, headers: Headers) {
    const s = this.stats(key);
    const rr = headers.get("x-ratelimit-remaining-requests") ?? headers.get("x-ratelimit-remaining");
    const rt = headers.get("x-ratelimit-remaining-tokens");
    if (rr !== null && /^\d+$/.test(rr)) s.remainingRequests = Number(rr);
    if (rt !== null && /^\d+$/.test(rt)) s.remainingTokens = Number(rt);
    this.dirty = true;
  }

  recordSuccess(key: string, latencyMs: number, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    const s = this.stats(key);
    s.successes++;
    s.consecutiveFailures = 0;
    s.cooldownUntil = undefined;
    s.lastStatus = 200;
    s.lastError = undefined;
    s.avgLatencyMs = s.avgLatencyMs === undefined ? latencyMs : Math.round(s.avgLatencyMs * 0.8 + latencyMs * 0.2);
    if (usage) this.recordTokens(key, usage);
    this.dirty = true;
  }

  recordTokens(key: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    const s = this.stats(key);
    const p = usage.prompt_tokens ?? 0;
    const c = usage.completion_tokens ?? 0;
    s.promptTokensToday += p;
    s.completionTokensToday += c;
    s.tokensToday += usage.total_tokens ?? p + c;
    this.dirty = true;
  }

  /**
   * Record a failure. `cooldown`:
   *  - number: explicit wait from headers
   *  - "backoff": exponential backoff
   *  - "none": no cooldown (e.g. request too large for this provider)
   */
  recordFailure(key: string, status: number, message: string, cooldown: number | "backoff" | "none") {
    const s = this.stats(key);
    const now = this.clock();
    s.failures++;
    s.consecutiveFailures++;
    s.lastStatus = status;
    s.lastError = message.slice(0, 300);
    if (cooldown !== "none") {
      const wait =
        typeof cooldown === "number"
          ? Math.min(Math.max(cooldown, 1000), 24 * 60 * MIN)
          : Math.min(BASE_BACKOFF * 2 ** (s.consecutiveFailures - 1), MAX_BACKOFF);
      s.cooldownUntil = now + wait;
    }
    this.dirty = true;
  }

  coolProvider(providerId: string, ms: number, reason: string) {
    this.providerCooldowns[providerId] = { until: this.clock() + ms, reason };
    this.dirty = true;
  }

  clearProvider(providerId: string) {
    delete this.providerCooldowns[providerId];
    for (const [k, s] of Object.entries(this.targets)) {
      if (k.startsWith(providerId + "/")) s.cooldownUntil = undefined;
    }
    this.dirty = true;
  }

  reset() {
    this.targets = {};
    this.providerCooldowns = {};
    this.dirty = true;
  }

  snapshot(): UsageSnapshot {
    for (const k of Object.keys(this.targets)) this.stats(k); // roll over day / prune recent
    return { targets: this.targets, providerCooldowns: this.providerCooldowns };
  }

  takeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }
}
