// Duely picks the model: the provider's own list, Duely's suggestions in order, the next one when a model
// is overloaded or gone (both seen live with Gemini), and a rejected key stopping at once. Plus the
// settings rules: empty Model = automatic, a new provider picks again, older settings keep their model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { retry } from "../src/llm/adapters.ts";
import { listModels, MAX_TRIES, pickModel, rankModels } from "../src/llm/models.ts";
import type { Capabilities } from "../src/llm/probe.ts";
import { applyPatch, autoModel, friendlyAIError, toSettings } from "../src/node/settings.ts";

retry.delayMs = 0;
const ok = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const caps = (c: Partial<Capabilities>): Capabilities => ({ chat: false, json: false, tools: false, vision: false, ...c });
const ALL = caps({ chat: true, json: true, tools: true, vision: true });

/** A fake Gemini: lists `models`; `busy` answer 503 (Gemini's "high demand"); the rest answer like a
 *  good model, whatever the probe asks (plain reply, JSON, tool call, image colour). */
function fakeGemini(models: string[], busy: string[] = []) {
  const calls: string[] = [];
  const f = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/models?")) return ok(200, { models: models.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: m.includes("embed") ? ["embedContent"] : ["generateContent"] })) });
    const model = decodeURIComponent(/models\/([^:]+):/.exec(u)![1]);
    calls.push(model);
    if (busy.includes(model)) return ok(503, { error: { message: "This model is currently experiencing high demand." } });
    const b = JSON.parse(init.body);
    const parts = b.tools ? [{ functionCall: { name: "get_weather", args: { city: "Ottawa" } } }]
      : b.generationConfig.responseSchema ? [{ text: "{\"answer\":5}" }]
      : b.contents[0].parts.some((p: any) => p.inlineData) ? [{ text: "Red" }] : [{ text: "ready" }];
    return ok(200, { candidates: [{ content: { parts } }] });
  }) as typeof fetch;
  return { f, calls };
}

test("an overloaded suggested model is skipped for the next one that works (live: gemini-flash-latest 503)", async () => {
  const g = fakeGemini(["gemini-flash-lite-latest", "gemini-flash-latest", "text-embedding-004"], ["gemini-flash-lite-latest"]);
  const r = await pickModel({ provider: "gemini", apiKey: "k" }, g.f);
  assert.equal(r.model, "gemini-flash-latest");
  assert.deepEqual(r.caps, ALL);
  assert.equal(r.tried[0].model, "gemini-flash-lite-latest");
  assert.match(r.tried[0].error ?? "", /503/);
  assert.ok(!g.calls.includes("text-embedding-004"), "embedding models are never tried");
});

test("a suggested model the key can't use is never tried (live: gemini-2.5-flash gone for new keys)", async () => {
  const g = fakeGemini(["gemini-2.5-flash-lite", "gemini-pro-latest"]);
  const r = await pickModel({ provider: "gemini", apiKey: "k" }, g.f);
  assert.equal(r.model, "gemini-2.5-flash-lite");
  assert.deepEqual(g.calls.filter((m) => m !== "gemini-2.5-flash-lite"), []);
});

test("a rejected key stops at once, with the key error (not 'model not found')", async () => {
  const bad = (async () => ok(401, { error: { message: "invalid x-api-key" } })) as typeof fetch;
  const r = await pickModel({ provider: "anthropic", apiKey: "nope" }, bad);
  assert.equal(r.model, null);
  assert.equal(friendlyAIError(r.caps.error), "The API key wasn't accepted. Check that it's copied in full.");
  assert.deepEqual(r.tried, []);
  // the list works but the first chat test says the key is bad: one try, not three
  const list = (async () => ok(200, { data: [{ id: "gpt-4.1-mini" }, { id: "gpt-4o-mini" }] })) as typeof fetch;
  const r2 = await pickModel({ provider: "openai", apiKey: "x" }, list, async () => caps({ error: "401: Incorrect API key" }));
  assert.equal(r2.tried.length, 1);
});

test("every model failing: the last error, worded for the student; never more than MAX_TRIES", async () => {
  const g = fakeGemini(["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-x-flash"], ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-x-flash"]);
  const r = await pickModel({ provider: "gemini", apiKey: "k" }, g.f);
  assert.equal(r.model, null);
  assert.equal(r.tried.length, MAX_TRIES);
  assert.match(friendlyAIError(r.caps.error), /busy right now/);
});

test("a model missing only screenshots is kept, but one with everything wins if it comes next", async () => {
  const seen: string[] = [];
  const t = async (c: any) => { seen.push(c.model); return c.model === "a" ? caps({ chat: true }) : c.model === "b" ? caps({ chat: true, json: true, tools: true }) : ALL; };
  const list = (async () => ok(200, { data: [{ id: "a" }, { id: "b" }, { id: "c" }] })) as typeof fetch;
  const r = await pickModel({ provider: "openai", apiKey: "k", baseUrl: "http://localhost:11434/v1" }, list, t);
  assert.equal(r.model, "b");                                      // chat + reading: good enough, stop there
  assert.deepEqual(seen, ["a", "b"]);
});

test("listing models: each provider's endpoint, headers and shape", async () => {
  const sent: { url: string; headers: any }[] = [];
  const f = (body: unknown) => (async (url: any, init: any) => { sent.push({ url: String(url), headers: init.headers }); return ok(200, body); }) as typeof fetch;
  assert.deepEqual((await listModels({ provider: "anthropic", apiKey: "sk", model: "" }, f({ data: [{ id: "claude-haiku-4-5-20251001" }] }))).models, ["claude-haiku-4-5-20251001"]);
  assert.equal(sent[0].url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(sent[0].headers["x-api-key"], "sk");
  assert.deepEqual((await listModels({ provider: "openai", apiKey: "", model: "", baseUrl: "http://localhost:11434/v1" }, f({ data: [{ id: "llama3.2" }] }))).models, ["llama3.2"]);
  assert.equal(sent[1].url, "http://localhost:11434/v1/models");
  assert.equal(sent[1].headers.authorization, undefined);         // local servers need no key
  const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.equal((await listModels({ provider: "gemini", apiKey: "k", model: "" }, down)).models, null);
});

test("ranking: Duely's suggestions first (dated versions match), then likely names; no list = suggestions", () => {
  assert.deepEqual(rankModels({ provider: "anthropic", apiKey: "", model: "" }, ["claude-opus-4-1-20250805", "claude-haiku-4-5-20251001", "claude-sonnet-5"]),
    ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-1-20250805"]);
  assert.deepEqual(rankModels({ provider: "gemini", apiKey: "", model: "" }, null), ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-flash-latest"]);
  // an unknown service: small/fast names first, previews last, non-chat models out
  assert.deepEqual(rankModels({ provider: "openai", apiKey: "", model: "", baseUrl: "https://openrouter.ai/api/v1" },
    ["x/big-model", "x/thing-preview", "y/fast-mini", "z/text-embedding-3"]), ["y/fast-mini", "x/big-model", "x/thing-preview"]);
  assert.deepEqual(rankModels({ provider: "openai", apiKey: "", model: "", baseUrl: "https://api.groq.com/openai/v1" }, ["whisper-large-v3", "llama-3.1-8b-instant"]), ["llama-3.1-8b-instant"]);
});

test("settings: empty Model = automatic; a typed one is kept; a new provider picks again; old settings keep theirs", () => {
  let c = applyPatch({}, { ai: { provider: "gemini" } });
  assert.equal(toSettings(c, false).ai.auto, true);
  c = { ...c, ai: { ...c.ai, model: "gemini-flash-lite-latest" } };   // what Test connection saves after picking
  assert.equal(autoModel(c.ai), true);
  c = applyPatch(c, { ai: { model: "gemini-pro-latest" } });
  assert.equal(toSettings(c, false).ai.auto, false);
  c = applyPatch(c, { ai: { provider: "anthropic" } });
  assert.deepEqual([c.ai.model, toSettings(c, false).ai.auto], ["", true]);
  c = applyPatch(c, { ai: { model: "  " } });
  assert.equal(autoModel(c.ai), true);
  // saved before automatic models existed: a model and no flag → the student's choice, kept
  assert.equal(autoModel({ provider: "gemini", model: "gemini-2.5-flash" }), false);
  // another server: a picked model is picked again, a typed one stays
  const picked = applyPatch({ ai: { provider: "openai", model: "llama3", auto: true } }, { ai: { baseUrl: "http://localhost:1234/v1" } });
  assert.equal(picked.ai.model, "");
  const typed = applyPatch({ ai: { provider: "openai", model: "llama3", auto: false } }, { ai: { baseUrl: "http://localhost:1234/v1" } });
  assert.equal(typed.ai.model, "llama3");
});
