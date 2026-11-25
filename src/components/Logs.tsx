import { useEffect, useState } from "react";
import { api, type Config, type LogRow } from "../api";

function curlFor(row: LogRow): string {
  const path = row.api === "anthropic" ? "/v1/messages" : row.api === "embeddings" ? "/v1/embeddings" : "/v1/chat/completions";
  const body = (row.requestBody ?? "{}").replace(/'/g, "'\\''");
  return `curl http://127.0.0.1:4141${path} -H "Content-Type: application/json" -H "Authorization: Bearer $OFR_KEY" -d '${body}'`;
}

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const [row, setRow] = useState<LogRow | null>(null);
  useEffect(() => { api.log(id).then(setRow); }, [id]);
  if (!row) return null;
  return (
    <div className="drawer">
      <div className="page-head">
        <h2>Request #{row.id}</h2>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      <p className="small muted">
        {new Date(row.ts).toLocaleString()} · {row.api} · client <code>{row.client}</code> · asked for <code>{row.requested}</code>
        {row.task && <> · task <code>{row.task}</code> ({row.taskReason}{row.taskScore != null ? `, ${row.taskScore}` : ""})</>}
      </p>
      <h3>Attempt timeline</h3>
      <ol className="timeline">
        {row.cache && row.cache !== "miss" && <li className="ok"><code>cache</code> {row.cache}</li>}
        {row.attempts.map((a, i) => (
          <li key={i} className={a.outcome}>
            <code>{a.target}</code> <span className={`pill ${a.outcome === "ok" ? "good" : a.outcome === "failed" ? "bad" : "warn"}`}>{a.outcome}{a.status ? ` ${a.status}` : ""}</span>
            {a.ms !== undefined && <span className="muted small"> {a.ms} ms</span>}
            {a.reason && <div className="muted small mono">{a.reason}</div>}
          </li>
        ))}
      </ol>
      <p className="small">
        Status {row.status} · TTFB {row.ttfbMs ?? "—"} ms · total {row.ms} ms · tokens {row.promptTokens ?? 0} in / {row.completionTokens ?? 0} out
      </p>
      {row.error && <div className="banner error">{row.error}</div>}
      {row.requestBody ? (
        <>
          <h3>Request</h3>
          <pre className="body">{row.requestBody}</pre>
          <h3>Response</h3>
          <pre className="body">{row.responseBody ?? ""}</pre>
          <button className="ghost" onClick={() => navigator.clipboard.writeText(curlFor(row))}>Copy as curl (no keys)</button>
        </>
      ) : (
        <p className="muted small">Bodies aren't stored. Turn on "Keep prompts and responses" in Settings to see them here.</p>
      )}
    </div>
  );
}

export default function Logs({ config }: { config: Config }) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [f, setF] = useState({ client: "", route: "", task: "", status: "", q: "" });
  const [open, setOpen] = useState<number | null>(null);

  const load = () => api.logs({ ...f, limit: 200 }).then((r) => setRows(r.logs)).catch(() => {});
  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [f]);

  const exportJsonl = () => {
    const blob = new Blob([rows.map((r) => JSON.stringify(r)).join("\n")], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `openfoc-logs-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
  };

  return (
    <section>
      <header className="page-head">
        <h1>Logs</h1>
        <div className="row">
          <button className="ghost" onClick={exportJsonl}>Export JSONL</button>
          {config.logging.bodies && <button className="ghost" onClick={() => confirm("Delete all stored prompts and responses?") && api.purgeBodies()}>Purge bodies</button>}
        </div>
      </header>
      <div className="row filters">
        <input placeholder={config.logging.bodies ? "Search prompts and responses" : "Search (turn on body logging to search text)"} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <input placeholder="client" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
        <select value={f.route} onChange={(e) => setF({ ...f, route: e.target.value })}>
          <option value="">all routes</option>
          {config.routes.map((r) => <option key={r.name}>{r.name}</option>)}
        </select>
        <select value={f.task} onChange={(e) => setF({ ...f, task: e.target.value })}>
          <option value="">all tasks</option>
          {["coding", "reasoning", "long-context", "quick", "vision", "general"].map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">all</option><option value="ok">ok</option><option value="error">errors</option>
        </select>
      </div>
      <table className="logs">
        <thead><tr><th>Time</th><th>Client</th><th>API</th><th>Asked</th><th>Task</th><th>Served by</th><th>Status</th><th>ms</th><th>Tokens</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={9} className="muted">No requests match.</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} onClick={() => setOpen(r.id)} className="clickable">
              <td className="muted">{new Date(r.ts).toLocaleTimeString()}</td>
              <td>{r.client}</td>
              <td>{r.api}</td>
              <td><code>{r.requested}</code></td>
              <td>{r.task ?? ""}</td>
              <td>
                <code>{r.served ?? "—"}</code>
                {r.cache && r.cache !== "miss" && <span className="pill good">{r.cache}</span>}
                {r.attempts.filter((a) => a.outcome === "failed").length > 0 && <span className="pill warn">{r.attempts.filter((a) => a.outcome === "failed").length} failed</span>}
              </td>
              <td><span className={`pill ${r.status < 400 ? "good" : "bad"}`}>{r.status}</span></td>
              <td>{r.ms}</td>
              <td>{(r.promptTokens ?? 0) + (r.completionTokens ?? 0) || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open !== null && <Detail id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
