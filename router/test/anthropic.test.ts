import { describe, expect, test } from "bun:test";
import { anthropicRoute, fromOpenAI, toAnthropicStream, toOpenAI } from "../src/anthropic";
import { defaultConfig } from "../src/config";
import { localAware, mockFetch, okChat, stack } from "./helpers";

const claudeReq = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are Claude Code." }],
  tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }, { type: "web_search_20250305", name: "web_search" }],
  messages: [
    { role: "user", content: "Open README.md" },
    { role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "# Hello" }] }, { type: "text", text: "Summarise it" }] },
  ],
};

describe("anthropic translation", () => {
  test("request → OpenAI: system, tools (server tools dropped), tool_use, tool_result order", () => {
    const o = toOpenAI(claudeReq);
    expect(o.messages[0]).toEqual({ role: "system", content: "You are Claude Code." });
    expect(o.tools.length).toBe(1);
    expect(o.tools[0].function.name).toBe("Read");
    expect(o.messages[2].tool_calls[0]).toEqual({ id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"path":"README.md"}' } });
    expect(o.messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "# Hello" });
    expect(o.messages[4]).toEqual({ role: "user", content: "Summarise it" });
    expect(o.max_tokens).toBe(1024);
  });
  test("images become data URLs; tool_choice maps", () => {
    const o = toOpenAI({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } }, { type: "text", text: "what?" }] }], tools: claudeReq.tools, tool_choice: { type: "any" } });
    expect(o.messages[0].content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } });
    expect(o.tool_choice).toBe("required");
  });
  test("response → Anthropic: tool calls become tool_use blocks with parsed input", () => {
    const m = fromOpenAI({ choices: [{ message: { content: "ok", tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 4 } }, "claude-x");
    expect(m.content).toEqual([{ type: "text", text: "ok" }, { type: "tool_use", id: "c1", name: "Read", input: { path: "a" } }]);
    expect(m.stop_reason).toBe("tool_use");
    expect(m.usage).toEqual({ input_tokens: 9, output_tokens: 4 });
  });
  test("SSE re-emission: text then tool_use with input_json_delta, proper event order", async () => {
    const chunks = [
      { choices: [{ delta: { role: "assistant", content: "Let me" } }] },
      { choices: [{ delta: { content: " look." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "Read", arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 7 } },
    ];
    const src = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const out = await new Response(new Response(src).body!.pipeThrough(toAnthropicStream("claude-x"))).text();
    const events = [...out.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
    expect(events).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(out).toContain('"partial_json":"{\\"pa"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).toContain('"output_tokens":7');
  });
  test("Claude model names map to routes", () => {
    const c = defaultConfig();
    expect(anthropicRoute("claude-3-5-haiku-latest", c)).toBe("fast");
    expect(anthropicRoute("claude-sonnet-4-5", c)).toBe("coding");
    expect(anthropicRoute("claude-opus-4-1", c)).toBe("reasoning");
    expect(anthropicRoute("local", c)).toBe("local");
    expect(anthropicRoute("groq/llama-3.1-8b-instant", c)).toBe("groq/llama-3.1-8b-instant");
  });
});

describe("/v1/messages end to end", () => {
  test("non-streaming tool round trip through the coding route", async () => {
    const f = mockFetch(localAware(() => okChat("m", { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"README.md"}' } }] })));
    const s = stack({ fetch: f });
    const res = await s.call("/v1/messages", { json: claudeReq, headers: { "x-api-key": "anything", "anthropic-version": "2023-06-01" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ofr-provider")).toBe("mistral"); // sonnet → coding route
    const j: any = await res.json();
    expect(j.type).toBe("message");
    expect(j.model).toBe("claude-sonnet-4-5");
    expect(j.content[0]).toEqual({ type: "tool_use", id: "c1", name: "Read", input: { path: "README.md" } });
    const sent = f.bodies.find((b: any) => b?.messages);
    expect(sent.model).toBe("code");
    expect(sent.tools[0].function.name).toBe("Read");
  });
  test("errors come back in Anthropic format", async () => {
    const f = mockFetch(localAware(() => new Response("down", { status: 502 })));
    const s = stack({ fetch: f });
    const res = await s.call("/v1/messages", { json: { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] } });
    expect(res.status).toBe(503);
    const j: any = await res.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("overloaded_error");
  });
  test("count_tokens estimates", async () => {
    const s = stack();
    const j: any = await (await s.call("/v1/messages/count_tokens", { json: claudeReq })).json();
    expect(j.input_tokens).toBeGreaterThan(10);
  });
});
