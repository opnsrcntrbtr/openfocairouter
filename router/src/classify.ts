// Hybrid task classifier: override → rules → local embeddings → general, with stickiness.
import { createHash } from "node:crypto";
import type { TaskRoutingConfig } from "./config";
import { centroid, cosine, type Embedder } from "./embedder";

export interface TaskDecision {
  task: string; // task name, or "general"
  route: string;
  score?: number;
  reason: "override" | "rule:vision" | "rule:long-context" | "rule:coding" | "rule:quick" | "embedding" | "sticky" | "default" | "embedder-unavailable" | "below-threshold";
  scores?: Record<string, number>;
  ms: number;
}

export const GENERAL = "general";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(body: any): number {
  let chars = 0;
  for (const m of body?.messages ?? []) chars += textOf(m.content).length;
  if (body?.tools) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 4);
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  return "";
}

function hasImage(body: any): boolean {
  return (body?.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url" || p?.type === "input_image" || p?.type === "image"));
}

const CODE_SIGNAL = /```|^diff --git|^@@ .* @@|^\+\+\+ |\b(function|const|let|def|class|import|return|public static)\b.*[({;:]/m;
const AGENT_SIGNAL = /you are (an? )?(coding|software|programming)|code (assistant|agent)|tool use|use the (\w+ )?tools?/i;

function lastUser(body: any): string {
  const msgs: any[] = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") return textOf(msgs[i].content);
  return "";
}

/** Deterministic rules; return a task name or undefined. */
export function rules(body: any, cfg: TaskRoutingConfig): { task: string; reason: TaskDecision["reason"] } | undefined {
  if (hasImage(body)) return { task: "vision", reason: "rule:vision" };
  if (estimateTokens(body) > cfg.longContextTokens) return { task: "long-context", reason: "rule:long-context" };
  const system = (body?.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => textOf(m.content)).join("\n");
  const user = lastUser(body);
  if ((body?.tools?.length && AGENT_SIGNAL.test(system)) || CODE_SIGNAL.test(user)) return { task: "coding", reason: "rule:coding" };
  const turns = (body?.messages ?? []).filter((m: any) => m.role !== "system").length;
  if (turns <= 1 && user.length > 0 && user.length < cfg.quickMaxChars && !body?.tools?.length) return { task: "quick", reason: "rule:quick" };
  return undefined;
}

export class Classifier {
  private centroids: { model: string; key: string; byTask: Map<string, Float32Array> } | undefined;
  private sticky = new Map<string, { task: string; until: number }>();

  constructor(private embedder: Embedder, private getCfg: () => TaskRoutingConfig, private clock: () => number = Date.now) {}

  routeFor(task: string): string {
    if (task === "vision") return "vision";
    return this.getCfg().tasks.find((t) => t.name === task)?.route ?? "auto";
  }

  conversationKey(body: any, clientId: string): string {
    const msgs: any[] = body?.messages ?? [];
    const system = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
    const firstUser = textOf(msgs.find((m) => m.role === "user")?.content);
    return createHash("sha256").update(`${clientId}\u0000${system}\u0000${firstUser}`).digest("hex").slice(0, 32);
  }

  private async ensureCentroids(): Promise<Map<string, Float32Array> | undefined> {
    const cfg = this.getCfg();
    const key = JSON.stringify(cfg.tasks.map((t) => [t.name, t.examples]));
    const model = await this.embedder.target();
    if (!model) return undefined;
    if (this.centroids && this.centroids.model === model && this.centroids.key === key) return this.centroids.byTask;
    const all = cfg.tasks.flatMap((t) => t.examples.map((e) => ({ task: t.name, text: e })));
    if (!all.length) return undefined;
    const res = await this.embedder.embed(all.map((a) => a.text), 15_000); // one-off warm-up may be slow
    if (!res) return undefined;
    const byTask = new Map<string, Float32Array>();
    for (const t of cfg.tasks) {
      const vs = res.vectors.filter((_, i) => all[i]!.task === t.name);
      if (vs.length) byTask.set(t.name, centroid(vs));
    }
    this.centroids = { model: res.model, key, byTask };
    return byTask;
  }

  /** Warm up example vectors in the background so the first request isn't slow. */
  warm() {
    this.ensureCentroids().catch(() => {});
  }

  async classify(body: any, opts: { clientId: string; override?: string }): Promise<TaskDecision> {
    const t0 = this.clock();
    const cfg = this.getCfg();
    const done = (d: Omit<TaskDecision, "ms" | "route"> & { route?: string }): TaskDecision => {
      const decision = { ...d, route: d.route ?? this.routeFor(d.task), ms: this.clock() - t0 };
      return decision;
    };
    if (opts.override) return done({ task: opts.override, reason: "override" });

    const convo = this.conversationKey(body, opts.clientId);
    const r = rules(body, cfg);
    // Forcing rules (images, very long prompts) override stickiness; soft rules don't.
    if (r && (r.reason === "rule:vision" || r.reason === "rule:long-context")) return this.stick(convo, done({ task: r.task, reason: r.reason }));
    const st = this.sticky.get(convo);
    if (st && st.until > this.clock()) return done({ task: st.task, reason: "sticky" });
    if (r) return this.stick(convo, done({ task: r.task, reason: r.reason }));

    const text = lastUser(body).slice(0, 2000);
    if (!text) return done({ task: GENERAL, route: "auto", reason: "default" });
    const centroids = await this.ensureCentroids().catch(() => undefined);
    if (!centroids) return done({ task: GENERAL, route: "auto", reason: "embedder-unavailable" });
    const res = await this.embedder.embed([text], 150);
    if (!res) return done({ task: GENERAL, route: "auto", reason: "embedder-unavailable" });
    const v = res.vectors[0]!;
    const scores: Record<string, number> = {};
    for (const [task, c] of centroids) scores[task] = Math.round(cosine(v, c) * 1000) / 1000;
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    const def = cfg.tasks.find((t) => t.name === best?.[0]);
    if (best && def && best[1] >= def.threshold && best[1] - (second?.[1] ?? 0) >= cfg.margin) {
      return this.stick(convo, done({ task: best[0], score: best[1], reason: "embedding", scores }));
    }
    return done({ task: GENERAL, route: "auto", score: best?.[1], reason: "below-threshold", scores });
  }

  private stick(convo: string, d: TaskDecision): TaskDecision {
    this.sticky.set(convo, { task: d.task, until: this.clock() + this.getCfg().stickyMinutes * 60_000 });
    if (this.sticky.size > 5000) {
      const now = this.clock();
      for (const [k, v] of this.sticky) if (v.until < now) this.sticky.delete(k);
    }
    return d;
  }
}
