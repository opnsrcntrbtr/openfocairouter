import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, setSecret, type Config, type Provider, type Usage } from "../api";

const open = (url: string) => (isTauri() ? openUrl(url) : window.open(url, "_blank"));

const badge = { free: "Free", credits: "Credits only", local: "Local" } as const;

function ProviderCard({ p, usage, onChange, onKeyChanged }: { p: Provider; usage: Usage | null; onChange: (p: Provider) => void; onKeyChanged: () => void }) {
  const [key, setKey] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const cooldown = usage?.providerCooldowns[p.id];
  const cooling = cooldown && cooldown.until > (usage?.now ?? 0);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div className={`provider ${p.enabled ? "" : "off"}`}>
      <div className="provider-head">
        <label className="switch">
          <input type="checkbox" checked={p.enabled} onChange={(e) => onChange({ ...p, enabled: e.target.checked })} />
          <span />
        </label>
        <div className="grow">
          <strong>{p.name}</strong> <span className={`pill ${p.free}`}>{badge[p.free]}</span>
          {(p.capabilities ?? ["chat"]).map((c) => <span key={c} className="pill">{c}</span>)}
          {p.trainsOnFreeTier && <span className="pill warn" title="The free tier may use prompts to improve the provider's products">may train on prompts</span>}
          {cooling && <span className="pill warn" title={cooldown.reason}>paused</span>}
          <div className="muted small">{p.notes}</div>
        </div>
        {p.keyUrl && <a href={p.keyUrl} onClick={(e) => { e.preventDefault(); open(p.keyUrl!); }}>Get key ↗</a>}
      </div>

      {p.kind === "local" && (
        <div className="row">
          <label className="small grow">Base URL <input className="url" value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} /></label>
        </div>
      )}
      <div className="row">
        <input
          type="password"
          placeholder={p.apiKey ? `Saved in Keychain (${p.apiKey})` : p.kind === "local" ? "Optional API key (if the server requires one)" : "Paste API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button disabled={!key} onClick={async () => { await setSecret(`provider:${p.id}`, key); setKey(""); onKeyChanged(); }}>Save key</button>
        {p.apiKey && <button className="ghost" onClick={async () => { await setSecret(`provider:${p.id}`, null); onKeyChanged(); }}>Remove</button>}
      </div>

      <div className="row">
        <button className="ghost" disabled={busy} onClick={() => run(async () => {
          const r = await api.test(p.id);
          setTest(`${r.ok ? "✓" : "✗"} ${r.detail} · ${r.ms} ms`);
        })}>Test connection</button>
        <button className="ghost" disabled={busy} onClick={() => run(async () => {
          const r = await api.models(p.id, true);
          setModels(r.models);
          if (r.error) setTest(`✗ ${r.error}`);
        })}>Discover models</button>
        <label className="small">RPM <input className="num" type="number" min={0} value={p.limits?.rpm ?? ""} onChange={(e) => onChange({ ...p, limits: { ...p.limits, rpm: e.target.value ? Number(e.target.value) : undefined } })} /></label>
        <label className="small">RPD <input className="num" type="number" min={0} value={p.limits?.rpd ?? ""} onChange={(e) => onChange({ ...p, limits: { ...p.limits, rpd: e.target.value ? Number(e.target.value) : undefined } })} /></label>
        {cooling && <button className="ghost" onClick={() => api.clear(p.id)}>Resume now</button>}
      </div>
      {test && <div className="small mono">{test}</div>}
      {models && (
        <details open>
          <summary>{models.length} models available — copy one into a route</summary>
          <div className="models">
            {models.map((m) => (
              <code key={m} onClick={() => navigator.clipboard.writeText(`${p.id}/${m}`)} title="Click to copy as route target">{p.id}/{m}</code>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function Providers({ config, usage, onSave, onReload }: { config: Config; usage: Usage | null; onSave: (c: Config) => void; onReload: () => void }) {
  const update = (p: Provider) => onSave({ ...config, providers: config.providers.map((x) => (x.id === p.id ? p : x)) });
  return (
    <section>
      <header className="page-head">
        <h1>Providers</h1>
        <p className="muted">Keys are stored in your macOS Keychain and only held in memory by the router. Limits are local guards; the router also reads limits each provider reports.</p>
      </header>
      {config.providers.map((p) => (
        <ProviderCard key={p.id} p={p} usage={usage} onChange={update} onKeyChanged={() => setTimeout(onReload, 150)} />
      ))}
    </section>
  );
}
