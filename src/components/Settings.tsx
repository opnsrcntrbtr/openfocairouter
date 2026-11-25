import { useEffect, useState } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { api, baseUrl, inApp, type Config, type TaskDecision } from "../api";

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head"><strong>{title}</strong><button className="ghost" onClick={() => navigator.clipboard.writeText(code)}>Copy</button></div>
      <pre>{code}</pre>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></span>
      <span><strong>{label}</strong>{hint && <span className="muted small"> — {hint}</span>}</span>
    </label>
  );
}

function ClassifierTest() {
  const [text, setText] = useState("");
  const [d, setD] = useState<TaskDecision | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <div className="row">
        <input placeholder="Type a prompt to see which task and route it gets" value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={!text.trim()} onClick={() => api.classify(text).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(String(e)))}>Test classifier</button>
      </div>
      {err && <p className="small bad">{err}</p>}
      {d && (
        <p className="small mono">
          → task <strong>{d.task}</strong> · route <code>{d.route}</code> · {d.reason}{d.score !== undefined ? ` · score ${d.score}` : ""} · {d.ms} ms
          {d.scores && <><br />{Object.entries(d.scores).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}</>}
        </p>
      )}
    </div>
  );
}

export default function Settings({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const [login, setLogin] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const url = `${baseUrl()}/v1`;
  const tr = config.taskRouting;

  useEffect(() => {
    if (inApp()) isEnabled().then(setLogin).catch(() => setLogin(null));
  }, []);

  const setTask = (name: string, patch: Partial<Config["taskRouting"]["tasks"][number]>) =>
    onSave({ ...config, taskRouting: { ...tr, tasks: tr.tasks.map((t) => (t.name === name ? { ...t, ...patch } : t)) } });

  return (
    <section>
      <header className="page-head"><h1>Settings</h1></header>

      <div className="provider">
        <h2>App</h2>
        {login !== null ? (
          <Toggle label="Launch at login" hint="starts hidden in the menu bar" checked={login} onChange={async (v) => { await (v ? enable() : disable()); setLogin(await isEnabled()); }} />
        ) : (
          <p className="muted small">Launch at login is available in the desktop app.</p>
        )}
        <div className="row">
          <label className="small">Default route{" "}
            <select value={config.defaultRoute} onChange={(e) => onSave({ ...config, defaultRoute: e.target.value })}>
              {config.routes.map((r) => <option key={r.name}>{r.name}</option>)}
            </select>
          </label>
          <label className="small">Upstream timeout (s){" "}
            <input className="num" type="number" min={5} value={config.requestTimeoutMs / 1000} onChange={(e) => onSave({ ...config, requestTimeoutMs: Math.max(5, Number(e.target.value)) * 1000 })} />
          </label>
        </div>
      </div>

      <div className="provider">
        <h2>Task routing</h2>
        <p className="muted small">
          <code>auto:task</code> always classifies each request (rules first, then local embeddings from oMLX or Ollama) and sends it to a task route.
          Turn this on to classify plain <code>auto</code> requests too. Prompts never leave your Mac for classification.
        </p>
        <Toggle label="Classify requests for model “auto”" checked={tr.enabled} onChange={(v) => onSave({ ...config, taskRouting: { ...tr, enabled: v } })} />
        <div className="row">
          <label className="small">Embedder{" "}
            <input value={tr.embedder} placeholder="auto (oMLX, then Ollama)" onChange={(e) => onSave({ ...config, taskRouting: { ...tr, embedder: e.target.value.trim() } })} />
          </label>
          <label className="small">Sticky (min) <input className="num" type="number" min={0} value={tr.stickyMinutes} onChange={(e) => onSave({ ...config, taskRouting: { ...tr, stickyMinutes: Number(e.target.value) } })} /></label>
          <label className="small">Long-context above (tokens) <input className="num" type="number" min={1000} value={tr.longContextTokens} onChange={(e) => onSave({ ...config, taskRouting: { ...tr, longContextTokens: Number(e.target.value) } })} /></label>
        </div>
        <table className="compact">
          <thead><tr><th>Task</th><th>Route</th><th>Threshold</th><th>Examples</th></tr></thead>
          <tbody>
            {tr.tasks.map((t) => (
              <tr key={t.name}>
                <td><code>{t.name}</code></td>
                <td>
                  <select value={t.route} onChange={(e) => setTask(t.name, { route: e.target.value })}>
                    {config.routes.map((r) => <option key={r.name}>{r.name}</option>)}
                  </select>
                </td>
                <td><input className="num" type="number" step={0.05} min={0} max={1} value={t.threshold} onChange={(e) => setTask(t.name, { threshold: Number(e.target.value) })} /></td>
                <td>
                  {editing === t.name ? (
                    <textarea rows={6} className="examples" defaultValue={t.examples.join("\n")} onBlur={(e) => { setTask(t.name, { examples: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) }); setEditing(null); }} />
                  ) : (
                    <button className="ghost" onClick={() => setEditing(t.name)}>{t.examples.length} examples · edit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Images always go to <code>vision</code>; prompts with no confident match go to <code>auto</code>.</p>
        <ClassifierTest />
      </div>

      <div className="provider">
        <h2>Cache</h2>
        <Toggle label="Exact-match cache" hint={`temperature ≤ ${config.cache.maxTemperature}, no tool results; hits use no provider quota`} checked={config.cache.exact} onChange={(v) => onSave({ ...config, cache: { ...config.cache, exact: v } })} />
        <Toggle label="Allow semantic cache" hint="single-turn prompts, local embeddings; enable per client on the Clients tab" checked={config.cache.semantic} onChange={(v) => onSave({ ...config, cache: { ...config.cache, semantic: v } })} />
        <div className="row">
          <label className="small">TTL (hours) <input className="num" type="number" min={1} value={config.cache.ttlHours} onChange={(e) => onSave({ ...config, cache: { ...config.cache, ttlHours: Number(e.target.value) } })} /></label>
          <label className="small">Max size (MB) <input className="num" type="number" min={16} value={config.cache.maxMb} onChange={(e) => onSave({ ...config, cache: { ...config.cache, maxMb: Number(e.target.value) } })} /></label>
          <button className="ghost" onClick={() => api.purgeCache()}>Purge cache</button>
        </div>
      </div>

      <div className="provider">
        <h2>Request log</h2>
        <Toggle label="Keep prompts and responses" hint="off by default; enables full-text search in Logs" checked={config.logging.bodies} onChange={(v) => onSave({ ...config, logging: { ...config.logging, bodies: v } })} />
        <label className="small">Keep bodies for (days) <input className="num" type="number" min={1} max={90} value={config.logging.retentionDays} onChange={(e) => onSave({ ...config, logging: { ...config.logging, retentionDays: Math.min(90, Math.max(1, Number(e.target.value))) } })} /></label>
      </div>

      <div className="provider">
        <h2>Claude model names → routes</h2>
        <p className="muted small">For <code>/v1/messages</code>: a requested model containing the text on the left uses the route on the right.</p>
        <div className="row">
          {Object.entries(config.anthropic.modelMap).map(([sub, route]) => (
            <label key={sub} className="small"><code>{sub}</code> →{" "}
              <select value={route} onChange={(e) => onSave({ ...config, anthropic: { modelMap: { ...config.anthropic.modelMap, [sub]: e.target.value } } })}>
                {[...config.routes.map((r) => r.name), "auto:task"].map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>

      <h2>Connect your tools</h2>
      <p className="muted small">Create a key per tool on the Clients tab and use it below in place of <code>$OFR_KEY</code>.</p>
      <Snippet title="Claude Code (Anthropic API)" code={`export ANTHROPIC_BASE_URL=${baseUrl()}\nexport ANTHROPIC_AUTH_TOKEN=$OFR_KEY\nclaude   # sonnet → coding route, haiku → fast, opus → reasoning`} />
      <Snippet title="curl" code={`curl ${url}/chat/completions \\\n  -H "Authorization: Bearer $OFR_KEY" -H "Content-Type: application/json" \\\n  -d '{"model":"auto:task","messages":[{"role":"user","content":"Hello"}]}'`} />
      <Snippet title="OpenAI SDK (TypeScript / Python)" code={`const client = new OpenAI({ baseURL: "${url}", apiKey: process.env.OFR_KEY });\n# Python: OpenAI(base_url="${url}", api_key=os.environ["OFR_KEY"])\n# model: "auto" | "auto:task" | "coding" | "fast" | "local" | "groq/llama-3.3-70b-versatile"`} />
      <Snippet title="Embeddings" code={`curl ${url}/embeddings -H "Authorization: Bearer $OFR_KEY" -H "Content-Type: application/json" \\\n  -d '{"model":"embed","input":["first text","second text"]}'`} />
      <Snippet title="Continue / Cline / Cursor / aider" code={`Base URL: ${url}\nAPI key:  $OFR_KEY\nModel:    auto:task\n\n# aider\naider --openai-api-base ${url} --openai-api-key $OFR_KEY --model openai/coding`} />
    </section>
  );
}
