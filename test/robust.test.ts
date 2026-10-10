// The chat's safety nets: messy text, follow-ups, "the first one", checks on what the AI says,
// Workers AI first with a daily budget, and never crashing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmFromRun, llmOverFetch } from "./helpers.ts";
import { answer } from "../src/core/ask.ts";
import { resolveTarget } from "../src/core/done.ts";
import { clamp, datesIn, guard } from "../src/core/guard.ts";
import { courseAliases, normalize } from "../src/core/normalize.ts";
import { memStore } from "../src/core/util.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-04T12:00:00-04:00");   // Sun Oct 4, noon
const T = "2026-10-04";
const COURSES = [
  { code: "COMP 2406", name: "Fundamentals Web Applications" }, { code: "COMP 3106", name: "Intro to AI" },
  { code: "PHYS 1905", name: "Physics Behind Everyday Life" }, { code: "STAT 2507", name: "Intro to Stat Modelling I" },
  { code: "FILM 1101", name: "Introduction to Film Studies" },
];
const AL = courseAliases(COURSES);

test("normalize: slang, typos, number words stay, course nicknames -> codes", () => {
  const cases: [string, string][] = [
    ["wats due tmrw for stats??", "what's due tomorrow for STAT 2507?"],
    ["any assigments for 3106 nxt wk", "any assignments for COMP 3106 next week"],
    ["comp2406 a1 due date", "COMP 2406 a1 deadline"],
    ["physics quiz 😭😭", "PHYS 1905 quiz"],
    ["did the ai prof say anything abt the mid term", "did the COMP 3106 prof say anything about the midterm"],
    ["what's on fri", "what's on friday"],
    ["am i behind on everything", "am i behind on everything"],          // "behind" is in a course name, but an everyday word
    ["what shud i do tonite", "what shud i do tonight"],
    ["the film midterm", "the FILM 1101 midterm"],
    ["is there a stat 2507 quiz", "is there a STAT 2507 quiz"],          // a code isn't double-replaced
    ["web applications stuff", "COMP 2406 stuff"],
    ["done the first one", "done the first one"],
    ["COMP 3106 A1", "COMP 3106 a1"],
  ];
  for (const [inp, out] of cases) assert.equal(normalize(inp, AL), out, inp);
  assert.ok(!AL.has("comp"), "two COMP courses: 'comp' alone is ambiguous, so not a nickname");
});

test("guard: wrong 'tonight', wrong weekday, invented dates, length, leftovers", () => {
  const items = [{ title: "Quiz - Sports Module", course: "PHYS 1905", day: "2026-10-05" }, { title: "Assignment 1", course: "COMP 3106", day: "2026-10-09" }];
  let g = guard("• Do the *Quiz - Sports Module* tonight, it's due tonight at 11:59 PM", items, T);
  assert.match(g.text, /due tomorrow night/);
  g = guard("• COMP 3106 Assignment 1 is due today!", items, T);
  assert.match(g.text, /due on Fri Oct 9/);
  g = guard("• Assignment 1 is due *Thursday, Oct 9*", items, T);
  assert.match(g.text, /\*Friday, Oct 9\*/, "Oct 9 2026 is a Friday");
  g = guard("• Something on Oct 22", items, T);
  assert.deepEqual(g.unknownDates, ["2026-10-22"], "not in the calendar");
  assert.deepEqual(guard("• tests on Oct 22", items, T, ["2026-10-22"]).unknownDates, [], "allowed (an announcement said so)");
  assert.equal(guard("**bold** <LINK|x> https://made.up/x", items, T).text, "*bold*");
  const long = Array.from({ length: 20 }, (_, i) => `• line ${i}`).join("\n");
  const c = clamp(long, 10);
  assert.equal(c.split("\n").length, 11);
  assert.match(c, /Ask for more detail/);
  assert.deepEqual(datesIn("Test is Saturday, October 17th; review Sun Oct 11", T), ["2026-10-17", "2026-10-11"]);
});

test("done: 'the first one', 'that one', 'last'", () => {
  const list = ["s1", "s2", "s3"];
  const items = list.map((uid, i) => ({ uid, title: `Thing ${i}`, role: "deadline", end: "2026-10-09T23:59:00-04:00", type: "assignment" }));
  assert.equal(resolveTarget("the first one", items, list, NOW).match.uid, "s1");
  assert.equal(resolveTarget("second", items, list, NOW).match.uid, "s2");
  assert.equal(resolveTarget("the last one", items, list, NOW).match.uid, "s3");
  assert.equal(resolveTarget("that one", items, ["s2"], NOW).match.uid, "s2", "one item listed: 'that one' is it");
  assert.equal(resolveTarget("that one", items, list, NOW).choices!.length, 3, "several: ask which");
});

/** A fake Workers AI binding: the filter reply depends on the prompt; counts neurons. */
function fakeWorkers(pick: (prompt: string) => any, text = "ok") {
  const prompts: string[] = [];
  return {
    prompts,
    ai: {
      run: async (_m: string, input: any) => {
        const p = input.messages[0].content;
        if (/Pick exactly the items/.test(p)) return { response: {}, usage: { neurons: 0 } };   // no pick: the filter decides
        prompts.push(p);
        if (input.response_format) return { response: pick(p), usage: { neurons: 100 } };
        return { response: text, usage: { neurons: 50 } };
      },
    },
  };
}
const base = { mode: "list", from: T, to: "2026-10-18", courses: [], categories: [], due_only: true, include_classes: false, limit: null, target: "", topic: "" };

test("follow-ups: the AI sees the last question and its filter; the rules keep the filter too", async () => {
  const store = memStore();
  const w = fakeWorkers((p) => (p.includes("Earlier in this chat") ? { ...base, categories: ["assignment"], from: "2026-10-12", to: "2026-10-18" } : { ...base, categories: ["assignment"] }));
  await answer("assignments due", ITEMS, { chat_engine: "v1" }, store, TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => w.ai.run(m, b)) });
  await answer("what about next week", ITEMS, { chat_engine: "v1" }, store, TZ, fetch, NOW + 60e3, { llm: llmFromRun((m: string, b: any) => w.ai.run(m, b)) });
  assert.match(w.prompts[1], /Earlier in this chat[^]*Q: assignments due\nfilter: \{"mode":"list"[^]*"categories":\["assignment"\]/);

  // no AI at all: "and for 3106?" keeps "assignments due" and changes the course
  const s2 = memStore();
  await answer("assignments due in the next 2 weeks", ITEMS, { chat_engine: "v1" }, s2, TZ, fetch, NOW);
  const out = await answer("and for 3106?", ITEMS, { chat_engine: "v1" }, s2, TZ, fetch, NOW + 60e3);
  assert.match(out, /^\*1 COMP 3106 assignment due/);
  // stale after 30 minutes: not a follow-up any more
  const s3 = memStore();
  await answer("assignments due in the next 2 weeks", ITEMS, { chat_engine: "v1" }, s3, TZ, fetch, NOW);
  assert.doesNotMatch(await answer("and for 3106?", ITEMS, { chat_engine: "v1" }, s3, TZ, fetch, NOW + 40 * 60e3), /assignment due/);
});

test("'done the first one' after a list", async () => {
  const store = memStore();
  await answer("assignments due in the next 2 weeks", ITEMS, { chat_engine: "v1" }, store, TZ, fetch, NOW);
  const out = await answer("done the first one", ITEMS, { chat_engine: "v1" }, store, TZ, fetch, NOW + 60e3);
  assert.match(out, /^✅ Marked \*COMP 2406: Assignment 1 - Client-side Programming\* done/);
});

test("free-form: an answer with invented dates is retried, then replaced by the facts", async () => {
  const free = { ...base, mode: "free_text", due_only: false };
  let n = 0;
  const ai = { run: async (_m: string, input: any) => {
    if (input.response_format) return { response: free, usage: { neurons: 1 } };
    if (/Pick exactly the items/.test(input.messages[0].content)) return { response: "{}", usage: { neurons: 1 } };
    n++;
    return { response: "• Your big exam is on *Nov 30*", usage: { neurons: 1 } };
  } };
  const out = await answer("am i cooked", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.equal(n, 2, "asked twice");
  assert.doesNotMatch(out, /Nov 30/);
  assert.match(out, /Assignment 1/, "the real list instead");
});

test("free-form: 'tonight' about tomorrow's deadline is corrected", async () => {
  const free = { ...base, mode: "free_text", due_only: false };
  const ai = { run: async (_m: string, input: any) => input.response_format
    ? { response: free, usage: { neurons: 1 } }
    : { response: "• Knock out the PHYS 1905 Quiz - Sports Module tonight, it's due tonight", usage: { neurons: 1 } } };
  const out = await answer("what should i do", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.match(out, /due tomorrow night/);
});

test("never crashes: a broken store or AI still gets a reply, and every failure is reported", async () => {
  const bad: any = { get: async (k: string) => { if (k === "done") throw new Error("KV down"); return null; }, put: async () => {} };
  const alerts: string[] = [];
  const opts = { onFailure: async (m: string) => { alerts.push(m); } };
  const out = await answer("assignments due in the next 2 weeks", ITEMS, { chat_engine: "v1" }, bad, TZ, fetch, NOW, opts);
  assert.match(out, /^I hit a snag answering that 😕 Here's my best guess:\n\*2 assignments due/);
  // every failure is passed on (the Worker's reporter deduplicates)
  const kv = new Map<string, any>();
  const flaky: any = { get: async (k: string) => { if (k === "done") throw new Error("KV down"); return kv.get(k) ?? null; }, put: async (k: string, v: any) => { kv.set(k, v); } };
  for (let i = 0; i < 4; i++) await answer("hello there friend", ITEMS, { chat_engine: "v1" }, flaky, TZ, fetch, NOW + i * 1000, opts);
  assert.equal(alerts.length, 5);
  assert.match(alerts[4], /\(4 today\): “hello there friend”\. Error: KV down/);
});

test("nothing found -> a wider reading, saying what changed", async () => {
  const out = await answer("tests this week", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW);
  assert.match(out, /^No tests this week\. The next ones after that:/);
  assert.match(out, /Test 1/);
});

test("the AI picks which real items answer the question; code prints exactly those", async () => {
  const listFilter = { ...base, from: "2026-10-05", to: "2026-10-05", due_only: false, include_classes: true };
  let pool = "";
  const ai = { run: async (_m: string, input: any) => {
    const p: string = input.messages[0].content;
    if (!/Pick exactly the items/.test(p)) return { response: listFilter, usage: { neurons: 1 } };
    pool = p;
    const ids = [...p.matchAll(/\[(\d+)\][^\n]*\| Lecture \|/g)].map((m) => Number(m[1]));
    return { response: { ids: [...ids, 99], phrase: "lectures **tomorrow**" }, usage: { neurons: 1 } };
  } };
  const out = await answer("what lectures do i have tomorrow", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.match(pool, /kind: class[^]*kind: quiz \(due\)/, "the AI sees every kind in the window, classes and work");
  assert.match(out, /^\*\d+ lectures tomorrow\*/, "its phrase, cleaned of formatting");
  assert.match(out, /STAT 2507: Lecture/);
  assert.doesNotMatch(out, /Tutorial|Sports Module/, "only what it picked; the made-up #99 is ignored");

  const none = { run: async (_m: string, input: any) => /Pick exactly/.test(input.messages[0].content)
    ? { response: { ids: [], phrase: "labs tomorrow" }, usage: { neurons: 1 } } : { response: listFilter, usage: { neurons: 1 } } };
  assert.equal(await answer("any labs tomorrow", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => none.run(m, b)) }), "No labs tomorrow. 🎉");

  const junk = { run: async (_m: string, input: any) => /Pick exactly/.test(input.messages[0].content)
    ? { response: { ids: [500, 600], phrase: "x" }, usage: { neurons: 1 } } : { response: listFilter, usage: { neurons: 1 } } };
  assert.match(await answer("what's on tomorrow", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => junk.run(m, b)) }), /Sports Module/,
    "only impossible numbers: ignored, the filter's list stands");
});

test("picking: a named kind the AI overlooked is added back; plain-text JSON is read; 'no …' isn't doubled", async () => {
  const filter = { ...base, from: "2026-10-05", to: "2026-10-12", due_only: false, include_classes: true };
  const ai = { run: async (_m: string, input: any) => {
    const p: string = input.messages[0].content;
    if (!/Pick exactly the items/.test(p)) return { response: filter, usage: { neurons: 1 } };
    return { response: '```json\n{"ids": [], "phrase": "no tutorials this week"}\n```', usage: { neurons: 1 } };   // overlooked both
  } };
  const out = await answer("any tutorials this week", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.match(out, /^\*2 tutorials this week\*/, "both added back by the safety net; 'no' not doubled");
  assert.match(out, /Tutorial 3[^]*Tutorial 4/);
  const quiz = await answer("any quizzes this week", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW, { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.match(quiz, /Sports Module/, "no class words: the filter answers, no pick step");
});
