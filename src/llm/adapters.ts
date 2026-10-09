// The three API shapes. Each turns Duely's messages/tools into the provider's format and back.
import { type ChatOpts, type ChatResult, type LLM, type LLMConfig, LLMError, type Msg, type Tool, type ToolCall } from "./types.ts";

const jsonHint = (schema: object) =>
  `\n\nAnswer with ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n${JSON.stringify(schema)}`;

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? msg; } catch { /* raw */ }
    throw new LLMError(r.status, `${r.status}: ${msg}`);
  }
  try { return JSON.parse(text); } catch { throw new LLMError(502, "The AI provider returned something that isn't JSON"); }
}

const parseArgs = (a: unknown) => {
  if (typeof a !== "string") return a ?? {};
  try { return JSON.parse(a); } catch { return {}; }
};

// ---------------------------------------------------------------- OpenAI-compatible

export function openai(cfg: LLMConfig, f: typeof fetch = fetch): LLM {
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    label: `${base.includes("openai.com") ? "OpenAI" : new URL(base).host} · ${cfg.model}`,
    async chat(messages: Msg[], opts: ChatOpts = {}): Promise<ChatResult> {
      const msgs = messages.map((m) => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        if (m.role === "assistant") {
          return { role: "assistant", content: m.content || null,
            ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) };
        }
        if (m.role === "user" && m.images?.length) {
          return { role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.b64}` } }))] };
        }
        return { role: m.role, content: m.content };
      });
      // JSON: response_format json_object is the most widely supported; the schema goes in the prompt
      if (opts.schema) {
        const last = msgs[msgs.length - 1] as any;
        if (typeof last.content === "string") last.content += jsonHint(opts.schema);
        else if (Array.isArray(last.content)) last.content[0].text += jsonHint(opts.schema);
      }
      const body: any = { model: cfg.model, messages: msgs, max_tokens: opts.maxTokens ?? 800, temperature: opts.temperature ?? 0 };
      if (opts.tools?.length) body.tools = opts.tools.map((t) => ({ type: "function", function: t }));
      if (opts.schema && !opts.tools?.length) body.response_format = { type: "json_object" };
      const j = await post(f, `${base}/chat/completions`, cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, body, opts.signal);
      const m = j.choices?.[0]?.message ?? {};
      const calls: ToolCall[] = (m.tool_calls ?? []).map((c: any, i: number) => ({ id: String(c.id ?? `call${i}`), name: String(c.function?.name ?? ""), args: parseArgs(c.function?.arguments) }));
      return { content: typeof m.content === "string" ? m.content : "", toolCalls: calls,
        usage: { input: Number(j.usage?.prompt_tokens) || 0, output: Number(j.usage?.completion_tokens) || 0 } };
    },
  };
}

// ---------------------------------------------------------------- Anthropic

export function anthropic(cfg: LLMConfig, f: typeof fetch = fetch): LLM {
  const base = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  return {
    label: `Anthropic · ${cfg.model}`,
    async chat(messages: Msg[], opts: ChatOpts = {}): Promise<ChatResult> {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const out: any[] = [];
      for (const m of messages) {
        if (m.role === "system") continue;
        if (m.role === "tool") {
          const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
          const prev = out[out.length - 1];
          if (prev?.role === "user" && Array.isArray(prev.content) && prev.content.every((b: any) => b.type === "tool_result")) prev.content.push(block);
          else out.push({ role: "user", content: [block] });
        } else if (m.role === "assistant") {
          const content: any[] = [];
          if (m.content) content.push({ type: "text", text: m.content });
          for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
          out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
        } else {
          const content: any[] = (m.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.b64 } }));
          content.push({ type: "text", text: m.content + (opts.schema && m === messages[messages.length - 1] ? jsonHint(opts.schema) : "") });
          out.push({ role: "user", content });
        }
      }
      const body: any = { model: cfg.model, max_tokens: opts.maxTokens ?? 800, temperature: opts.temperature ?? 0, messages: out };
      if (system) body.system = system;
      if (opts.tools?.length) body.tools = opts.tools.map((t: Tool) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const j = await post(f, `${base}/messages`, { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }, body, opts.signal);
      const blocks: any[] = j.content ?? [];
      return {
        content: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
        toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} })),
        usage: { input: Number(j.usage?.input_tokens) || 0, output: Number(j.usage?.output_tokens) || 0 },
      };
    },
  };
}

// ---------------------------------------------------------------- Google Gemini

/** Gemini's schema dialect: no additionalProperties, enum only on strings. */
function geminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) if (!["additionalProperties", "$schema", "strict"].includes(k)) out[k] = geminiSchema(v);
  return out;
}

export function gemini(cfg: LLMConfig, f: typeof fetch = fetch): LLM {
  const base = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  return {
    label: `Gemini · ${cfg.model}`,
    async chat(messages: Msg[], opts: ChatOpts = {}): Promise<ChatResult> {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const contents: any[] = [];
      for (const m of messages) {
        if (m.role === "system") continue;
        if (m.role === "tool") {
          let response: any;
          try { response = JSON.parse(m.content); } catch { response = { result: m.content }; }
          if (typeof response !== "object" || Array.isArray(response)) response = { result: response };
          const part = { functionResponse: { name: m.name, response } };
          const prev = contents[contents.length - 1];
          if (prev?.role === "user" && prev.parts.every((p: any) => p.functionResponse)) prev.parts.push(part);
          else contents.push({ role: "user", parts: [part] });
        } else if (m.role === "assistant") {
          const parts: any[] = [];
          if (m.content) parts.push({ text: m.content });
          for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
          contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
        } else {
          contents.push({ role: "user", parts: [...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.b64 } })), { text: m.content }] });
        }
      }
      const body: any = { contents, generationConfig: { maxOutputTokens: opts.maxTokens ?? 800, temperature: opts.temperature ?? 0 } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (opts.tools?.length) body.tools = [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
      if (opts.schema && !opts.tools?.length) { body.generationConfig.responseMimeType = "application/json"; body.generationConfig.responseSchema = geminiSchema(opts.schema); }
      const j = await post(f, `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`, { "x-goog-api-key": cfg.apiKey }, body, opts.signal);
      const parts: any[] = j.candidates?.[0]?.content?.parts ?? [];
      return {
        content: parts.filter((p) => typeof p.text === "string").map((p) => p.text).join(""),
        toolCalls: parts.filter((p) => p.functionCall).map((p, i) => ({ id: `call${i}`, name: String(p.functionCall.name), args: p.functionCall.args ?? {} })),
        usage: { input: Number(j.usageMetadata?.promptTokenCount) || 0, output: Number(j.usageMetadata?.candidatesTokenCount) || 0 },
      };
    },
  };
}

export function makeLLM(cfg: LLMConfig, f: typeof fetch = fetch): LLM {
  if (cfg.provider === "anthropic") return anthropic(cfg, f);
  if (cfg.provider === "gemini") return gemini(cfg, f);
  return openai(cfg, f);
}
