// Chatting with the Slack bot: categories, the rule parser, the filter -> reply step, the AI chain
// (Mistral -> rules) and the signed Slack endpoint. The fixture mirrors the real calendar
// on 2026-10-04, where "assignments due in the next two weeks" used to answer with 1 item, not 2.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { llmFromRun, llmOverFetch } from "./helpers.ts";
import { answer, describeRange, execute, parseQuery, slackify, validIntent } from "../src/core/ask.ts";
import { category } from "../src/core/kinds.ts";
import { memStore } from "../src/core/util.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-04T12:00:00-04:00");   // a Sunday, noon
const T = "2026-10-04";

const dl = (course: string, title: string, at: string, type = "assignment", extra: any = {}) =>
  ({ course, title, type, role: "deadline", start: at, end: at, keep: true, location: `${course.replace(" ", "")}A Course (LEC) Fall 2026`, ...extra });
const ITEMS = [
  dl("PHYS 1905", "Quiz - Sports Module", "2026-10-05T23:59:00-04:00", "quiz"),
  dl("COMP 2406", "Assignment 1 - Client-side Programming", "2026-10-08T23:59:00-04:00"),
  dl("COMP 2406", "Tutorial 3", "2026-10-09T10:00:00-04:00"),
  dl("COMP 2406", "Tutorial 4", "2026-10-09T10:00:00-04:00"),
  dl("FILM 1101", "Optional Quiz 3", "2026-10-09T23:59:00-04:00", "quiz"),
  dl("COMP 3106", "Assignment 1", "2026-10-09T23:59:00-04:00"),
  { course: "STAT 2507", title: "Test 1 Review Session", type: "event", role: "event", start: "2026-10-11T13:00:00-04:00", end: "2026-10-11T14:00:00-04:00", keep: true, announced: true },
  dl("PHYS 1905", "Weather and Climate Module", "2026-10-15T23:59:00-04:00"),
  { course: "STAT 2507", title: "Test 1", type: "exam", role: "event", start: "2026-10-17T10:00:00-04:00", end: "2026-10-17T11:30:00-04:00", keep: true, announced: true },
  dl("PHYS 1905", "Lab Report Submission 1", "2026-10-20T23:59:00-04:00"),
  dl("COMP 2406", "Assignment 2 - Server-side Programming", "2026-11-05T23:59:00-05:00"),
  { course: "COMP 2406", title: "Tutorial", type: "class", role: "event", start: "2026-09-11T10:05:00-04:00", end: "2026-09-11T11:25:00-04:00",
    rrule: "FREQ=WEEKLY;UNTIL=20261210T173000Z;INTERVAL=1;BYDAY=FR", location: "MC 2000", keep: true },
  dl("COMP 3106", "Hidden", "2026-10-06T23:59:00-04:00", "assignment", { keep: false }),
];

const titles = (s: string) => [...s.matchAll(/^(?:•|\d+\.) \S+ \S+  (.+?)(?: \(due\)| _\(| ·| ✓|$)/gm)].map((m) => m[1]);

test("category: real titles land in the right bucket", () => {
  const cat = (t: string) => category(ITEMS.find((i) => i.title === t));
  assert.equal(cat("Assignment 1 - Client-side Programming"), "assignment");
  assert.equal(cat("Tutorial 3"), "tutorial");
  assert.equal(cat("Weather and Climate Module"), "module");
  assert.equal(cat("Lab Report Submission 1"), "lab");
  assert.equal(cat("Quiz - Sports Module"), "quiz", "a quiz about a module is a quiz");
  assert.equal(cat("Test 1"), "test");
  assert.equal(cat("Test 1 Review Session"), "event", "a review session isn't a test");
  assert.equal(cat("Tutorial"), "class", "the weekly tutorial class");
  assert.equal(category({ title: "Test 2", type: "quiz", role: "deadline" }), "test", "Brightspace types tests as quizzes");
  assert.equal(category({ title: "A3 submission", type: "assignment", role: "deadline" }), "assignment");
});

test("rules: the two questions that went wrong", () => {
  const q1 = parseQuery("assignments due in the next two weeks", TZ, NOW)!;
  assert.deepEqual([q1.mode, q1.from, q1.to, q1.categories, q1.limit], ["list", T, "2026-10-18", ["assignment"], null]);
  const a1 = execute(q1, ITEMS, TZ, NOW);
  assert.deepEqual(titles(a1), ["COMP 2406: Assignment 1 - Client-side Programming", "COMP 3106: Assignment 1"]);
  assert.match(a1, /^\*2 assignments due in the next 2 weeks\*/);

  const q2 = parseQuery("assignments due", TZ, NOW)!;
  assert.equal(q2.to, "2026-10-18");
  const a2 = execute(q2, ITEMS, TZ, NOW);
  assert.deepEqual(titles(a2), ["COMP 2406: Assignment 1 - Client-side Programming", "COMP 3106: Assignment 1"]);
  assert.match(a2, /1 more later this term \(next: COMP 2406 Assignment 2 - Server-side Programming, Thu Nov 5\)/,
    "Assignment 2 (Nov 5) is pointed to, not dumped");
});

test("rules: ranges, 'next', counts and categories", () => {
  const p = (s: string) => parseQuery(s, TZ, NOW)!;
  assert.equal(p("anything due in a few days").to, "2026-10-07");
  assert.equal(p("what's due in the next 3 weeks").to, "2026-10-25");
  assert.equal(p("within a week").to, "2026-10-11");
  assert.deepEqual([p("next test").mode, p("next test").limit], ["next", 1]);
  assert.deepEqual([p("next 3 assignments").mode, p("next 3 assignments").limit], ["next", 3]);
  assert.deepEqual([p("next two assignments").limit], [2]);
  assert.deepEqual([p("next 3 comp 2406 assignments").mode, p("next 3 comp 2406 assignments").limit,
    p("next 3 comp 2406 assignments").courses], ["next", 3, ["COMP 2406"]]);
  assert.match(execute(p("any labs coming up?"), ITEMS, TZ, NOW),
    /^No labs due in the next 2 weeks\. The next ones after that:\n\n\*1 lab due for the rest of the term\*\n\n\*Tue Oct 20\*\n1\. 11:59 PM  PHYS 1905: Lab Report Submission 1/);
  assert.equal(p("assignments due next week").mode, "list", "'next week' is a time, not 'the next one'");
  assert.deepEqual([p("how many quizzes this month").mode], ["count"]);
  assert.deepEqual(p("tutorials and labs due next week").categories, ["tutorial", "lab"]);
  assert.equal(p("what's due this week").due_only, true);
  assert.equal(parseQuery("tell me a joke", TZ, NOW), null);

  const a = (s: string) => execute(p(s), ITEMS, TZ, NOW);
  assert.deepEqual(titles(a("next test")), ["STAT 2507: Test 1"]);
  assert.deepEqual(titles(a("next 3 assignments")), ["COMP 2406: Assignment 1 - Client-side Programming", "COMP 3106: Assignment 1",
    "COMP 2406: Assignment 2 - Server-side Programming"]);
  assert.deepEqual(titles(a("tutorials due this week")), ["COMP 2406: Tutorial 3", "COMP 2406: Tutorial 4"],
    "on a Sunday, 'this week' is the coming week");
  assert.match(a("what's due this week"), /^\*6 deadlines this week\*/);
  assert.deepEqual(titles(a("tutorials due this week")), ["COMP 2406: Tutorial 3", "COMP 2406: Tutorial 4"], "on a Sunday, this week = the coming Mon–Sun");
  assert.deepEqual(titles(a("tutorials due next week")), [], "and next week = the one after");
  assert.deepEqual(titles(a("what's due in the next 5 days")), ["PHYS 1905: Quiz - Sports Module",
    "COMP 2406: Assignment 1 - Client-side Programming", "COMP 2406: Tutorial 3", "COMP 2406: Tutorial 4",
    "FILM 1101: Optional Quiz 3", "COMP 3106: Assignment 1"]);
  assert.match(a("friday"), /10:05 AM  COMP 2406: Tutorial · MC 2000/, "a single day includes classes");
  assert.match(a("how many quizzes this month"), /^\*You have 2 quizzes due in the next 30 days\.\*/);
  assert.equal(a("any COMP 3106 tests?"), "No COMP 3106 tests for the rest of the term. 🎉");
});

test("describeRange reads naturally", () => {
  assert.equal(describeRange(T, T, TZ, NOW), "today");
  assert.equal(describeRange("2026-10-05", "2026-10-05", TZ, NOW), "tomorrow");
  assert.equal(describeRange("2026-10-09", "2026-10-09", TZ, NOW), "on Fri Oct 9");
  assert.equal(describeRange("2026-10-05", "2026-10-11", TZ, NOW), "this week", "Sunday: the coming week");
  assert.equal(describeRange("2026-10-12", "2026-10-18", TZ, NOW), "next week");
  assert.equal(describeRange(T, "2026-10-18", TZ, NOW), "in the next 2 weeks");
  assert.equal(describeRange(T, "2026-10-07", TZ, NOW), "in the next 3 days");
  assert.equal(describeRange("2026-10-12", "2026-10-25", TZ, NOW), "Oct 12 – Oct 25");
  assert.equal(describeRange("2026-11-01", "2026-11-30", TZ, NOW), "in November");
  assert.equal(describeRange(T, "2026-10-31", TZ, NOW), "in October");
});

test("validIntent: trusts only well-formed filters", () => {
  const ok = { mode: "list", from: T, to: "2026-10-18", courses: ["comp2406"], categories: ["assignment", "bogus"], due_only: true, include_classes: false, limit: null };
  assert.deepEqual(validIntent(ok, T), { ...ok, courses: ["COMP 2406"], categories: ["assignment"] });
  assert.deepEqual([validIntent({ ...ok, from: "2026-10-20", to: "2026-10-05" }, T)!.from, validIntent({ ...ok, from: "2026-10-20", to: "2026-10-05" }, T)!.to],
    ["2026-10-05", "2026-10-20"], "swapped dates are swapped back");
  assert.deepEqual(validIntent({ ...ok, categories: ["Midterms", "homework", "Quizzes"] }, T)!.categories, ["test", "quiz"], "AI wording mapped to categories");
  assert.equal(validIntent({ ...ok, mode: "Free Text" }, T)!.mode, "free_text");
  assert.equal(validIntent({ ...ok, courses: ["CS 3106"] }, T, ["COMP 3106", "STAT 2507"])!.courses[0], "COMP 3106", "a course by its number");
  assert.equal(validIntent({ ...ok, to: "soon" }, T), null);
  assert.equal(validIntent({ ...ok, mode: "dance" }, T), null);
  assert.equal(validIntent({ ...ok, from: "2026-09-01" }, T)!.from, T, "never looks into the past");
});

const PICK = /Pick exactly the items/;

/** A fake Mistral: returns `intent` for filter prompts, `text` for free-form ones; records every call. */
function fakeAI(opts: { intent?: any; mistralStatus?: number; text?: string }) {
  const calls: { who: string; body: any; auth?: string }[] = [];
  const f = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (PICK.test(body.messages?.[0]?.content ?? "")) return Response.json({ choices: [{ message: { content: "{}" } }] });   // no pick: the filter decides
    if (String(url).includes("api.mistral.ai")) {
      calls.push({ who: "mistral", body, auth: init.headers.authorization });
      if (opts.mistralStatus && opts.mistralStatus !== 200) return new Response('{"message":"nope"}', { status: opts.mistralStatus });
      const content = body.response_format ? JSON.stringify(opts.intent) : (opts.text ?? "free answer");
      return Response.json({ choices: [{ message: { content } }] });
    }
    calls.push({ who: String(url), body });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { calls, f };
}

const AI_TWO_WEEKS = { mode: "list", from: T, to: "2026-10-18", courses: [], categories: ["assignment"], due_only: true, include_classes: false, limit: null };

test("the provider's filter is executed by code (JSON mode + schema in the prompt, key sent)", async () => {
  const store = memStore();
  const { calls, f } = fakeAI({ intent: AI_TWO_WEEKS });
  const out = await answer("what assignments do i have coming up in the next fortnight", ITEMS, { chat_engine: "v1" }, store, TZ, f, NOW, { llm: llmOverFetch(f, undefined, "mk") });
  assert.deepEqual(titles(out), ["COMP 2406: Assignment 1 - Client-side Programming", "COMP 3106: Assignment 1"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].who, "mistral");
  assert.equal(calls[0].auth, "Bearer mk");
  assert.equal(calls[0].body.response_format.type, "json_object", "JSON mode (the most widely supported)");
  assert.match(calls[0].body.messages[0].content, /matching this JSON schema:\n\{"type":"object"/, "the schema goes in the prompt");
  assert.match(calls[0].body.messages[0].content, /Their courses: COMP 2406 \(Course\), COMP 3106 \(Course\), FILM 1101 \(Course\), PHYS 1905 \(Course\), STAT 2507\./,
    "course codes, with names when the item's location gives one");
  const sess: any = await store.get("chat-session");
  assert.deepEqual([sess.date, sess.requests], [T, 1], "one AI request, one session write (assignments are exact: no pick call)");
});

test("AI chain: Mistral down -> rules; garbage -> rules", async () => {
  let ai = fakeAI({ intent: AI_TWO_WEEKS, mistralStatus: 401 });
  let out = await answer("assignments in the next fortnight", ITEMS, { chat_engine: "v1" }, memStore(), TZ, ai.f, NOW, { llm: llmOverFetch(ai.f, undefined, "bad") });
  assert.deepEqual(ai.calls.map((c) => c.who), ["mistral"], "a bad key isn't retried");
  assert.equal(titles(out).length, 2);

  ai = fakeAI({ intent: AI_TWO_WEEKS, mistralStatus: 429 });
  out = await answer("assignments due in the next two weeks", ITEMS, { chat_engine: "v1" }, memStore(), TZ, ai.f, NOW, { llm: llmOverFetch(ai.f, undefined, "k") });
  assert.deepEqual(titles(out), ["COMP 2406: Assignment 1 - Client-side Programming", "COMP 3106: Assignment 1"], "rules still right");

  ai = fakeAI({ intent: { mode: "list", from: "yesterday" } });
  out = await answer("assignments due in the next two weeks", ITEMS, { chat_engine: "v1" }, memStore(), TZ, ai.f, NOW, { llm: llmOverFetch(ai.f, undefined, "k") });
  assert.equal(titles(out).length, 2, "an invalid filter falls back to the rules");
});

test("AI chain: free-form questions are answered from only the filtered items", async () => {
  const { calls, f } = fakeAI({ intent: { mode: "free_text", from: "2026-10-05", to: "2026-10-11", courses: [], categories: [], due_only: false, include_classes: false, limit: null },
    text: "Friday Oct 9 is busiest." });
  const out = await answer("which day this week is busiest?", ITEMS, { chat_engine: "v1" }, memStore(), TZ, f, NOW, { llm: llmOverFetch(f, undefined, "k") });
  assert.equal(out, "Friday Oct 9 is busiest.");
  const second = calls[1].body.messages[0].content;
  assert.match(second, /Tutorial 3/);
  assert.doesNotMatch(second, /Lab Report|Assignment 2/, "items outside the filter aren't shown to the AI");
  assert.equal(calls[1].body.response_format, undefined);
});

test("help, thanks and no AI at all", async () => {
  assert.match(await answer("help", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW), /^Hi! Ask me anything/);
  const { f } = fakeAI({ intent: { mode: "help", from: T, to: T, courses: [], categories: [], due_only: false, include_classes: false, limit: null } });
  assert.equal(await answer("thanks!", ITEMS, { chat_engine: "v1" }, memStore(), TZ, f, NOW, { llm: llmOverFetch(f, undefined, "k") }), "Any time! 👍");
  assert.match(await answer("tell me a joke", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW), /^I'm best with questions about your courses and deadlines/);
});

function signed(body: string, secret = "shh", ts = Math.floor(Date.now() / 1000)) {
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return new Request("https://w/slack/events", { method: "POST", body,
    headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig, "content-type": "application/json" } });
}

test("an AI listing every course means any course", () => {
  const known = ["COMP 2406", "COMP 3106", "STAT 2507"];
  const x = { mode: "list", from: T, to: "2026-10-18", courses: ["COMP 2406", "COMP 3106", "STAT 2507"], categories: [], due_only: true, include_classes: false, limit: null };
  assert.deepEqual(validIntent(x, T, known)!.courses, []);
  assert.deepEqual(validIntent({ ...x, courses: ["comp 2406"] }, T, known)!.courses, ["COMP 2406"]);
});

test("slackify: Markdown from the AI becomes Slack formatting", () => {
  assert.equal(slackify("### Plan\n* **Mon Oct 5** quiz\n- __maybe__ A1"), "*Plan*\n• *Mon Oct 5* quiz\n• _maybe_ A1");
});

test("rules: thanks and month names", async () => {
  assert.equal(parseQuery("thanks!", TZ, NOW)!.mode, "help");
  assert.equal(await answer("thank you", ITEMS, { chat_engine: "v1" }, memStore(), TZ, fetch, NOW), "Any time! 👍");
  const nov = parseQuery("do I have any exams in november", TZ, NOW)!;
  assert.deepEqual([nov.from, nov.to, nov.categories], ["2026-11-01", "2026-11-30", ["test"]]);
  assert.equal(execute(nov, ITEMS, TZ, NOW), "No tests in November. 🎉");
  assert.equal(parseQuery("what's due in october", TZ, NOW)!.from, T, "this month starts today, not in the past");
});

const RSS = (course: string, items: [string, string, string][]) => `<rss><channel><title>Announcements - ${course.replace(" ", "")}A Course (LEC)</title>`
  + items.map(([title, body, days], i) => `<item><title>${title}</title><link>https://bs.example/${course.replace(" ", "")}/${i}</link><guid>${course}${i}</guid>`
    + `<pubDate>${new Date(NOW - Number(days) * 864e5).toUTCString()}</pubDate><description>&lt;p&gt;${body}&lt;/p&gt;</description></item>`).join("")
  + `</channel></rss>`;
const FEEDS: Record<string, string> = {
  "https://bs.example/rss/stat": RSS("STAT 2507", [["Test 1 details", "Test 1 is on Oct 17 at 10am in SA 515 and covers chapters 1-4.", "2"],
    ["Office hours moved", "Office hours are Thursday this week.", "5"]]),
  "https://bs.example/rss/comp": RSS("COMP 3106", [["Welcome", "Welcome to the course!", "40"], ["A1 hints", "Use BFS for question 2.", "1"]]),
};

test("announcements: rules find the post and link it when there's no AI", async () => {
  const f = (async (url: any) => new Response(FEEDS[String(url)] ?? "nope", { status: FEEDS[String(url)] ? 200 : 404 })) as typeof fetch;
  const cfg = { announcement_feeds: Object.keys(FEEDS) };
  const out = await answer("what did the prof say about the test?", ITEMS, cfg, memStore(), TZ, f, NOW);
  assert.match(out, /^\*Recent announcements about “test”:\*\n• \S+ \S+ \d+  STAT 2507: <https:\/\/bs\.example\/STAT2507\/0\|Test 1 details>/);
  assert.doesNotMatch(out, /Welcome/, "older than 30 days");
  const mid = await answer("What did the prof say about the mid term", ITEMS, cfg, memStore(), TZ, f, NOW);
  assert.match(mid, /about “midterm”:\*\n• .*Test 1 details/, "a midterm is called Test 1 in the course");
  const comp = await answer("any COMP 3106 announcements", ITEMS, cfg, memStore(), TZ, f, NOW);
  assert.match(comp, /A1 hints/);
  assert.doesNotMatch(comp, /STAT 2507/);
});

test("announcements: the AI answers from the posts and cites them", async () => {
  const calls: any[] = [];
  const f = (async (url: any, init: any) => {
    if (FEEDS[String(url)]) return new Response(FEEDS[String(url)]);
    const body = JSON.parse(init.body);
    calls.push(body);
    const intent = { mode: "announcements", from: T, to: T, courses: [], categories: [], due_only: false, include_classes: false, limit: null, target: "", topic: "midterm test" };
    const content = body.response_format ? JSON.stringify(intent) : "• **Test 1** is Oct 17 at 10am in SA 515 [1]";
    return Response.json({ choices: [{ message: { content } }] });
  }) as typeof fetch;
  const out = await answer("what did my stats prof say about the midterm", ITEMS, { chat_engine: "v1", announcement_feeds: Object.keys(FEEDS) }, memStore(), TZ, f, NOW, { llm: llmOverFetch(f, undefined, "k") });
  assert.equal(out, "• *Test 1* is Oct 17 at 10am in SA 515 (<https://bs.example/STAT2507/0|Test 1 details>)",
    "Slack bold, and [1] became the real link");
  const prompt = calls[1].messages[0].content;
  assert.match(prompt, /covers chapters 1-4/);
  assert.doesNotMatch(prompt, /https:\/\/bs\.example/, "links are added by code, not written by the AI");
  assert.match(prompt, /Test 1.* IS its midterm/);
  assert.match(prompt, /CALENDAR TESTS[^]*STAT 2507 \| test \| Test 1/, "their real tests from the calendar");
  assert.match(prompt.split("QUESTION")[0], /\[1\] STAT 2507 \| posted \S+ \S+ \d+ \| Test 1 details/, "best match first");
});
