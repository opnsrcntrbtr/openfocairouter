// Entry point for the router sidecar (`bun run router/src/index.ts`, or the compiled binary).
import { randomBytes } from "node:crypto";
import { defaultConfig, mergeWithDefaults, type AppConfig } from "./config";
import { QuotaTracker, type UsageSnapshot } from "./quota";
import { Router } from "./router";
import { createHandler } from "./server";
import { dataDir, readJson, writeJson } from "./store";

const VERSION = "0.1.0";
const PORT = Number(process.env.OFR_PORT ?? 4141);
const HOST = "127.0.0.1"; // loopback only: never exposed to the network

let config: AppConfig = mergeWithDefaults(readJson<AppConfig>("config.json") ?? defaultConfig());
writeJson("config.json", config, true);

// Env overrides so the router also works headless: GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ...
for (const p of config.providers) {
  const env = process.env[`${p.id.toUpperCase()}_API_KEY`];
  if (env && !p.apiKey) p.apiKey = env;
}

// The desktop app passes a per-launch token; standalone runs persist one in the data dir.
let adminToken = process.env.OFR_ADMIN_TOKEN;
if (!adminToken) {
  const stored = readJson<{ token: string }>("admin-token.json");
  adminToken = stored?.token ?? randomBytes(24).toString("hex");
  if (!stored) writeJson("admin-token.json", { token: adminToken }, true);
}

const quota = new QuotaTracker(readJson<UsageSnapshot>("usage.json"));
const router = new Router(() => config, quota);

const handler = createHandler({
  router,
  version: VERSION,
  adminToken,
  getConfig: () => config,
  saveConfig: (next) => {
    config = next;
    writeJson("config.json", config, true);
  },
});

setInterval(() => {
  if (quota.takeDirty()) writeJson("usage.json", quota.snapshot());
}, 5_000);

const flush = () => {
  writeJson("usage.json", quota.snapshot());
  process.exit(0);
};
process.on("SIGINT", flush);
process.on("SIGTERM", flush);

try {
  Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 255, fetch: handler });
} catch (e) {
  console.error(`[ofr] could not listen on ${HOST}:${PORT}: ${(e as Error).message}`);
  process.exit(1);
}
console.log(`[ofr] OpenFOC AI Router ${VERSION} on http://${HOST}:${PORT}/v1  (data: ${dataDir()})`);
if (!process.env.OFR_ADMIN_TOKEN) console.log(`[ofr] admin token for the UI in dev: ${adminToken}`);
