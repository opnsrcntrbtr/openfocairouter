// Shared local embedder for task classification and the semantic cache.
// Only local providers are ever used here, so routing never sends prompts to the cloud.
import { isEmbeddingModel, parseTarget } from "./config";
import { providerUrl, type Router } from "./router";

export interface EmbedResult {
  model: string; // "provider/model" that produced the vectors
  vectors: Float32Array[];
}

const LOCAL_ORDER = ["omlx", "ollama", "lmstudio"];

export class Embedder {
  private resolved: { target: string; at: number } | undefined;

  constructor(
    private router: Router,
    private clock: () => number = Date.now,
    private fetchImpl: (i: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init),
  ) {}

  /** Pick the embedding target: configured one, else first local provider serving an embedding model. */
  async target(): Promise<string | undefined> {
    const cfg = this.router.config();
    if (cfg.taskRouting.embedder) return cfg.taskRouting.embedder;
    if (this.resolved && this.clock() - this.resolved.at < 60_000) return this.resolved.target;
    for (const id of LOCAL_ORDER) {
      const p = this.router.provider(id);
      if (!p || !p.enabled || p.kind !== "local") continue;
      try {
        const models = await this.router.listModels(id);
        const m = models.find((x) => isEmbeddingModel(p, x));
        if (m) {
          this.resolved = { target: `${id}/${m}`, at: this.clock() };
          return this.resolved.target;
        }
      } catch {
        /* not running */
      }
    }
    this.resolved = undefined;
    return undefined;
  }

  async embed(texts: string[], timeoutMs = 150): Promise<EmbedResult | undefined> {
    const target = await this.target();
    if (!target) return undefined;
    const t = parseTarget(target);
    const p = t && this.router.provider(t.providerId);
    if (!t || !p || p.kind !== "local") return undefined;
    try {
      const res = await this.fetchImpl(providerUrl(p, "/embeddings"), {
        method: "POST",
        headers: this.router.authHeaders(p),
        body: JSON.stringify({ model: t.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const json: any = await res.json();
      const data: any[] = json?.data ?? [];
      const vectors = data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => normalize(Float32Array.from(d.embedding as number[])));
      return vectors.length === texts.length ? { model: target, vectors } : undefined;
    } catch {
      return undefined;
    }
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** Cosine similarity of two normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function centroid(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs[0]?.length ?? 0);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] = out[i]! + v[i]!;
  return normalize(out);
}
