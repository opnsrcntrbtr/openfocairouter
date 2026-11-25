import { useEffect, useState } from "react";
import { api, getClientKey, setSecret, type ClientView, type Config } from "../api";

function KeyReveal({ k, onClose }: { k: string; onClose: () => void }) {
  return (
    <div className="banner info keybox">
      <strong>Copy this key now.</strong> It is shown once and saved to your Keychain.
      <div className="row">
        <code className="grow mono">{k}</code>
        <button onClick={() => navigator.clipboard.writeText(k)}>Copy</button>
        <button className="ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString();

export default function Clients({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const [clients, setClients] = useState<ClientView[]>([]);
  const [name, setName] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [rpm, setRpm] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.clients().then((r) => setClients(r.clients)).catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const create = async () => {
    const r = await api.createClient({ name, localOnly, limits: rpm ? { rpm: Number(rpm) } : undefined });
    await setSecret(`client:${r.client.id}`, r.key).catch(() => {});
    setRevealed(r.key);
    setName("");
    setRpm("");
    setLocalOnly(false);
    load();
  };

  const update = (id: string, patch: Partial<NonNullable<ClientView["config"]>>) =>
    onSave({ ...config, clients: config.clients.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  return (
    <section>
      <header className="page-head">
        <h1>Clients</h1>
        <p className="muted">
          Give each tool its own key to see who uses what and to set limits. Tools without a key are grouped by an <code>X-OFR-Client</code> header or
          their User-Agent.
        </p>
      </header>
      {err && <div className="banner error" onClick={() => setErr(null)}>{err}</div>}
      {revealed && <KeyReveal k={revealed} onClose={() => setRevealed(null)} />}

      <div className="provider">
        <strong>New client key</strong>
        <div className="row">
          <input placeholder="Name, e.g. Cursor, aider, Claude Code" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="small">RPM limit <input className="num" type="number" min={0} value={rpm} onChange={(e) => setRpm(e.target.value)} /></label>
          <label className="small"><input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} /> Local models only</label>
          <button disabled={!name.trim()} onClick={create}>Create key</button>
        </div>
        <label className="small row">
          <input type="checkbox" checked={config.requireClientKeys} onChange={(e) => onSave({ ...config, requireClientKeys: e.target.checked })} />
          Require client keys (reject requests without a valid key)
        </label>
      </div>

      <table>
        <thead>
          <tr><th>Client</th><th>Requests (30d)</th><th>Tokens in / out</th><th>Fallbacks</th><th>Cache hits</th><th>Errors</th><th>p50 / p95</th><th></th></tr>
        </thead>
        <tbody>
          {clients.length === 0 && <tr><td colSpan={8} className="muted">No clients yet.</td></tr>}
          {clients.map((c) => (
            <tr key={c.id} className={c.config && !c.config.enabled ? "off" : ""}>
              <td>
                <strong>{c.name}</strong> <span className="pill">{c.kind}</span>
                {c.config?.localOnly && <span className="pill local">local only</span>}
                {c.config && <div className="muted small mono">{c.config.keyPrefix}…{c.config.limits?.rpm ? ` · ${c.config.limits.rpm} RPM` : ""}</div>}
              </td>
              <td>{fmt(c.totals30d.requests)}</td>
              <td>{fmt(c.totals30d.promptTokens)} / {fmt(c.totals30d.completionTokens)}</td>
              <td>{fmt(c.totals30d.fallbacks)}</td>
              <td>{fmt(c.totals30d.cacheHits)}</td>
              <td>{fmt(c.totals30d.errors)}</td>
              <td>{c.latency7d ? `${c.latency7d.p50} / ${c.latency7d.p95} ms` : "—"}</td>
              <td className="actions">
                {c.config && (
                  <>
                    <button className="icon" title="Copy key from Keychain" onClick={async () => { const k = await getClientKey(c.id); if (k) navigator.clipboard.writeText(k); else setErr("Key not in the Keychain. Rotate it to get a new one."); }}>⧉</button>
                    <button className="icon" title={c.config.enabled ? "Disable" : "Enable"} onClick={() => update(c.id, { enabled: !c.config!.enabled })}>{c.config.enabled ? "⏸" : "▶"}</button>
                    <button className="icon" title="Semantic cache" onClick={() => update(c.id, { semanticCache: !c.config!.semanticCache })}>{c.config.semanticCache ? "≈✓" : "≈"}</button>
                    <button className="icon" title="Rotate key" onClick={async () => { const r = await api.rotateClient(c.id); await setSecret(`client:${c.id}`, r.key).catch(() => {}); setRevealed(r.key); }}>↻</button>
                    <button className="icon" title="Revoke" onClick={async () => { if (confirm(`Revoke ${c.name}? Tools using this key stop working.`)) { await api.deleteClient(c.id); await setSecret(`client:${c.id}`, null).catch(() => {}); load(); } }}>✕</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
