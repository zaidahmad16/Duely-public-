// The v2 agent (agent.ts) offline: kinds, time words, code-side selection, rendering, the lenient
// reply parsers, the fact checks, and the loop with a scripted fake model (incl. falling back to v1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmFromRun, llmOverFetch } from "./helpers.ts";
import { agentReply, fixCount, kindOf, pluralNext, whenFromQuestion, replyFromText, resolveWhen, resolveWindows, select, singular, unbacked } from "../src/core/agent.ts";
import { answer } from "../src/core/ask.ts";
import { memStore } from "../src/core/util.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const SUN = Date.parse("2026-10-04T20:00:00-04:00");
const WED = Date.parse("2026-10-07T12:00:00-04:00");
const titles = (occ: any[]) => occ.map((o) => `${o.it.title}@${o.day}`);

test("kinds come from code: (LEC) is a lecture, Brightspace 'assignment' tutorials are tutorial_work", () => {
  assert.equal(kindOf({ title: "Physics Behind Everyday Life (LEC)", type: "event", role: "event", rrule: "FREQ=WEEKLY" }), "lecture");
  assert.equal(kindOf({ title: "Tutorial", type: "class", role: "event" }), "tutorial");
  assert.equal(kindOf({ title: "Tutorial 3", type: "assignment", role: "deadline" }), "tutorial_work");
  assert.equal(kindOf({ title: "Test 1", type: "exam", role: "event" }), "test");
  assert.equal(kindOf({ title: "📖 Study for: Test 1", type: "study", source: "study" }), "study");
});

test("time words are resolved by code (weekends, next week, ISO ranges)", () => {
  assert.deepEqual(resolveWhen("tomorrow", TZ, SUN), ["2026-10-05", "2026-10-05"]);
  assert.deepEqual(resolveWhen("this week", TZ, SUN), ["2026-10-04", "2026-10-11"], "Sunday: the coming week");
  assert.deepEqual(resolveWhen("next week", TZ, SUN), ["2026-10-12", "2026-10-18"]);
  assert.deepEqual(resolveWhen("next week", TZ, WED), ["2026-10-12", "2026-10-18"]);
  assert.deepEqual(resolveWhen("2026-10-09..2026-10-12", TZ, WED), ["2026-10-09", "2026-10-12"]);
  assert.deepEqual(resolveWhen("2026-09-01", TZ, WED), ["2026-10-07", "2026-09-01"].sort().reverse().slice(0, 1).concat(["2026-09-01"]).slice(0, 2), "never the past");
});

test("select: 'work' = deadlines only; kinds exact; next = soonest with ties; done hidden", () => {
  const s = (a: any, now = SUN, items = ITEMS) => titles(select(a, items, TZ, now).occ);
  assert.deepEqual(s({ when: "this week", kinds: ["assignment"] }), ["Assignment 1 - Client-side Programming@2026-10-08", "Assignment 1@2026-10-09"]);
  assert.ok(!s({ when: "next 2 weeks", kinds: ["work"] }).some((x) => /Test 1|Review/.test(x)), "tests and events aren't 'due'");
  assert.deepEqual(s({ kinds: ["tutorial_work"], next: 1 }), ["Tutorial 3@2026-10-09", "Tutorial 4@2026-10-09"], "both, same time");
  assert.deepEqual(s({ when: "tomorrow", kinds: ["lecture"] }), ["Lecture@2026-10-05"]);
  const done = ITEMS.map((i) => (i.uid === "t1" ? { ...i, done: true } : i));
  assert.deepEqual(s({ kinds: ["test"], next: 1 }, SUN, done), [], "done work isn't 'next'");
});

test("reply parsing and count fixing", () => {
  assert.deepEqual(replyFromText('[{"name": "reply", "arguments": {"message": "Hi {n}", "show": {"courses": , "kinds": ["work"]}}}]'),
    { message: "Hi {n}", show: { courses: [], kinds: ["work"] } });
  assert.equal(replyFromText("Just some words"), null);
  assert.equal(fixCount("You have 4 assignments due", 2), "You have 2 assignments due");
  assert.equal(fixCount("Only one quiz this week", 0), "Only no quiz this week");
  assert.equal(fixCount("Test 1 is in 2 days", 1), "Test 1 is in 2 days", "not a count of items");
});

test("fact checks: unknown courses, times and bold names are caught", () => {
  const shown = select({ when: "this week", kinds: ["assignment"] }, ITEMS, TZ, SUN).occ;
  assert.deepEqual(unbacked("You've got 2 assignments, the COMP 2406 one first.", shown, ITEMS, TZ), []);
  assert.equal(unbacked("COMP 9999 has a final", shown, ITEMS, TZ).length, 1);
  assert.equal(unbacked("It's due at 3 PM", shown, ITEMS, TZ).length, 1);
  assert.deepEqual(unbacked("It's due at 11:59 PM", shown, ITEMS, TZ), []);
  assert.equal(unbacked("Don't forget *Secret Final Exam*", shown, ITEMS, TZ).length, 1);
});

/** A scripted model: each call returns the next step. */
function scripted(steps: any[]) {
  const seen: any[] = [];
  return { seen, run: async (_m: string, input: any) => { seen.push(input); const s = steps.shift() ?? { content: "" }; return { choices: [{ message: s }], usage: { prompt_tokens: 100, completion_tokens: 20 } }; } };
}
const callReply = (args: any) => ({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "reply", arguments: JSON.stringify(args) } }] });

test("loop: a tool call, then reply with show -> exactly the code-selected items, numbered, with the real count", async () => {
  const ai = scripted([
    { content: null, tool_calls: [{ id: "t1", function: { name: "search_items", arguments: '{"when":"next week","kinds":["test"]}' } }] },
    callReply({ message: "You have 7 assignments due this week, hang in there!", show: { when: "this week", kinds: ["assignment"] } }),
  ]);
  const r = await agentReply("how many assignments this week", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.ok(r);
  assert.match(r!.text, /^You have 2 assignments due this week, hang in there!\n\n\*Thu Oct 8\*\n1\. 11:59 PM  COMP 2406: Assignment 1/);
  assert.deepEqual(r!.refs.length, 2);
  assert.match(ai.seen[1].messages.at(-1).content, /Test 1/, "the tool result went back to the model");
  assert.match(ai.seen[0].messages[0].content, /It is Sunday October 4 2026/, "the model is told the date");
});

test("loop: invented facts get one repair, then the v1 answer takes over; the student always gets a real list", async () => {
  const bad = () => callReply({ message: "Your *Secret Final* in COMP 9999 is at 3 PM." });
  const ai = scripted([bad(), bad()]);
  assert.equal(await agentReply("whats due", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) }), null);
  assert.match(ai.seen[1].messages.at(-1).content, /aren't in the calendar/);
  // through answer(): agent on, but it fails -> v1 (rules here) answers
  const store = memStore();
  const out = await answer("assignments due this week", ITEMS, { chat_engine: "agent" }, store, TZ, fetch, SUN,
    { llm: llmFromRun((m: string, b: any) => scripted([bad(), bad(), bad(), bad()]).run(m, b)) });
  assert.match(out, /Client-side Programming/);
  assert.doesNotMatch(out, /Secret|9999/);
});

test("more time words: the 9th, oct 12, before/by a weekday, the day after tomorrow", () => {
  assert.deepEqual(resolveWhen("on the 9th", TZ, SUN), ["2026-10-09", "2026-10-09"]);
  assert.deepEqual(resolveWhen("oct 12", TZ, SUN), ["2026-10-12", "2026-10-12"]);
  assert.deepEqual(resolveWhen("12th of october", TZ, SUN), ["2026-10-12", "2026-10-12"]);
  assert.deepEqual(resolveWhen("before thursday", TZ, SUN), ["2026-10-04", "2026-10-07"]);
  assert.deepEqual(resolveWhen("by thursday", TZ, SUN), ["2026-10-04", "2026-10-08"]);
  assert.deepEqual(resolveWhen("the day after tomorrow", TZ, SUN), ["2026-10-06", "2026-10-06"]);
});

test("an empty window: code says so and shows the next ones, whatever the model wrote", async () => {
  const ai = scripted([callReply({ message: "You have Test 1 soon!", show: { kinds: ["test"], when: "this week" } })]);
  const r = await agentReply("when is test 1", ITEMS, TZ, Date.parse("2026-10-06T12:00:00-04:00"), [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.match(r!.text, /^No tests in the next 5 days\. Here's what's next\.\n\n\*Mon Oct 12\*\n• 10:00 AM  STAT 2507: Test 1/);
  const none = scripted([callReply({ message: "You have 0 labs", show: { kinds: ["lab_work"], when: "this week" } })]);
  assert.match((await agentReply("labs?", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => none.run(m, b)) }))!.text, /^No labs due (this week|in the next \d+ days)\. 🎉$/);
});

test("announcement questions are handed to the v1 reader (real posts, real links)", async () => {
  const ai = scripted([{ content: null, tool_calls: [{ id: "a", function: { name: "announcements", arguments: '{"courses":["STAT 2507"],"topic":"midterm"}' } }] }]);
  const r = await agentReply("what did the stats prof say about the midterm", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.deepEqual(r?.handoff, { courses: ["STAT 2507"], topic: "midterm" });
});

test("live misses 2026-10-09: exact titles win, 'midterm' finds Test 1, 'assignments' means assignments, empty days show what's after", async () => {
  assert.deepEqual(titles(select({ text: "test 1", next: 1 }, ITEMS, TZ, SUN).occ), ["Test 1@2026-10-12"], "not the Review Session");
  const mid = scripted([callReply({ message: "Your stats midterm:", show: { kinds: ["test"], courses: ["STAT 2507"], text: "midterm", next: 1 } })]);
  assert.match((await agentReply("when is the stat midterm", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => mid.run(m, b)) }))!.text, /STAT 2507: Test 1/);
  const broad = scripted([callReply({ message: "You have {n} assignments due", show: { kinds: ["work"], when: "next 2 weeks" } })]);
  const r = await agentReply("ok so basically what assignments do i have due", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => broad.run(m, b)) });
  assert.doesNotMatch(r!.text, /Tutorial 3|Sports Module/);
  assert.match(r!.text, /^You have 2 assignments due/);
  const empty = scripted([callReply({ message: "Nothing!", show: { kinds: ["work"], when: "the day after tomorrow" } })]);
  const e = (await agentReply("what's due the day after tomorrow", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => empty.run(m, b)) }))!.text;
  assert.match(e, /^No deadlines on Tue Oct 6\. Here's what's next\./);
  assert.match(e, /Client-side/);
  assert.doesNotMatch(e, /Sports Module/, "Mon's quiz is before that day, not after");
});

test("'what's my next quiz' with no kind from the model still means quizzes", async () => {
  const ai = scripted([callReply({ message: "Your next quiz:", show: { next: 1 } })]);
  assert.match((await agentReply("what's my next quiz", ITEMS, TZ, Date.parse("2026-10-05T00:30:00-04:00"), [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) }))!.text, /PHYS 1905: Quiz - Sports Module/);
});

test("grammar: one of something is singular", () => {
  assert.equal(singular("You have 1 deadlines this week"), "You have 1 deadline this week");
  assert.equal(singular("You have 1 upcoming tutorials for STAT 2507"), "You have 1 upcoming tutorial for STAT 2507");
  assert.equal(singular("1 quizzes and 1 classes"), "1 quiz and 1 class");
  assert.equal(singular("You have 11 deadlines"), "You have 11 deadlines");
});

test("months: this month, next month, both, month names (2026-10-09: 'this month and next month' skipped October)", () => {
  const FRI = Date.parse("2026-10-09T15:50:00-04:00");
  assert.deepEqual(resolveWhen("this month and next month", TZ, FRI), ["2026-10-09", "2026-11-30"]);
  assert.deepEqual(resolveWhen("this month", TZ, FRI), ["2026-10-09", "2026-10-31"]);
  assert.deepEqual(resolveWhen("next month", TZ, FRI), ["2026-11-01", "2026-11-30"]);
  assert.deepEqual(resolveWhen("in november", TZ, FRI), ["2026-11-01", "2026-11-30"]);
  assert.deepEqual(resolveWhen("october and november", TZ, FRI), ["2026-10-09", "2026-11-30"]);
  assert.deepEqual(resolveWhen("in january", TZ, FRI), ["2027-01-01", "2027-01-31"]);
  assert.deepEqual(resolveWhen("oct 12", TZ, FRI), ["2026-10-12", "2026-10-12"], "a day in a month is still a day");
});

test("stress about a course shows its tests and deadlines, not its lectures", async () => {
  const ai = scripted([callReply({ message: "You've got this. Here's what's coming for stats:", show: { courses: ["STAT 2507"], kinds: ["lecture"], when: "this week" } })]);
  const r = await agentReply("im stressed about stats", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.match(r!.text, /STAT 2507: Test 1/);
  assert.doesNotMatch(r!.text, /Lecture/);
});

test("'X and Y' time phrases: each part counts (2026-10-09 screenshot: 'next week and next month' lost next week)", () => {
  const FRI = Date.parse("2026-10-09T18:28:00-04:00");
  assert.deepEqual(resolveWindows("next week and next month", TZ, FRI), [["2026-10-12", "2026-10-18"], ["2026-11-01", "2026-11-30"]]);
  assert.deepEqual(resolveWindows("today and tomorrow", TZ, FRI), [["2026-10-09", "2026-10-09"], ["2026-10-10", "2026-10-10"]]);
  assert.deepEqual(resolveWindows("this week", TZ, FRI), [["2026-10-09", "2026-10-11"]]);
  assert.deepEqual(resolveWindows("2026-10-12..2026-10-18", TZ, FRI), [["2026-10-12", "2026-10-18"]]);
  const items = [
    { uid: "t1", course: "STAT 2507", title: "Test 1", type: "exam", role: "event", start: "2026-10-17T10:00:00-04:00", end: "2026-10-17T11:30:00-04:00", keep: true },
    { uid: "x", course: "STAT 2507", title: "Test X", type: "exam", role: "event", start: "2026-10-27T10:00:00-04:00", end: "2026-10-27T11:30:00-04:00", keep: true },
    { uid: "t2", course: "STAT 2507", title: "Test 2", type: "exam", role: "event", start: "2026-11-22T10:00:00-05:00", end: "2026-11-22T11:30:00-05:00", keep: true },
  ];
  assert.deepEqual(titles(select({ kinds: ["test"], when: "next week and next month" }, items, TZ, FRI).occ), ["Test 1@2026-10-17", "Test 2@2026-11-22"], "not the gap in between");
});

test("live sweep 2026-10-09: 'this month or next', 'between now and nov 30', plural 'when are my midterms'", () => {
  const FRI = Date.parse("2026-10-09T18:40:00-04:00");
  assert.deepEqual(resolveWindows("this month or next", TZ, FRI), [["2026-10-09", "2026-10-31"], ["2026-11-01", "2026-11-30"]]);
  assert.deepEqual(resolveWindows("this week and next", TZ, FRI), [["2026-10-09", "2026-10-11"], ["2026-10-12", "2026-10-18"]]);
  assert.deepEqual(resolveWhen("between now and november 30", TZ, FRI), ["2026-10-09", "2026-11-30"]);
  assert.deepEqual(resolveWhen("until friday", TZ, FRI), ["2026-10-09", "2026-10-09"]);
  assert.deepEqual(resolveWhen("up to oct 20", TZ, FRI), ["2026-10-09", "2026-10-20"]);
  assert.deepEqual(resolveWindows("between now and november 30", TZ, FRI), [["2026-10-09", "2026-11-30"]], "a range is one window, not two parts");
  assert.deepEqual(pluralNext("when are my midterms", { kinds: ["test"], next: 1 }), { kinds: ["test"], when: "rest of the term" });
  assert.deepEqual(pluralNext("when is my next test", { kinds: ["test"], next: 1 }), { kinds: ["test"], next: 1 });
  assert.deepEqual(pluralNext("when is test 1", { kinds: ["test"], next: 1 }), { kinds: ["test"], next: 1 });
});

test("range grammar (2026-10-09 live sweep, 21 phrasings): before/after/between/from-to/until/the week after", () => {
  const FRI = Date.parse("2026-10-09T18:40:00-04:00");
  const w = (x: string) => resolveWhen(x, TZ, FRI), ws = (x: string) => resolveWindows(x, TZ, FRI);
  assert.deepEqual(w("before november"), ["2026-10-09", "2026-10-31"]);
  assert.deepEqual(w("after october"), ["2026-11-01", "2027-04-30"]);
  assert.deepEqual(w("before the 21st"), ["2026-10-09", "2026-10-20"]);
  assert.deepEqual(w("before thursday"), ["2026-10-09", "2026-10-14"]);
  assert.deepEqual(w("by thursday"), ["2026-10-09", "2026-10-15"]);
  assert.deepEqual(w("from oct 15 to oct 20"), ["2026-10-15", "2026-10-20"]);
  assert.deepEqual(w("oct 15 to oct 20"), ["2026-10-15", "2026-10-20"]);
  assert.deepEqual(w("between oct 14 and oct 21"), ["2026-10-14", "2026-10-21"]);
  assert.deepEqual(w("between now and nov 30"), ["2026-10-09", "2026-11-30"]);
  assert.deepEqual(w("until the 20th"), ["2026-10-09", "2026-10-20"]);
  assert.deepEqual(w("up to oct 20"), ["2026-10-09", "2026-10-20"]);
  assert.deepEqual(w("after the 20th"), ["2026-10-21", "2027-04-19"]);
  assert.deepEqual(ws("next week and the week after"), [["2026-10-12", "2026-10-18"], ["2026-10-19", "2026-10-25"]]);
  assert.deepEqual(ws("between oct 14 and oct 21"), [["2026-10-14", "2026-10-21"]], "between … and … is one range");
  assert.deepEqual(ws("next week or the week after"), [["2026-10-12", "2026-10-18"], ["2026-10-19", "2026-10-25"]]);
  assert.deepEqual(w("tomorrow"), ["2026-10-10", "2026-10-10"], "plain words unchanged");
  assert.deepEqual(w("this week"), ["2026-10-09", "2026-10-11"]);
});

test("the student's own time words win over the model's paraphrase", async () => {
  const FRI = Date.parse("2026-10-09T18:40:00-04:00");
  const q = (x: string) => whenFromQuestion(x, TZ, FRI);
  assert.equal(q("whats due next week and the week after"), "next week and the week after");
  assert.equal(q("What test do I have next week and next month?"), "next week and next month");
  assert.equal(q("tests in october or november"), "october or november");
  assert.equal(q("whats due for comp 2406 before the 21st"), "before the 21st");
  assert.equal(q("am i cooked"), null);
  assert.equal(q("whats due"), null);
  assert.equal(q("what's due in the next 2 weeks"), "the next 2 weeks");
  const ai = scripted([callReply({ message: "You have {n} work due", show: { kinds: ["work"], when: "next 2 weeks" } })]);
  const r = await agentReply("whats due next week and the week after", ITEMS, TZ, SUN, [], { llm: llmFromRun((m: string, b: any) => ai.run(m, b)) });
  assert.doesNotMatch(r!.text, /Sports Module/, "Mon Oct 5 is 'this week' on Sunday, not next week");
  assert.match(r!.text, /^No deadlines Oct 12 – Oct 25\. 🎉$/, "nothing due in either week; the message covers both");
  assert.equal(singular("You have 5 work due next week"), "You have 5 things due next week");
});

test("narrowKinds: one kind named wins over a broader pick; tutorial classes are the timetable (2026-10-10 live eval)", async () => {
  const { narrowKinds } = await import("../src/core/agent.ts");
  const broad = { when: "this week", kinds: ["assignment", "quiz", "tutorial_work"] };
  assert.deepEqual(narrowKinds("assignments due this week", broad).kinds, ["assignment"]);
  assert.deepEqual(narrowKinds("when are my tutorial classes this week", { when: "this week", kinds: ["tutorial_work"] }).kinds, ["tutorial"]);
  assert.deepEqual(narrowKinds("lab sections tomorrow?", { kinds: ["lab_work"] }).kinds, ["lab"]);
  for (const q of ["assignments and quizzes this week", "when is the quiz review session", "tutorials due friday", "what's due this week"]) {
    assert.deepEqual(narrowKinds(q, broad), broad, q);
  }
});
