import { useState } from "react";
import type { Config, Route, Strategy, Usage } from "../api";

function RouteEditor({ route, config, usage, onChange, onDelete }: { route: Route; config: Config; usage: Usage | null; onChange: (r: Route) => void; onDelete: () => void }) {
  const [add, setAdd] = useState("");
  const move = (i: number, d: number) => {
    const t = [...route.targets];
    const j = i + d;
    if (j < 0 || j >= t.length) return;
    [t[i], t[j]] = [t[j]!, t[i]!];
    onChange({ ...route, targets: t });
  };
  const status = (target: string) => {
    const p = config.providers.find((x) => x.id === target.split("/")[0]);
    if (!p) return { cls: "bad", text: "unknown provider" };
    if (!p.enabled) return { cls: "warn", text: "disabled" };
    if (p.kind === "cloud" && !p.apiKey) return { cls: "warn", text: "no key" };
    return { cls: "good", text: p.kind === "local" ? "local" : "ready" };
  };
  return (
    <div className="provider">
      <div className="provider-head">
        <div className="grow">
          <strong><code>{route.name}</code></strong>
          {config.defaultRoute === route.name && <span className="pill good">default</span>}
          <input className="desc" value={route.description} onChange={(e) => onChange({ ...route, description: e.target.value })} />
        </div>
        <label className="small">Strategy{" "}
          <select value={route.strategy ?? "ordered"} onChange={(e) => onChange({ ...route, strategy: e.target.value as Strategy })}>
            <option value="ordered">ordered (as listed)</option>
            <option value="latency">latency (fastest first)</option>
            <option value="balanced">balanced (spread quota)</option>
          </select>
        </label>
        {route.name !== config.defaultRoute && <button className="ghost" onClick={onDelete}>Delete</button>}
      </div>
      <ol className="chain">
        {route.targets.map((t, i) => {
          const s = status(t);
          const sc = usage?.scores?.[t];
          const local = config.providers.find((x) => x.id === t.split("/")[0])?.kind === "local";
          const tier = route.tiers?.[t] ?? (local ? 1 : 0);
          return (
            <li key={t + i}>
              <code>{t}</code>
              <span className={`pill ${s.cls}`}>{s.text}</span>
              {sc && sc.samples > 0 && (
                <span className="muted small"> {sc.ewmaMs ?? "—"} ms · {Math.round(sc.errorRate * 100)}% errors</span>
              )}
              <span className="grow" />
              {(route.strategy ?? "ordered") !== "ordered" && (
                <label className="small muted" title="Targets are only reordered within the same tier. Lower tiers are tried first.">
                  tier <input className="num tiny" type="number" min={0} max={9} value={tier}
                    onChange={(e) => onChange({ ...route, tiers: { ...(route.tiers ?? {}), [t]: Number(e.target.value) } })} />
                </label>
              )}
              <button className="icon" onClick={() => move(i, -1)} title="Move up">↑</button>
              <button className="icon" onClick={() => move(i, 1)} title="Move down">↓</button>
              <button className="icon" onClick={() => onChange({ ...route, targets: route.targets.filter((_, k) => k !== i) })} title="Remove">✕</button>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <input placeholder="provider/model, e.g. groq/llama-3.3-70b-versatile or ollama/*" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add.includes("/") && (onChange({ ...route, targets: [...route.targets, add.trim()] }), setAdd(""))} />
        <button disabled={!add.includes("/")} onClick={() => { onChange({ ...route, targets: [...route.targets, add.trim()] }); setAdd(""); }}>Add target</button>
      </div>
    </div>
  );
}

export default function Routes({ config, usage, onSave }: { config: Config; usage: Usage | null; onSave: (c: Config) => void }) {
  const [name, setName] = useState("");
  const set = (i: number, r: Route) => onSave({ ...config, routes: config.routes.map((x, k) => (k === i ? r : x)) });
  return (
    <section>
      <header className="page-head">
        <h1>Routes</h1>
        <p className="muted">
          Clients send a route name as <code>model</code> (e.g. <code>auto</code>). The router tries each target in order and moves on when one is
          rate-limited, down, out of quota or its model is gone. <code>provider/*</code> uses the first installed chat model. With task routing, <code>auto:task</code> picks a route per request (see Settings). You can also call any
          <code> provider/model</code> directly.
        </p>
      </header>
      {config.routes.map((r, i) => (
        <RouteEditor key={r.name} route={r} config={config} usage={usage} onChange={(nr) => set(i, nr)} onDelete={() => onSave({ ...config, routes: config.routes.filter((_, k) => k !== i) })} />
      ))}
      <div className="row">
        <input placeholder="new route name, e.g. coding" value={name} onChange={(e) => setName(e.target.value.replace(/[^\w.-]/g, ""))} />
        <button disabled={!name || config.routes.some((r) => r.name === name)} onClick={() => { onSave({ ...config, routes: [...config.routes, { name, description: "", targets: [] }] }); setName(""); }}>New route</button>
      </div>
    </section>
  );
}
