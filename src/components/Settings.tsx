import { useState } from "react";
import { baseUrl, type Config } from "../api";

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head"><strong>{title}</strong><button className="ghost" onClick={() => navigator.clipboard.writeText(code)}>Copy</button></div>
      <pre>{code}</pre>
    </div>
  );
}

export default function Settings({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const [key, setKey] = useState(config.localApiKey ?? "");
  const url = `${baseUrl()}/v1`;
  const k = config.localApiKey || "ofr-local";
  return (
    <section>
      <header className="page-head"><h1>Settings</h1></header>

      <div className="provider">
        <strong>Endpoint</strong>
        <p><code>{url}</code> — loopback only, never exposed to your network.</p>
        <label className="small">Default route{" "}
          <select value={config.defaultRoute} onChange={(e) => onSave({ ...config, defaultRoute: e.target.value })}>
            {config.routes.map((r) => <option key={r.name}>{r.name}</option>)}
          </select>
        </label>{" "}
        <label className="small">Upstream timeout (s){" "}
          <input className="num" type="number" min={5} value={config.requestTimeoutMs / 1000} onChange={(e) => onSave({ ...config, requestTimeoutMs: Math.max(5, Number(e.target.value)) * 1000 })} />
        </label>
      </div>

      <div className="provider">
        <strong>Local API key (optional)</strong>
        <p className="muted small">If set, every client must send it as a Bearer token. Leave empty to allow any local app.</p>
        <div className="row">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. ofr-local-123" />
          <button onClick={() => onSave({ ...config, localApiKey: key.trim() || undefined })}>Save</button>
          <button className="ghost" onClick={() => setKey("ofr-" + crypto.randomUUID().slice(0, 18))}>Generate</button>
        </div>
      </div>

      <h2>Connect your tools</h2>
      <Snippet title="curl" code={`curl ${url}/chat/completions \\\n  -H "Authorization: Bearer ${k}" -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`} />
      <Snippet title="OpenAI SDK (TypeScript / Python)" code={`const client = new OpenAI({ baseURL: "${url}", apiKey: "${k}" });\n# Python: OpenAI(base_url="${url}", api_key="${k}")\n# model="auto" | "fast" | "long-context" | "local" | "groq/llama-3.3-70b-versatile"`} />
      <Snippet title="Continue / Cline / Cursor / aider (OpenAI-compatible provider)" code={`Base URL: ${url}\nAPI key:  ${k}\nModel:    auto\n\n# aider\naider --openai-api-base ${url} --openai-api-key ${k} --model openai/auto`} />
      <Snippet title="Environment variables" code={`export OPENAI_BASE_URL=${url}\nexport OPENAI_API_KEY=${k}`} />
    </section>
  );
}
