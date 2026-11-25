// Entry point for the router sidecar (`bun run router/src/index.ts`, or the compiled binary).
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, mergeWithDefaults, type AppConfig } from "./config";
import { QuotaTracker, type UsageSnapshot } from "./quota";
import { Router } from "./router";
import { createHandler, secretsReadyFlag } from "./server";
import { dataDir, readJson, writeJson } from "./store";
import { Store } from "./db";
import { ClientLimiter, hashKey } from "./clients";
import { Embedder } from "./embedder";
import { Classifier } from "./classify";
import { ResponseCache } from "./cache";
import { Gateway } from "./gateway";
import { SecretStore, listenStdin, migrateKeysToShell, sendToShell } from "./secrets";

const VERSION = "0.2.0";
const PORT = Number(process.env.OFR_PORT ?? 4141);
const HOST = "127.0.0.1"; // loopback only: never exposed to the network
const MANAGED = process.env.OFR_SECRETS === "stdin"; // desktop app: Keychain via the Tauri shell

const raw = readJson<Partial<AppConfig> & { version?: number }>("config.json");
let config: AppConfig = mergeWithDefaults(raw ?? defaultConfig());
const secrets = new SecretStore(MANAGED);

// v0.1 → v0.2: the single local API key becomes a "default" client.
if (config.localApiKey) {
  if (!config.clients.some((c) => c.id === "default")) {
    config.clients.push({ id: "default", name: "default (v0.1 key)", keyHash: hashKey(config.localApiKey), keyPrefix: config.localApiKey.slice(0, 8), enabled: true, createdAt: Date.now() });
  }
  config.requireClientKeys = true; // v0.1 semantics: a key was required
  delete config.localApiKey;
}

if (MANAGED) {
  // Move any plaintext keys into the Keychain (via the shell), keeping a private backup.
  if (config.providers.some((p) => p.apiKey)) {
    const src = join(dataDir(), "config.json");
    const bak = join(dataDir(), "config.v1.bak");
    if (existsSync(src) && !existsSync(bak)) {
      copyFileSync(src, bak);
      chmodSync(bak, 0o600);
    }
    const r = migrateKeysToShell(config, secrets);
    config = r.config;
    console.log(`[ofr] moved ${r.migrated} provider key(s) to the Keychain`);
  }
  sendToShell({ op: "need", accounts: config.providers.filter((p) => p.kind === "cloud").map((p) => `provider:${p.id}`) });
  listenStdin(secrets, () => {
    secretsReadyFlag.ready = true;
  });
} else {
  secretsReadyFlag.ready = true;
  // Headless: keys from config.json, then env (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ...).
  for (const p of config.providers) {
    const key = p.apiKey ?? process.env[`${p.id.toUpperCase()}_API_KEY`];
    if (key) secrets.set(`provider:${p.id}`, key);
  }
}
writeJson("config.json", config, true);

// The desktop app passes a per-launch token; standalone runs persist one in the data dir.
let adminToken = process.env.OFR_ADMIN_TOKEN;
if (!adminToken) {
  const stored = readJson<{ token: string }>("admin-token.json");
  adminToken = stored?.token ?? randomBytes(24).toString("hex");
  if (!stored) writeJson("admin-token.json", { token: adminToken }, true);
}

const quota = new QuotaTracker(readJson<UsageSnapshot>("usage.json"));
const router = new Router(() => config, quota, undefined, undefined, secrets);
const store = new Store(process.env.OFR_DB ?? join(dataDir(), "ofr.db"));
const embedder = new Embedder(router);
const classifier = new Classifier(embedder, () => config.taskRouting);
const cache = new ResponseCache(store, embedder, () => config.cache);
const limiter = new ClientLimiter();
const gateway = new Gateway({ router, classifier, cache, store, limiter, getConfig: () => config, adminToken });

const handler = createHandler({
  router, gateway, classifier, cache, store, secrets, adminToken, version: VERSION,
  getConfig: () => config,
  saveConfig: (next) => {
    config = next;
    writeJson("config.json", config, true);
  },
});

setInterval(() => {
  if (quota.takeDirty()) writeJson("usage.json", quota.snapshot());
}, 5_000);
setInterval(() => store.prune(config.logging.retentionDays), 60 * 60_000);
store.prune(config.logging.retentionDays);
if (config.taskRouting.enabled) setTimeout(() => classifier.warm(), 1500);

const flush = () => {
  writeJson("usage.json", quota.snapshot());
  store.close();
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
console.log(`[ofr] OpenFOC AI Router ${VERSION} on http://${HOST}:${PORT}/v1  (data: ${dataDir()}, secrets: ${MANAGED ? "Keychain" : "file/env"})`);
if (!process.env.OFR_ADMIN_TOKEN) console.log(`[ofr] admin token for the UI in dev: ${adminToken}`);
