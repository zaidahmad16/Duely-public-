// Study blocks: placed back from due dates, around classes, stable over time, gone when done.
import assert from "node:assert/strict";
import { test } from "node:test";
import { studyItems } from "../src/core/study.ts";
import { eventBody } from "../src/core/sync.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-04T12:00:00-04:00");
const ON = { study_blocks: true };
const tor = (t: number) => new Date(t).toLocaleString("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const plan = (items = ITEMS, now = NOW, cfg: any = ON) =>
  studyItems(items, cfg, TZ, now).map((s: any) => `${s.title} @ ${tor(s.start.t)}–${tor(s.end.t).split(", ").pop()}`);

const CLASS_FRI = { uid: "tut", course: "COMP 2406", title: "Tutorial", type: "class", role: "event",
  start: "2026-09-11T10:05:00-04:00", end: "2026-09-11T11:25:00-04:00", rrule: "FREQ=WEEKLY;UNTIL=20261210T173000Z;BYDAY=FR", keep: true };

test("off unless turned on", () => {
  assert.deepEqual(studyItems(ITEMS, {}, TZ, NOW), []);
});

test("blocks: assignments 2 × 2h, tests 3 × 2h, spread one a day back from the deadline, around classes", () => {
  const p = plan([...ITEMS, CLASS_FRI]);
  assert.deepEqual(p.filter((s) => s.includes("Client-side")), [
    "📝 Work on: Assignment 1 - Client-side Programming @ Thu, Oct 8, 18:00–20:00",
    "📝 Work on: Assignment 1 - Client-side Programming @ Wed, Oct 7, 18:00–20:00",
  ], "one block a day, working back from the deadline");
  const t1 = p.filter((s) => s.startsWith("📖 Study for: Test 1 @"));
  assert.equal(t1.length, 3);
  assert.equal(new Set(t1.map((s) => s.split(", ").slice(0, 2).join())).size, 3, "on three different days");
  assert.ok(t1.every((s) => !/Mon, Oct 12, (1[0-9]|09)/.test(s) || /Oct 11/.test(s)), "nothing on the test morning after it starts");
  // the Friday 10:05 class blocks the 10:00 slot that day
  assert.ok(!p.some((s) => /Fri, Oct 9, 10:00/.test(s)), "doesn't clash with the Friday tutorial");
});

test("no two blocks overlap, and none for tutorials, quizzes or modules", () => {
  const blocks = studyItems([...ITEMS, CLASS_FRI], ON, TZ, NOW) as any[];
  for (const a of blocks) for (const b of blocks) {
    if (a !== b) assert.ok(a.end.t <= b.start.t || b.end.t <= a.start.t, `${a.uid} overlaps ${b.uid}`);
  }
  assert.ok(!blocks.some((b) => /Tutorial \d|Quiz/.test(b.title)));
});

test("stable as time passes: later runs only drop past blocks, never add new ones", () => {
  const early = studyItems(ITEMS, ON, TZ, NOW) as any[];
  const later = studyItems(ITEMS, ON, TZ, Date.parse("2026-10-08T16:00:00-04:00")) as any[];
  const earlyMap = new Map(early.map((b) => [b.uid, b.start.t]));
  for (const b of later) assert.equal(earlyMap.get(b.uid), b.start.t, `${b.uid} moved`);
  assert.ok(later.length < early.length);
});

test("done work gets no blocks", () => {
  const done = ITEMS.map((i) => (i.title.startsWith("Assignment 1 - Client") ? { ...i, done: true } : i));
  assert.ok(!plan(done).some((s) => s.includes("Client-side")));
});

test("calendar look: Peacock, no reminders, explains itself", async () => {
  const [b] = studyItems(ITEMS, ON, TZ, NOW);
  const body = await eventBody(b, { reminders: [1440, 120] }, TZ);
  assert.equal(body.colorId, "7");
  assert.deepEqual(body.reminders.overrides, []);
  assert.match(body.description, /Planned by Duely/);
  assert.match(body.summary, /^\[(COMP|PHYS|STAT) \d{4}\] (📝 Work on|📖 Study for): /);
});

test("weekly classes never get reminders, even with course-event reminders on", async () => {
  const cls: any = { uid: "lec", raw_title: "Lecture", title: "Lecture", course: "STAT 2507", role: "event", type: "class",
    start: { t: Date.parse("2026-10-05T08:35:00-04:00"), tz: TZ }, end: { t: Date.parse("2026-10-05T09:55:00-04:00"), tz: TZ },
    all_day: false, opens: null, description: "", location: "LA C164", url: "", rrule: "FREQ=WEEKLY;BYDAY=MO,WE", keep: true, reason: "", source: "timetable" };
  const on = { reminders: [1440, 120], event_reminders: true };
  assert.deepEqual((await eventBody(cls, on, TZ)).reminders.overrides, []);
  assert.equal((await eventBody({ ...cls, type: "event", rrule: "" }, on, TZ)).reminders.overrides.length, 2, "other course events still remind");
  assert.equal((await eventBody({ ...cls, type: "assignment", role: "deadline", rrule: "" }, on, TZ)).reminders.overrides.length, 2, "deadlines too");
});

test("final exams from the exam schedule become exam events and get study suggestions", async () => {
  const { timetableItems } = await import("../src/core/timetable.ts");
  const { studyPlans } = await import("../src/core/study.ts");
  const { serial } = await import("../src/core/sync.ts");
  const cfg = { exams: [{ course: "COMP 2406", title: "Final exam", date: "2026-10-16", start: "14:00", end: "17:00", room: "FH 1A" }] };
  const items = timetableItems(cfg, TZ);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].type, items[0].title, items[0].location, items[0].source], ["exam", "Final exam", "FH 1A", "exams"]);
  const plans = studyPlans(items.map((i) => serial(i, TZ)), ON, TZ, NOW);
  assert.equal(plans.length, 1, "a study suggestion for it");
  assert.equal(plans[0].kind, "test");
});
