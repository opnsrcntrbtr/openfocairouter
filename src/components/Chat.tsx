import { useRef, useState } from "react";
import { streamChat, type ChatMessage, type Config } from "../api";

interface Turn extends ChatMessage { served?: string; fallbacks?: number; error?: boolean }

export default function Chat({ config }: { config: Config }) {
  const [model, setModel] = useState(config.defaultRoute);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    abort.current = new AbortController();
    try {
      const meta = await streamChat(
        model,
        history.filter((t) => !t.error).map(({ role, content }) => ({ role, content })),
        (d) => setTurns((ts) => { const c = [...ts]; const last = c[c.length - 1]!; c[c.length - 1] = { ...last, content: last.content + d }; return c; }),
        abort.current.signal,
      );
      setTurns((ts) => { const c = [...ts]; c[c.length - 1] = { ...c[c.length - 1]!, served: `${meta.task ? `[${meta.task}] ` : ""}${meta.provider}/${meta.model}${meta.cache && meta.cache !== "miss" && meta.cache !== "bypass" ? ` · ${meta.cache}` : ""}`, fallbacks: Math.max(0, Number(meta.attempts ?? 1) - 1) }; return c; });
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        setTurns((ts) => { const c = [...ts]; c[c.length - 1] = { role: "assistant", content: (e as Error).message, error: true }; return c; });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat">
      <header className="page-head">
        <h1>Chat</h1>
        <div className="row">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="auto:task">auto:task (classify)</option>
            {config.routes.map((r) => <option key={r.name} value={r.name}>route: {r.name}</option>)}
          </select>
          <button className="ghost" onClick={() => setTurns([])}>Clear</button>
        </div>
      </header>
      <div className="messages">
        {turns.length === 0 && <p className="muted">Messages go through the same router your tools use, so you can watch fallback happen on the Dashboard.</p>}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role} ${t.error ? "error" : ""}`}>
            <div className="bubble">{t.content || (busy && i === turns.length - 1 ? "…" : "")}</div>
            {t.served && <div className="meta">{t.served}{t.fallbacks ? ` · after ${t.fallbacks} fallback${t.fallbacks > 1 ? "s" : ""}` : ""}</div>}
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea
          rows={3}
          placeholder="Ask anything… (Enter to send, Shift+Enter for a new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        {busy ? <button onClick={() => abort.current?.abort()}>Stop</button> : <button onClick={send} disabled={!input.trim()}>Send</button>}
      </div>
    </section>
  );
}
