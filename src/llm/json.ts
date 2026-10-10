// JSON answers from any provider: ask with the schema, pull the object out of whatever comes back
// (code fences, prose around it), and ask once more if it still isn't valid.
import type { Image, LLM } from "./types.ts";

export function extractJSON(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch { /* look inside */ }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = t.indexOf(open), b = t.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* next */ } }
  }
  throw new Error("not JSON");
}

export async function askJSON(llm: LLM, prompt: string, schema: object, opts: { images?: Image[]; maxTokens?: number; signal?: AbortSignal } = {}): Promise<any> {
  const first = await llm.chat([{ role: "user", content: prompt, images: opts.images }], { schema, maxTokens: opts.maxTokens ?? 1500, signal: opts.signal });
  try { return extractJSON(first.content); } catch { /* one repair round */ }
  const again = await llm.chat([
    { role: "user", content: prompt, images: opts.images },
    { role: "assistant", content: first.content.slice(0, 2000) },
    { role: "user", content: "That wasn't valid JSON. Reply with only the JSON object." },
  ], { schema, maxTokens: opts.maxTokens ?? 1500, signal: opts.signal });
  return extractJSON(again.content);
}
