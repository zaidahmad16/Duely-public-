// Fake AI providers for tests, built on the real OpenAI-compatible adapter (so the adapter is
// exercised too). `llmFromRun` accepts the old Workers-AI-style fakes used by the ported tests:
// run(model, body) returning {choices:[{message}]} or {response}.
import { openai } from "../src/llm/adapters.ts";
import type { LLM } from "../src/llm/types.ts";

export function llmFromRun(run: (model: string, body: any) => Promise<any>): LLM {
  const f = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const r = await run(body.model, body);
    if (r?.choices) return Response.json(r);
    const content = typeof r?.response === "string" ? r.response : r?.response == null ? "" : JSON.stringify(r.response);
    return Response.json({ choices: [{ message: { content, tool_calls: r?.tool_calls } }], usage: r?.usage });
  }) as typeof fetch;
  return openai({ provider: "openai", apiKey: "test", model: "fake-model", baseUrl: "https://ai.example/v1" }, f);
}

/** An OpenAI-compatible provider whose HTTP calls go to `f` (for tests that fake the HTTP layer). */
export function llmOverFetch(f: typeof fetch, baseUrl = "https://api.mistral.ai/v1", apiKey = "mk"): LLM {
  return openai({ provider: "openai", apiKey, model: "fake-model", baseUrl }, f);
}
