// In-memory secret store. In the desktop app the Tauri shell owns the macOS
// Keychain and streams secrets to the router over stdin; nothing is written to
// disk by the router. Headless runs fall back to config.json / env vars.
import type { AppConfig } from "./config";

export type SecretMessage =
  | { op: "set"; account: string; value: string }
  | { op: "delete"; account: string }
  | { op: "ready" };

/** Messages the router sends to the shell on stdout (prefixed so the shell can filter them out of logs). */
export const SHELL_PREFIX = "@@ofr ";

export class SecretStore {
  private values = new Map<string, string>();
  readonly managed: boolean; // true when the Keychain (via the shell) is the source of truth

  constructor(managed: boolean) {
    this.managed = managed;
  }

  get(account: string): string | undefined {
    return this.values.get(account);
  }

  set(account: string, value: string | undefined) {
    if (value) this.values.set(account, value);
    else this.values.delete(account);
  }

  providerKey(id: string): string | undefined {
    return this.values.get(`provider:${id}`);
  }

  apply(msg: SecretMessage) {
    if (msg.op === "set") this.set(msg.account, msg.value);
    else if (msg.op === "delete") this.set(msg.account, undefined);
  }
}

/** Ask the shell to store a secret in the Keychain (used for the one-time v0.1 migration). */
export function sendToShell(msg: Record<string, unknown>) {
  process.stdout.write(SHELL_PREFIX + JSON.stringify(msg) + "\n");
}

/**
 * Move plaintext provider keys out of config into the Keychain via the shell.
 * Returns a config with keys stripped (and the caller backs up the original).
 */
export function migrateKeysToShell(cfg: AppConfig, store: SecretStore): { config: AppConfig; migrated: number } {
  let migrated = 0;
  const providers = cfg.providers.map((p) => {
    if (!p.apiKey) return p;
    store.set(`provider:${p.id}`, p.apiKey);
    sendToShell({ op: "store", account: `provider:${p.id}`, value: p.apiKey });
    migrated++;
    const { apiKey: _drop, ...rest } = p;
    return rest;
  });
  return { config: { ...cfg, providers }, migrated };
}

/** Read newline-delimited JSON secret messages from stdin for the life of the process. */
export async function listenStdin(store: SecretStore, onReady: () => void) {
  const dec = new TextDecoder();
  let buf = "";
  let readyCalled = false;
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as SecretMessage;
        store.apply(msg);
        if (msg.op === "ready" && !readyCalled) {
          readyCalled = true;
          onReady();
        }
      } catch {
        console.error("[ofr] ignored malformed stdin line");
      }
    }
  }
}
