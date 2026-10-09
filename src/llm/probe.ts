// "Test connection": what this provider + model can do, with a few tiny requests. Duely turns features
// on or off from this (chat needs tool calling; reading announcements needs JSON; screenshots need images).
import { askJSON } from "./json.ts";
import type { LLM } from "./types.ts";

export type Capabilities = { chat: boolean; json: boolean; tools: boolean; vision: boolean; error?: string };

// a 4x4 red PNG
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC";

export async function probe(llm: LLM): Promise<Capabilities> {
  const caps: Capabilities = { chat: false, json: false, tools: false, vision: false };
  try {
    const r = await llm.chat([{ role: "user", content: "Reply with the single word: ready" }], { maxTokens: 20 });
    caps.chat = /ready/i.test(r.content);
  } catch (e) {
    caps.error = (e as Error).message;
    return caps;                                                       // bad key / model / URL: nothing else will work
  }
  try {
    const j = await askJSON(llm, "What is 2 + 3? Give the number as `answer`.", { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"] }, { maxTokens: 50 });
    caps.json = Number(j?.answer) === 5;
  } catch { /* no JSON */ }
  try {
    const r = await llm.chat([{ role: "user", content: "What's the weather in Ottawa? Use the tool." }], {
      maxTokens: 100,
      tools: [{ name: "get_weather", description: "Current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    });
    caps.tools = r.toolCalls.some((c) => c.name === "get_weather");
  } catch { /* no tools */ }
  try {
    const r = await llm.chat([{ role: "user", content: "What colour is this image? One word.", images: [{ mime: "image/png", b64: RED_PNG }] }], { maxTokens: 20 });
    caps.vision = /red/i.test(r.content);
  } catch { /* no images */ }
  return caps;
}

/** What the student sees after "Test connection". */
export function describeCaps(c: Capabilities): string[] {
  if (!c.chat) return [`Couldn't reach the AI: ${c.error ?? "no answer"}. Check the key, model name and URL.`];
  return [
    c.tools ? "✓ Chat: understands your questions" : "✗ Chat: this model can't use tools, so chat answers with simple lists only",
    c.json ? "✓ Reading announcements for dates" : "✗ Reading announcements: this model doesn't give structured answers",
    c.vision ? "✓ Timetable and exam screenshots" : "✗ Screenshots: this model can't read images (you can type classes in instead)",
  ];
}
