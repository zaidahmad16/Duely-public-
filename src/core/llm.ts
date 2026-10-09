// Reading AI for the engine (feed filter, announcements, screenshots): the student's one provider.
// Same names as the personal Worker's llm.ts (AICtx / aiReady / llmJSON), so the ported code is
// unchanged. Background use has a daily request cap (setting ai_daily_limit, KV "ai-usage").
import { askJSON } from "../llm/json.ts";
import type { Image, LLM } from "../llm/types.ts";
import { today } from "./time.ts";
import type { Store } from "./util.ts";

export type AICtx = { store: Store; cfg: any; tz: string; fetch: typeof fetch; llm?: LLM };

export function aiReady(ctx: AICtx): boolean {
  return !!ctx.llm && ctx.cfg.use_ai !== false;
}

type Usage = { date: string; requests: number };

export async function llmJSON(ctx: AICtx, prompt: string, schema: object, opts: { maxTokens?: number; images?: Image[] } = {}): Promise<any> {
  if (!ctx.llm) throw new Error("No AI set up");
  const day = today(ctx.tz);
  const saved = (await ctx.store.get<Usage>("ai-usage")) ?? { date: day, requests: 0 };
  const u: Usage = saved.date === day ? saved : { date: day, requests: 0 };
  const cap = Number(ctx.cfg.ai_daily_limit ?? 200) || 0;
  if (cap && u.requests >= cap) throw new Error(`today's AI limit (${cap} requests) is used; it resets tomorrow`);
  u.requests += 1;
  try {
    return await askJSON(ctx.llm, prompt, schema, opts);
  } finally {
    await ctx.store.put("ai-usage", u);
  }
}
