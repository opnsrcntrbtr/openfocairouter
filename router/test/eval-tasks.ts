// Classifier eval against your live local embedder (oMLX or Ollama).
// Usage: bun run eval:tasks   (reads ~/Library/Application Support/openfocairouter/config.json if present)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, mergeWithDefaults, type AppConfig } from "../src/config";
import { QuotaTracker } from "../src/quota";
import { Router } from "../src/router";
import { Embedder } from "../src/embedder";
import { Classifier, GENERAL } from "../src/classify";
import { readJson } from "../src/store";

const cfg: AppConfig = mergeWithDefaults(readJson<AppConfig>("config.json") ?? defaultConfig());
const router = new Router(() => cfg, new QuotaTracker());
const embedder = new Embedder(router);
const classifier = new Classifier(embedder, () => cfg.taskRouting);

const rows = readFileSync(join(import.meta.dir, "fixtures", "tasks.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { task: string; text: string });

const target = await embedder.target();
if (!target) {
  console.error("No local embedding model found. Start oMLX (with an embedding model) or `ollama pull nomic-embed-text`.");
  process.exit(1);
}
console.log(`Embedder: ${target}\n`);

const confusion: Record<string, Record<string, number>> = {};
let correct = 0;
const times: number[] = [];
for (const [i, r] of rows.entries()) {
  // Each prompt as a fresh conversation (unique client id disables stickiness between rows).
  const d = await classifier.classify({ messages: [{ role: "user", content: r.text }] }, { clientId: `eval-${i}` });
  if (d.reason === "embedding" || d.reason === "below-threshold") times.push(d.ms);
  const got = d.task === GENERAL ? "general" : d.task;
  (confusion[r.task] ??= {})[got] = (confusion[r.task]![got] ?? 0) + 1;
  if (got === r.task) correct++;
  else console.log(`✗ [${r.task} → ${got} via ${d.reason}${d.score !== undefined ? ` ${d.score}` : ""}] ${r.text.slice(0, 80)}`);
}
times.sort((a, b) => a - b);
const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
console.log(`\nAccuracy: ${correct}/${rows.length} = ${((100 * correct) / rows.length).toFixed(1)}%  (target ≥ 85%)`);
console.log(`Embedding classification latency p95: ${p95} ms  (target < 60 ms)\n`);
console.table(confusion);
process.exit(correct / rows.length >= 0.85 ? 0 : 2);
