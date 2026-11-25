import { api, type Config, type Usage } from "../api";

function ago(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function Bar({ used, limit }: { used: number; limit?: number }) {
  if (!limit) return <span className="muted">{used}</span>;
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <div className="bar" title={`${used} / ${limit}`}>
      <div className={pct > 85 ? "hot" : ""} style={{ width: `${pct}%` }} />
      <span>{used} / {limit}</span>
    </div>
  );
}

export default function Dashboard({ config, usage, onGo }: { config: Config; usage: Usage | null; onGo: (t: "Providers") => void }) {
  const now = usage?.now ?? Date.now();
  const rows = Object.entries(usage?.targets ?? {}).sort((a, b) => (b[1].lastUsedAt ?? 0) - (a[1].lastUsedAt ?? 0));
  const totals = rows.reduce((t, [, s]) => ({ req: t.req + s.requestsToday, tok: t.tok + s.tokensToday, fail: t.fail + s.failures }), { req: 0, tok: 0, fail: 0 });
  const events = usage?.events ?? [];
  const fallbacks = events.filter((e) => e.ok && e.attempts.length > 1).length;
  const noKeys = config.providers.filter((p) => p.kind === "cloud" && p.enabled && !p.apiKey);

  return (
    <section>
      <header className="page-head">
        <h1>Dashboard</h1>
        <button className="ghost" onClick={() => api.resetUsage()}>Reset counters</button>
      </header>

      {noKeys.length > 0 && (
        <div className="banner info" onClick={() => onGo("Providers")}>
          Add free API keys for {noKeys.map((p) => p.name.split(" ")[0]).join(", ")} to unlock more fallback capacity →
        </div>
      )}

      <div className="cards">
        <div className="card"><span>Requests today</span><strong>{totals.req}</strong></div>
        <div className="card"><span>Tokens today</span><strong>{totals.tok.toLocaleString()}</strong></div>
        <div className="card"><span>Saved by fallback</span><strong>{fallbacks}</strong><em>of last {events.length}</em></div>
        <div className="card"><span>Cost</span><strong>$0.00</strong><em>free tiers only</em></div>
      </div>

      <h2>Quota by model</h2>
      {rows.length === 0 ? (
        <p className="muted">No traffic yet. Point a tool at <code>http://127.0.0.1:4141/v1</code> or try the Chat tab.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Target</th><th>Last min</th><th>Today</th><th>Tokens</th><th>Latency</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map(([key, s]) => {
              const [pid, ...m] = key.split("/");
              const p = config.providers.find((x) => x.id === pid);
              const lim = p?.modelLimits?.[m.join("/")] ?? p?.limits;
              const pc = usage?.providerCooldowns[pid!];
              const cooling = (pc && pc.until > now) || (s.cooldownUntil && s.cooldownUntil > now);
              const until = Math.max(pc?.until ?? 0, s.cooldownUntil ?? 0);
              return (
                <tr key={key}>
                  <td><code>{key}</code></td>
                  <td><Bar used={s.recent.length} limit={lim?.rpm} /></td>
                  <td><Bar used={s.requestsToday} limit={lim?.rpd} />{s.remainingRequests !== undefined && <small className="muted"> · {s.remainingRequests} left (provider)</small>}</td>
                  <td>{s.tokensToday.toLocaleString()}</td>
                  <td>{s.avgLatencyMs ? `${s.avgLatencyMs} ms` : "—"}</td>
                  <td>
                    {cooling ? (
                      <span className="pill warn" title={pc?.reason ?? s.lastError}>cooling {ago(until - now)}</span>
                    ) : s.lastStatus && s.lastStatus !== 200 ? (
                      <span className="pill bad" title={s.lastError}>HTTP {s.lastStatus || "net"}</span>
                    ) : (
                      <span className="pill good">ready</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Recent requests</h2>
      <ul className="events">
        {events.slice(0, 15).map((e, i) => (
          <li key={i} className={e.ok ? "" : "failed"}>
            <span className="muted">{new Date(e.at).toLocaleTimeString()}</span>
            <code>{e.requested}</code>→<code>{e.served ?? "none"}</code>
            <span className="muted">{e.ms} ms{e.stream ? " · stream" : ""}</span>
            {e.attempts.length > 1 && (
              <span className="trail" title={e.attempts.map((a) => `${a.target}: ${a.outcome}${a.status ? ` ${a.status}` : ""}${a.reason ? ` (${a.reason})` : ""}`).join("\n")}>
                {e.attempts.length - 1} fallback{e.attempts.length > 2 ? "s" : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
