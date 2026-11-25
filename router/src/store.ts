// JSON persistence in ~/Library/Application Support/openfocairouter (or $OFR_DATA_DIR).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  if (process.env.OFR_DATA_DIR) return process.env.OFR_DATA_DIR;
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "openfocairouter");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "openfocairouter");
}

export function readJson<T>(file: string): T | undefined {
  const path = join(dataDir(), file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    console.error(`[ofr] could not parse ${path}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Atomic write; files holding secrets are owner-read/write only (0600). */
export function writeJson(file: string, value: unknown, secret = false) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, file);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: secret ? 0o600 : 0o644 });
  renameSync(tmp, path);
  if (secret) chmodSync(path, 0o600);
}
