// The one-LLM layer: each provider's request shape (system, tools, images, JSON) and how its answer is
// read back (text, tool calls), with recorded-style responses. Plus JSON repair and the capability probe.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropic, gemini, makeLLM, openai } from "../src/llm/adapters.ts";
import { askJSON, extractJSON } from "../src/llm/json.ts";
import { describeCaps, probe } from "../src/llm/probe.ts";
import type { LLM, Msg } from "../src/llm/types.ts";

function capture(reply: any, status = 200) {
  const sent: { url: string; headers: any; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(typeof reply === "function" ? reply(JSON.parse(init.body)) : reply), { status });
  }) as typeof fetch;
  return { sent, f };
}
const TOOL = { name: "search_items", description: "find items", parameters: { type: "object", properties: { when: { type: "string" } }, required: ["when"] } };
const IMG = { mime: "image/png", b64: "AAAA" };
const CONVO: Msg[] = [
  { role: "system", content: "You are Duely." },
  { role: "user", content: "what's due?" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_items", args: { when: "this week" } }] },
  { role: "tool", toolCallId: "c1", name: "search_items", content: "2 items" },
];

test("OpenAI-compatible: messages, tools, images, JSON mode; tool calls read back", async () => {
  const { sent, f } = capture({ choices: [{ message: { content: null, tool_calls: [{ id: "x", function: { name: "reply", arguments: "{\"message\":\"hi\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const llm = openai({ provider: "openai", apiKey: "k", model: "gpt-x", baseUrl: "https://openrouter.ai/api/v1/" }, f);
  const r = await llm.chat(CONVO, { tools: [TOOL], maxTokens: 50 });
  assert.equal(sent[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent[0].headers.authorization, "Bearer k");
  const b = sent[0].body;
  assert.deepEqual(b.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(b.messages[2].tool_calls[0].function.arguments, "{\"when\":\"this week\"}");
  assert.equal(b.messages[3].tool_call_id, "c1");
  assert.equal(b.tools[0].type, "function");
  assert.deepEqual(r.toolCalls, [{ id: "x", name: "reply", args: { message: "hi" } }]);
  assert.deepEqual(r.usage, { input: 10, output: 2 });
  await llm.chat([{ role: "user", content: "read this", images: [IMG] }], { schema: { type: "object" } });
  const img = sent[1].body.messages[0].content;
  assert.equal(img[1].image_url.url, "data:image/png;base64,AAAA");
  assert.match(img[0].text, /matching this JSON schema/);
  assert.deepEqual(sent[1].body.response_format, { type: "json_object" });
  assert.match(llm.label, /^openrouter\.ai · gpt-x$/);
  // local models (Ollama / LM Studio) need no key
  const local = capture({ choices: [{ message: { content: "ok" } }] });
  await openai({ provider: "openai", apiKey: "", model: "llama3", baseUrl: "http://localhost:11434/v1" }, local.f).chat([{ role: "user", content: "hi" }]);
  assert.equal(local.sent[0].headers.authorization, undefined);
});

test("Anthropic: system separate, tool_use / tool_result blocks, images, errors", async () => {
  const { sent, f } = capture({ content: [{ type: "text", text: "Here you go" }, { type: "tool_use", id: "t1", name: "reply", input: { message: "hi" } }], usage: { input_tokens: 5, output_tokens: 3 } });
  const llm = anthropic({ provider: "anthropic", apiKey: "sk-ant", model: "claude-x" }, f);
  const r = await llm.chat(CONVO, { tools: [TOOL] });
  const b = sent[0].body;
  assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[0].headers["x-api-key"], "sk-ant");
  assert.equal(b.system, "You are Duely.");
  assert.deepEqual(b.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(b.messages[1].content[0], { type: "tool_use", id: "c1", name: "search_items", input: { when: "this week" } });
  assert.deepEqual(b.messages[2].content[0], { type: "tool_result", tool_use_id: "c1", content: "2 items" });
  assert.equal(b.tools[0].input_schema.type, "object");
  assert.equal(r.content, "Here you go");
  assert.deepEqual(r.toolCalls, [{ id: "t1", name: "reply", args: { message: "hi" } }]);
  await llm.chat([{ role: "user", content: "read", images: [IMG] }]);
  assert.deepEqual(sent[1].body.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  const bad = capture({ error: { message: "invalid x-api-key" } }, 401);
  await assert.rejects(anthropic({ provider: "anthropic", apiKey: "x", model: "m" }, bad.f).chat([{ role: "user", content: "hi" }]), /401: invalid x-api-key/);
});

test("Gemini: contents/parts, functionDeclarations (schema cleaned), JSON mime type, functionCall read back", async () => {
  const { sent, f } = capture({ candidates: [{ content: { parts: [{ functionCall: { name: "reply", args: { message: "hi" } } }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 } });
  const llm = gemini({ provider: "gemini", apiKey: "g", model: "gemini-x" }, f);
  const r = await llm.chat(CONVO, { tools: [{ ...TOOL, parameters: { ...TOOL.parameters, additionalProperties: false } }] });
  const b = sent[0].body;
  assert.equal(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  assert.equal(sent[0].headers["x-goog-api-key"], "g");
  assert.deepEqual(b.systemInstruction, { parts: [{ text: "You are Duely." }] });
  assert.deepEqual(b.contents.map((c: any) => c.role), ["user", "model", "user"]);
  assert.deepEqual(b.contents[1].parts[0], { functionCall: { name: "search_items", args: { when: "this week" } } });
  assert.deepEqual(b.contents[2].parts[0], { functionResponse: { name: "search_items", response: { result: "2 items" } } });
  assert.equal(b.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined, "Gemini rejects additionalProperties");
  assert.deepEqual(r.toolCalls, [{ id: "call0", name: "reply", args: { message: "hi" } }]);
  await llm.chat([{ role: "user", content: "json please" }], { schema: { type: "object", properties: { a: { type: "integer" } } } });
  assert.equal(sent[1].body.generationConfig.responseMimeType, "application/json");
  assert.equal(makeLLM({ provider: "gemini", apiKey: "g", model: "m" }, f).label, "Gemini · m");
});

test("JSON: fences, prose around it, one repair round", async () => {
  assert.deepEqual(extractJSON("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJSON("Sure! Here it is: {\"a\": 2} Hope that helps."), { a: 2 });
  assert.throws(() => extractJSON("nope"));
  let n = 0;
  const llm: LLM = { label: "fake", chat: async () => ({ content: n++ === 0 ? "I think it's 5" : "{\"answer\": 5}", toolCalls: [], usage: { input: 0, output: 0 } }) };
  assert.deepEqual(await askJSON(llm, "2+3?", { type: "object" }), { answer: 5 });
  assert.equal(n, 2);
});

test("probe: what a provider can do, and what the student is told", async () => {
  const full: LLM = { label: "full", chat: async (msgs, opts) => {
    const last: any = msgs[msgs.length - 1];
    if (opts?.tools) return { content: "", toolCalls: [{ id: "1", name: "get_weather", args: { city: "Ottawa" } }], usage: { input: 0, output: 0 } };
    if (opts?.schema) return { content: "{\"answer\":5}", toolCalls: [], usage: { input: 0, output: 0 } };
    if (last.images) return { content: "Red", toolCalls: [], usage: { input: 0, output: 0 } };
    return { content: "ready", toolCalls: [], usage: { input: 0, output: 0 } };
  } };
  assert.deepEqual(await probe(full), { chat: true, json: true, tools: true, vision: true });
  const textOnly: LLM = { label: "t", chat: async (msgs, opts) => {
    if ((msgs[msgs.length - 1] as any).images) throw new Error("400: images not supported");
    return { content: opts?.schema ? "{\"answer\":5}" : "ready", toolCalls: [], usage: { input: 0, output: 0 } };
  } };
  const caps = await probe(textOnly);
  assert.deepEqual(caps, { chat: true, json: true, tools: false, vision: false });
  assert.deepEqual(describeCaps(caps).map((l) => l[0]), ["✗", "✓", "✗"]);
  const down: LLM = { label: "d", chat: async () => { throw new Error("401: bad key"); } };
  assert.match(describeCaps(await probe(down))[0], /^Couldn't reach the AI: 401: bad key/);
});
