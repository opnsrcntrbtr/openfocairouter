// Anthropic Messages API ⇄ OpenAI Chat Completions translation (requests, responses, SSE).
import { randomBytes } from "node:crypto";
import { parseTarget, type AppConfig } from "./config";

const rid = (p: string) => p + randomBytes(12).toString("hex");

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n");
}

function imagePart(b: any): any | undefined {
  const s = b?.source;
  if (s?.type === "base64" && s.data) return { type: "image_url", image_url: { url: `data:${s.media_type ?? "image/png"};base64,${s.data}` } };
  if (s?.type === "url" && s.url) return { type: "image_url", image_url: { url: s.url } };
  return undefined;
}

/** Anthropic /v1/messages request → OpenAI chat completions request (model left for the router). */
export function toOpenAI(req: any): any {
  const messages: any[] = [];
  const system = blocksText(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of req.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    if (m.role === "user") {
      for (const b of blocks.filter((x) => x?.type === "tool_result")) {
        const text = typeof b.content === "string" ? b.content : blocksText(b.content);
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${text}` : text || "(no output)" });
      }
      const parts: any[] = [];
      for (const b of blocks) {
        if (b?.type === "text") parts.push({ type: "text", text: b.text ?? "" });
        else if (b?.type === "image") {
          const ip = imagePart(b);
          if (ip) parts.push(ip);
        } else if (b?.type === "document") {
          const t = b.source?.type === "text" ? b.source.data : undefined;
          if (t) parts.push({ type: "text", text: t });
        }
      }
      if (parts.length) {
        messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts });
      }
    } else {
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: any = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const out: any = { messages, stream: !!req.stream };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.metadata?.user_id) out.user = String(req.metadata.user_id);
  const tools = (req.tools ?? []).filter((t: any) => t?.input_schema && (!t.type || t.type === "custom"));
  if (tools.length) {
    out.tools = tools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
    const tc = req.tool_choice;
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "auto") out.tool_choice = "auto";
    if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  return out;
}

export function stopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function parseArgs(s: string | undefined): any {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/** OpenAI chat completion response → Anthropic message. */
export function fromOpenAI(json: any, model: string): any {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];
  const text = typeof msg.content === "string" ? msg.content : blocksText(msg.content);
  if (text) content.push({ type: "text", text });
  for (const tc of msg.tool_calls ?? []) {
    content.push({ type: "tool_use", id: tc.id || rid("toolu_"), name: tc.function?.name ?? "", input: parseArgs(tc.function?.arguments) });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: (msg.tool_calls?.length && choice.finish_reason === "stop") ? "tool_use" : stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: json?.usage?.prompt_tokens ?? 0, output_tokens: json?.usage?.completion_tokens ?? 0 },
  };
}

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** Re-emit an OpenAI SSE stream as Anthropic Messages streaming events. */
export function toAnthropicStream(model: string): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let started = false;
  let finished = false;
  let blockIndex = -1;
  let open: { kind: "text" | "tool"; index: number } | undefined;
  const toolBlocks = new Map<number, number>(); // openai tool index → anthropic block index
  let finish: string | undefined;
  let usage: any;
  const id = rid("msg_");

  const emit = (ctl: TransformStreamDefaultController<Uint8Array>, s: string) => ctl.enqueue(enc.encode(s));
  const start = (ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return;
    started = true;
    emit(ctl, sse("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
    emit(ctl, sse("ping", {}));
  };
  const close = (ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (open) emit(ctl, sse("content_block_stop", { index: open.index }));
    open = undefined;
  };
  const end = (ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    start(ctl);
    close(ctl);
    const reason = toolBlocks.size && (finish === "stop" || !finish) ? "tool_use" : stopReason(finish);
    emit(ctl, sse("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 } }));
    emit(ctl, sse("message_stop", {}));
  };
  const handle = (ctl: TransformStreamDefaultController<Uint8Array>, data: string) => {
    if (data === "[DONE]") return end(ctl);
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    start(ctl);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (open?.kind !== "text") {
        close(ctl);
        open = { kind: "text", index: ++blockIndex };
        emit(ctl, sse("content_block_start", { index: open.index, content_block: { type: "text", text: "" } }));
      }
      emit(ctl, sse("content_block_delta", { index: open.index, delta: { type: "text_delta", text: delta.content } }));
    }
    for (const tc of delta.tool_calls ?? []) {
      const ti = tc.index ?? 0;
      let bi = toolBlocks.get(ti);
      if (bi === undefined) {
        close(ctl);
        bi = ++blockIndex;
        toolBlocks.set(ti, bi);
        open = { kind: "tool", index: bi };
        emit(ctl, sse("content_block_start", { index: bi, content_block: { type: "tool_use", id: tc.id || rid("toolu_"), name: tc.function?.name ?? "", input: {} } }));
      }
      const args = tc.function?.arguments;
      if (args) emit(ctl, sse("content_block_delta", { index: bi, delta: { type: "input_json_delta", partial_json: args } }));
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  return new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith("data:")) handle(ctl, l.slice(5).trim());
      }
    },
    flush(ctl) {
      const l = buf.trim();
      if (l.startsWith("data:")) handle(ctl, l.slice(5).trim());
      end(ctl);
    },
  });
}

/** Map a Claude model name (or a route name) to an OpenFOC route. */
export function anthropicRoute(model: string | undefined, cfg: AppConfig): string {
  const m = (model ?? "").trim();
  if (!m) return cfg.defaultRoute;
  if (m === "auto:task" || m.startsWith("auto:") || cfg.routes.some((r) => r.name === m)) return m;
  const t = parseTarget(m);
  if (t && cfg.providers.some((p) => p.id === t.providerId)) return m;
  const lower = m.toLowerCase();
  for (const [sub, route] of Object.entries(cfg.anthropic.modelMap)) if (lower.includes(sub.toLowerCase())) return route;
  return cfg.defaultRoute;
}

export function anthropicError(status: number, message: string): Response {
  const type =
    status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : status === 503 ? "overloaded_error" : "api_error";
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json" } });
}

export function countTokens(req: any): number {
  let chars = blocksText(req.system).length;
  for (const m of req.messages ?? []) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  if (req.tools) chars += JSON.stringify(req.tools).length;
  return Math.ceil(chars / 4);
}
