import { useCallback, useEffect, useState } from "react";
import { api, init, waitForRouter, type Config, type Usage } from "./api";
import Dashboard from "./components/Dashboard";
import Providers from "./components/Providers";
import Routes from "./components/Routes";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import Clients from "./components/Clients";
import Logs from "./components/Logs";

const TABS = ["Dashboard", "Providers", "Routes", "Clients", "Logs", "Chat", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [config, setConfig] = useState<Config | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [status, setStatus] = useState<"starting" | "up" | "down">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      await init();
      if (!(await waitForRouter())) return setStatus("down");
      setStatus("up");
      try {
        setConfig(await api.config());
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    if (status !== "up") return;
    let alive = true;
    const tick = async () => {
      try {
        const u = await api.usage();
        if (alive) setUsage(u);
      } catch { /* router restarting */ }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [status]);

  const reload = useCallback(async () => {
    try {
      setConfig(await api.config());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const save = useCallback(async (next: Config) => {
    try {
      setConfig(await api.saveConfig(next));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const configured = config?.providers.filter((p) => p.enabled && (p.kind === "local" || p.apiKey)).length ?? 0;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">◆</div>
          <div>
            <strong>OpenFOC</strong>
            <span>AI Router · v0.2</span>
          </div>
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className={`status ${status}`}>
          <span className="dot" />
          {status === "up" ? `Router on :4141 · ${configured} providers ready` : status === "starting" ? "Starting router…" : "Router not reachable"}
        </div>
      </aside>
      <main>
        {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
        {status === "down" && (
          <div className="banner error">
            The router sidecar didn't start. If another app is using port 4141, quit it and reopen OpenFOC AI Router.
          </div>
        )}
        {config && tab === "Dashboard" && <Dashboard config={config} usage={usage} onGo={setTab} />}
        {config && tab === "Providers" && <Providers config={config} usage={usage} onSave={save} onReload={reload} />}
        {config && tab === "Routes" && <Routes config={config} usage={usage} onSave={save} />}
        {config && tab === "Clients" && <Clients config={config} onSave={save} />}
        {config && tab === "Logs" && <Logs config={config} />}
        {config && tab === "Chat" && <Chat config={config} />}
        {config && tab === "Settings" && <Settings config={config} onSave={save} />}
      </main>
    </div>
  );
}
