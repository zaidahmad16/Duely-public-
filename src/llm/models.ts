// Choosing the model for the student: they pick a provider and paste a key, and Duely asks the provider
// which models that key can use, takes the best of its own short list that's there, and tests it. A
// model that's overloaded or missing is skipped for the next one (Gemini's "high demand" 503s and
// models retired for new keys were both seen live), so nobody needs to know model names.
import { makeLLM } from "./adapters.ts";
import { type Capabilities, probe } from "./probe.ts";
import type { LLMConfig, Provider } from "./types.ts";

/** Small, fast models that do everything Duely needs (tools, JSON, images), best first. A name also
 *  matches a dated version of it ("claude-haiku-4-5" → "claude-haiku-4-5-20251001"). */
export const RECOMMENDED: Record<Provider, string[]> = {
  gemini: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-2.5-flash"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-4-5"],
  openai: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1-nano"],
};

/** OpenAI-compatible services Duely knows, by host. Anything else (Ollama, LM Studio, OpenRouter …)
 *  is chosen from its own list by name. */
const BY_HOST: [RegExp, string[]][] = [
  [/(^|\.)groq\.com$/, ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]],
  [/(^|\.)mistral\.ai$/, ["mistral-small-latest", "mistral-medium-latest"]],
];

/** At most this many models are tried by one Test connection (each test is four small requests). */
export const MAX_TRIES = 3;

const host = (cfg: LLMConfig) => { try { return new URL(cfg.baseUrl || "https://api.openai.com/v1").hostname; } catch { return ""; } };
const isOpenAI = (cfg: LLMConfig) => cfg.provider === "openai" && /(^|\.)openai\.com$/.test(host(cfg));

/** Not a chat model: embeddings, speech, images, moderation … */
const NOT_CHAT = /embed|whisper|tts|audio|speech|transcri|image|dall-?e|moderation|realtime|rerank|guard|search|computer-use|live|aqa|gemma-3n|veo|imagen|learnlm|robotics/i;

export type ModelList = { models: string[] | null; error?: string; status?: number };

/** The models this key can use, from the provider's own list (`null` when it can't be listed). */
export async function listModels(cfg: LLMConfig, f: typeof fetch = fetch, signal?: AbortSignal): Promise<ModelList> {
  try {
    let url: string; const headers: Record<string, string> = {};
    if (cfg.provider === "gemini") {
      url = `${(cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")}/models?pageSize=1000`;
      headers["x-goog-api-key"] = cfg.apiKey;
    } else if (cfg.provider === "anthropic") {
      url = `${(cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "")}/models?limit=1000`;
      headers["x-api-key"] = cfg.apiKey; headers["anthropic-version"] = "2023-06-01";
    } else {
      url = `${(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/models`;
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    }
    const r = await f(url, { headers, signal });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? msg; } catch { /* raw */ }
      return { models: null, status: r.status, error: `${r.status}: ${msg}` };
    }
    const j = JSON.parse(text);
    if (cfg.provider === "gemini") {
      return { models: (j.models ?? [])
        .filter((m: any) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
        .map((m: any) => String(m.name ?? "").replace(/^models\//, "")).filter(Boolean) };
    }
    return { models: (j.data ?? j.models ?? []).map((m: any) => String(m.id ?? m.name ?? "")).filter(Boolean) };
  } catch (e) {
    return { models: null, error: (e as Error).message };
  }
}

/** How good a guess an unknown model name is: small, fast and current beats big, old or experimental. */
function score(name: string): number {
  let s = 0;
  if (/mini|flash|lite|haiku|small|instant|nano|\b[1-9]b\b|-[1-9]b/i.test(name)) s += 4;
  if (/latest/i.test(name)) s += 1;
  if (/preview|exp|beta|thinking|reason|o1|o3|deep/i.test(name)) s -= 3;
  return s;
}

/** The models to try, best first. With no list, Duely's own suggestions are tried as they are. */
export function rankModels(cfg: LLMConfig, available: string[] | null): string[] {
  const rec = cfg.provider === "openai" && !isOpenAI(cfg)
    ? BY_HOST.find(([re]) => re.test(host(cfg)))?.[1] ?? []
    : RECOMMENDED[cfg.provider];
  if (!available) return rec.slice(0, MAX_TRIES);
  const chat = available.filter((m) => !NOT_CHAT.test(m));
  const out: string[] = [];
  for (const r of rec) {
    const hit = chat.find((m) => m === r) ?? chat.filter((m) => m.startsWith(`${r}-`)).sort().pop();
    if (hit && !out.includes(hit)) out.push(hit);
  }
  // unknown services (and known ones whose suggestions are all gone): the likeliest by name, keeping
  // the service's own order otherwise (a local server lists what the student downloaded)
  const rest = chat.filter((m) => !out.includes(m)).map((m, i) => ({ m, i, s: score(m) })).sort((a, b) => b.s - a.s || a.i - b.i);
  return [...out, ...rest.map((x) => x.m)].slice(0, MAX_TRIES);
}

export type Pick = { model: string | null; caps: Capabilities; tried: { model: string; error?: string }[] };

const full = (c: Capabilities) => c.chat && c.tools && c.json;
const points = (c: Capabilities) => Number(c.chat) + Number(c.tools) + Number(c.json) + Number(c.vision);

/** Finds a model that works for this key: the first that passes everything (chat, reading and
 *  screenshots), else the one that passed the most. A rejected key stops at once. */
export async function pickModel(cfg: Omit<LLMConfig, "model">, f: typeof fetch = fetch, test: (c: LLMConfig) => Promise<Capabilities> = (c) => probe(makeLLM(c, f))): Promise<Pick> {
  const list = await listModels({ ...cfg, model: "" }, f);
  if (list.status === 401 || list.status === 403) return { model: null, caps: { chat: false, json: false, tools: false, vision: false, error: list.error }, tried: [] };
  const order = rankModels({ ...cfg, model: "" }, list.models);
  if (!order.length) {
    return { model: null, tried: [], caps: { chat: false, json: false, tools: false, vision: false,
      error: list.models ? "no models available: this key or server has no chat models" : (list.error ?? "no models available") } };
  }
  const tried: Pick["tried"] = [];
  let best: { model: string; caps: Capabilities } | null = null;
  let last: Capabilities | null = null;
  for (const model of order) {
    const caps = await test({ ...cfg, model });
    tried.push({ model, error: caps.error });
    last = caps;
    if (!caps.chat) {
      if (/\b(401|403)\b/.test(caps.error ?? "")) break;               // the key, not the model: no use trying others
      continue;
    }
    if (full(caps) && caps.vision) return { model, caps, tried };
    if (!best || points(caps) > points(best.caps)) best = { model, caps };
    if (full(caps)) break;                                           // good enough; only screenshots missing
  }
  return best ? { ...best, tried } : { model: null, caps: last!, tried };
}
