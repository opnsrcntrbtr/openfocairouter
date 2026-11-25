// Latency-aware load balancing inside a route (ordered | latency | balanced), by tier.
import type { RouteConfig } from "./config";

interface Score {
  ewmaMs?: number;
  outcomes: boolean[]; // last 20, true = success
}

export interface TargetView {
  label: string; // target as written in the route, e.g. "groq/llama-3.3-70b-versatile"
  local: boolean;
  quotaUsed: number; // 0..1 fraction of RPM/RPD used
}

const ALPHA = 0.3;

export class Balancer {
  private scores = new Map<string, Score>();

  constructor(private random: () => number = Math.random) {}

  private get(label: string): Score {
    let s = this.scores.get(label);
    if (!s) this.scores.set(label, (s = { outcomes: [] }));
    return s;
  }

  record(label: string, ok: boolean, ttfbMs?: number) {
    const s = this.get(label);
    s.outcomes.push(ok);
    if (s.outcomes.length > 20) s.outcomes.shift();
    if (ok && ttfbMs !== undefined) s.ewmaMs = s.ewmaMs === undefined ? ttfbMs : ALPHA * ttfbMs + (1 - ALPHA) * s.ewmaMs;
  }

  errorRate(label: string): number {
    const o = this.get(label).outcomes;
    return o.length ? o.filter((x) => !x).length / o.length : 0;
  }

  /** Lower is better. Unknown latency gets the median of known ones (or 1000 ms). */
  score(t: TargetView, median: number): number {
    const s = this.get(t.label);
    return (s.ewmaMs ?? median) * (1 + 2 * this.errorRate(t.label)) * (1 + t.quotaUsed);
  }

  snapshot(): Record<string, { ewmaMs?: number; errorRate: number; samples: number }> {
    const out: Record<string, { ewmaMs?: number; errorRate: number; samples: number }> = {};
    for (const [k, s] of this.scores) out[k] = { ewmaMs: s.ewmaMs && Math.round(s.ewmaMs), errorRate: this.errorRate(k), samples: s.outcomes.length };
    return out;
  }

  tierOf(route: RouteConfig, t: TargetView): number {
    return route.tiers?.[t.label] ?? (t.local ? 1 : 0);
  }

  /** Reorder targets; never moves a target across tiers. */
  order(route: RouteConfig, targets: TargetView[]): TargetView[] {
    const strategy = route.strategy ?? "ordered";
    const indexed = targets.map((t, i) => ({ t, i, tier: this.tierOf(route, t) }));
    // Stable sort by tier first (keeps written order within a tier for "ordered").
    indexed.sort((a, b) => a.tier - b.tier || a.i - b.i);
    if (strategy === "ordered") return indexed.map((x) => x.t);

    const known = targets.map((t) => this.get(t.label).ewmaMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const median = known.length ? known[Math.floor(known.length / 2)]! : 1000;
    const out: TargetView[] = [];
    const tiers = [...new Set(indexed.map((x) => x.tier))];
    for (const tier of tiers) {
      let group = indexed.filter((x) => x.tier === tier).map((x) => ({ t: x.t, s: this.score(x.t, median) }));
      group.sort((a, b) => a.s - b.s);
      if (strategy === "balanced" && group.length > 1) {
        // Weighted shuffle by 1/score: spreads free quota across providers.
        const picked: typeof group = [];
        while (group.length) {
          const weights = group.map((g) => 1 / Math.max(g.s, 1));
          const total = weights.reduce((a, b) => a + b, 0);
          let r = this.random() * total;
          let k = 0;
          while (k < group.length - 1 && (r -= weights[k]!) > 0) k++;
          picked.push(group[k]!);
          group = group.filter((_, j) => j !== k);
        }
        group = picked;
      } else if (strategy === "latency" && group.length > 1 && this.random() < 0.05) {
        // Explore: occasionally try the runner-up first so stale stats refresh.
        [group[0], group[1]] = [group[1]!, group[0]!];
      }
      out.push(...group.map((g) => g.t));
    }
    return out;
  }
}
