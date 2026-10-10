// Chaos: the chat with models that misbehave in every way seen live (or likely). Whatever the
// models do, a reply must come back, never throw, list only real items, never leak "undefined",
// and finish inside the Worker's ~30 s background limit (virtual clock for the hangs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmFromRun } from "./helpers.ts";
import { answer } from "../src/core/ask.ts";
import { memStore } from "../src/core/util.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-04T20:00:00-04:00");
const UIDS = new Set(ITEMS.map((i) => i.uid));
const QUESTIONS = ["whats due this week", "What lectures do I have tomorrow", "am i cooked this week", "when is test 1",
  "what did the prof say about the midterm", "done 1", "how many assignments are due", "and for comp 2406?"];

type Behaviour = { name: string; workers?: () => Promise<any>; mistral?: () => Response | Promise<Response> };
const hang = () => new Promise<never>(() => {});
const say = (content: string) => () => Response.json({ choices: [{ message: { content } }] });
const BEHAVIOURS: Behaviour[] = [
  { name: "open brace + whitespace", workers: async () => ({ response: "{" + " \n".repeat(200) }), mistral: say("{ \n \n") },
  { name: "truncated JSON", workers: async () => ({ response: '{"mode":"list","from":"2026-' }), mistral: say('{"ids":[1,2') },
  { name: "prose instead of JSON", workers: async () => ({ response: "Sure! Here are your assignments: A1 is due Friday." }), mistral: say("I think you have stuff due.") },
  { name: "wrong ids and fields", workers: async () => ({ response: JSON.stringify({ ids: [99, -1, 0, 1e9], phrase: "", mode: "banana", from: "2099-99-99", to: 5, courses: ["XYZ 9999"], categories: ["homework", null], limit: -3 }) }), mistral: say('{"ids":["x"],"mode":"next","limit":"lots"}') },
  { name: "valid filter, absurd window", workers: async () => ({ response: JSON.stringify({ mode: "list", from: "1999-01-01", to: "2999-01-01", courses: [], categories: [], due_only: false, include_classes: true, limit: null }) }), mistral: say("{}") },
  { name: "object response", workers: async () => ({ response: { mode: "list" } }), mistral: () => Response.json({ choices: [{ message: { content: null } }] }) },
  { name: "empty", workers: async () => ({ response: "" }), mistral: () => Response.json({}) },
  { name: "4006 / 429", workers: async () => { throw new Error("4006: you have used up your daily free allocation"); }, mistral: () => new Response('{"message":"Rate limit exceeded"}', { status: 429 }) },
  { name: "3040 / 503", workers: async () => { throw new Error("3040: Capacity temporarily exceeded"); }, mistral: () => new Response("upstream", { status: 503 }) },
  { name: "bad key", workers: async () => { throw new Error("10000: Authentication error"); }, mistral: () => new Response('{"message":"Unauthorized"}', { status: 401 }) },
  { name: "invents an item", workers: async () => ({ response: "You have *COMP 9999: Secret Final* due today at 3 PM, and A1 tonight." }), mistral: say("COMP 9999 Final Exam is Oct 5.") },
  { name: "hangs forever", workers: hang, mistral: hang },
];

function fakes(b: Behaviour) {
  const f = (async (url: any) => {
    if (String(url).includes("api.mistral.ai")) return b.mistral ? b.mistral() : new Response("no", { status: 500 });
    return new Response("not found", { status: 404 });                 // announcement feeds
  }) as typeof fetch;
  // one provider (Duely Public): the misbehaving model, behind the real OpenAI-compatible adapter
  return { f, ai: { llm: llmFromRun(() => (b.workers ? b.workers() : hang())) } };
}

for (const engine of ["v1", "agent"]) for (const b of BEHAVIOURS) {
  test(`chaos (${engine}): ${b.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
    for (const q of QUESTIONS) {
      const { f, ai } = fakes(b);
      const store = memStore();
      let rows: { uid: string }[] = [];
      let settled = false, out = "", err: unknown = null;
      const t0 = Date.now();
      const conf = { announcement_feeds: ["https://bs.example/rss/1"], chat_engine: engine };
      answer(q, ITEMS, conf, store, TZ, f, NOW, { ...ai, onList: (r) => { rows = r; }, onFailure: async () => {} })
        .then((r) => { out = r; }, (e) => { err = e; }).finally(() => { settled = true; });
      for (let i = 0; i < 400 && !settled; i++) {
        await new Promise((r) => setImmediate(r));
        t.mock.timers.tick(250);
      }
      const ctx = `[${b.name}] "${q}"`;
      if (process.env.CHAOS_DEBUG && b.name.startsWith(process.env.CHAOS_DEBUG)) console.log(`${ctx} ${(Date.now() - t0) / 1000}s rows=${rows.length}\n${out.slice(0, 300)}\n`);
      assert.ok(settled, `${ctx}: no reply after 100 s`);
      assert.equal(err, null, `${ctx}: threw ${err}`);
      assert.ok(Date.now() - t0 <= 25_000, `${ctx}: took ${(Date.now() - t0) / 1000} s`);
      assert.ok(out.trim().length > 0, `${ctx}: empty reply`);
      assert.doesNotMatch(out, /undefined|NaN|\[object Object\]|null\b/, `${ctx}: leaked ${out}`);
      assert.doesNotMatch(out, /COMP 9999|Secret Final/, `${ctx}: an invented item got through:\n${out}`);
      for (const r of rows) assert.ok(UIDS.has(r.uid), `${ctx}: listed unknown uid ${r.uid}`);
    }
  });
}
