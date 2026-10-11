// Timetable and exam import from screenshots (port of the personal Duely's term_import / exam_import).
// test/timetable-read.json is a real answer from Gemini (gemini-flash-lite-latest, 2026-10-10) for the two
// test screenshots (Fall 2026 + Winter 2027 week views); the checks below are what's actually on them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildItems } from "../src/core/classify.ts";
import { parse } from "../src/core/ical.ts";
import { timetableItems } from "../src/core/timetable.ts";
import { cleanExams, cleanTerm, feedBreaks, hhmm, readExams, readTimetable, removeExam, removeTerm, saveExams, saveTerm } from "../src/core/timetableImport.ts";
import type { LLM } from "../src/llm/types.ts";
import { CONFIG, sandbox } from "./gas-sandbox.ts";

const TZ = "America/Toronto";
const RECORDED = readFileSync(new URL("./timetable-read.json", import.meta.url), "utf8");
const FEED = buildItems(parse(readFileSync(new URL("./demo/calendar.ics", import.meta.url), "utf8"), TZ), TZ);
const IMG = [{ mime: "image/png", b64: "AAAA" }];

function ctx(answer: string) {
  const seen: any[] = [];
  const llm: LLM = { label: "fake", async chat(m, o) { seen.push({ m, o }); return { content: answer, toolCalls: [], usage: { input: 0, output: 0 } }; } };
  const mem = new Map<string, any>();
  return { seen, ctx: { store: { get: async (k: string) => mem.get(k) ?? null, put: async (k: string, v: any) => { mem.set(k, v); } }, cfg: {}, tz: TZ, fetch, llm } };
}
const line = (c: any) => `${c.course}-${c.section} ${c.days.join(",")} ${c.start}-${c.end} ${c.room}`;

test("both screenshots in one go: two terms, every class as on the images, TBA courses listed", async () => {
  const { ctx: c, seen } = ctx(RECORDED);
  const r = await readTimetable(c, IMG, FEED);
  assert.equal(seen[0].m[0].images.length, 1, "the screenshots go to the AI");
  assert.deepEqual(r.terms.map((t) => [t.name, t.start, t.end]), [["Fall 2026", "2026-09-07", "2026-12-11"], ["Winter 2027", "2027-01-11", "2027-04-16"]]);
  const [fall, winter] = r.terms;
  assert.deepEqual(fall.classes.map(line).sort(), [
    "BIOL 2200-C MO,WE 15:30-17:20 SC 3105", "COMP 3005-A TU,TH 13:00-14:20 AT 102", "ECON 2502-A MO,WE,FR 11:00-12:20 DT 1208",
    "MATH 2007-B TU,TH 08:30-09:50 MC 2031", "PSYC 2101-A MO,WE,FR 09:00-09:50 LA C164"]);
  assert.deepEqual(fall.tba, ["PHIL 1901", "ARTH 2100"]);
  assert.deepEqual(winter.tba, ["SOCI 2010", "CHEM 1002"]);
  assert.equal(winter.classes.length, 6);
  assert.ok(winter.classes.some((x) => x.course === "ENGL 2166" && x.days.join() === "FR"), "copied as printed, not silently fixed");
});

test("what Duely notices: the odd course code, breaks from Brightspace, and no claimed academic page", async () => {
  const { ctx: c } = ctx(RECORDED);
  const [fall, winter] = (await readTimetable(c, IMG, FEED)).terms;
  assert.deepEqual(fall.notes, []);
  assert.equal(winter.notes.length, 1);
  assert.match(winter.notes[0], /^ENGL 2166 C \(Fri\) looks like ENGL 2106 C: same time and room/);
  assert.deepEqual(fall.no_class, [["2026-10-26", "2026-10-30"]], "Reading Week, from the feed (all-day end is exclusive)");
  assert.deepEqual(winter.no_class, [["2027-02-15", "2027-02-19"]]);
  assert.equal(fall.dates_source, "estimate", "the model said 'academic calendar' without being given one");
  // a feed that knows neither code (another school, or no feed yet): still one note, on the odd one out
  const { ctx: c2 } = ctx(RECORDED);
  const bare = (await readTimetable(c2, IMG, [])).terms[1];
  assert.deepEqual(bare.notes.map((n) => n.split(" (")[0]), ["ENGL 2166 C"]);
  assert.equal(cleanTerm({ name: "FALL 2026", start: "2026-09-07", end: "2026-12-11" }).name, "Fall 2026", "a shouted header becomes a name");
});

test("cleaning: bad rows go, good ones are normalised; an unusable term says why", () => {
  const t = cleanTerm({ name: "Fall", start: "2026-09-07", end: "2026-12-11", no_class: [["2026-10-26", "2026-10-30"], ["2027-05-01", "2027-05-02"], ["nope"]],
    day_swaps: [{ date: "2026-12-11", follows: "mo" }, { date: "2030-01-01", follows: "TU" }],
    classes: [
      { course: "comp-3005", section: "a", kind: "lecture", days: ["TU", "TH"], start: "1:00 pm", end: "2:20 pm", room: " AT 102 ", crn: "34 567" },
      { course: "COMP 3005", section: "A", kind: "Lecture", days: ["TU", "TH"], start: "13:00", end: "14:20", room: "AT 102", crn: "" },   // duplicate
      { course: "??", section: "", kind: "", days: ["MO"], start: "9:00", end: "10:00", room: "", crn: "" },
      { course: "MATH 1A", section: "", kind: "", days: ["XX"], start: "9:00", end: "10:00", room: "", crn: "" },
      { course: "CS 101", section: "", kind: "", days: "MO, WE", start: "10:00", end: "09:00", room: "", crn: "" },
      { course: "CS 101", section: "", kind: "", days: "MO, WE", start: "10:00", end: "11:00", room: "", crn: "" },
    ] });
  assert.deepEqual(t.classes.map(line), ["COMP 3005-A TU,TH 13:00-14:20 AT 102", "CS 101- MO,WE 10:00-11:00 "]);
  assert.equal(t.classes[0].crn, "34567");
  assert.equal(t.classes[0].kind, "Lecture");
  assert.deepEqual(t.no_class, [["2026-10-26", "2026-10-30"]]);
  assert.deepEqual(t.day_swaps, { "2026-12-11": "MO" });
  assert.throws(() => cleanTerm({ start: "2026-12-11", end: "2026-09-07" }), /ends before it starts/);
  assert.throws(() => cleanTerm({ start: "2026-02-30", end: "2026-04-01" }), /bad date/);
  assert.deepEqual(["9", "4:30 pm", "12:00 am", "16:5", "25:00"].map(hhmm), ["09:00", "16:30", "00:00", "", ""]);
});

test("exams: 12-hour times, a missing end is three hours, duplicates and past exams go", async () => {
  const exams = cleanExams({ exams: [
    { course: "math2007", title: "", date: "2030-12-15", start: "9:00 am", end: "", room: "FH" },
    { course: "MATH 2007", title: "Final exam", date: "2030-12-15", start: "09:00", end: "12:00", room: "FH" },
    { course: "BIOL 2200", title: "Final", date: "2030-12-14", start: "22:00", end: "", room: "" },
    { course: "BIOL 2200", title: "Final", date: "2030-02-30", start: "9:00", end: "", room: "" },
  ] });
  assert.deepEqual(exams.map((e) => `${e.course} ${e.title} ${e.date} ${e.start}-${e.end}`), ["BIOL 2200 Final 2030-12-14 22:00-23:59", "MATH 2007 Final exam 2030-12-15 09:00-12:00"]);
  const { ctx: c } = ctx(JSON.stringify({ exams: [{ course: "COMP 3005", title: "Final", date: "2020-12-01", start: "9:00", end: "", room: "" }] }));
  await assert.rejects(readExams(c, IMG), /No upcoming exams/);
});

test("saving: a term with the same start replaces the old one; remove; exams by course + date + start", () => {
  const a = cleanTerm({ name: "Fall", start: "2026-09-07", end: "2026-12-11", classes: [{ course: "COMP 3005", section: "A", kind: "Lecture", days: ["TU"], start: "13:00", end: "14:20", room: "", crn: "" }] });
  let cfg = saveTerm({}, a);
  cfg = saveTerm(cfg, { ...a, name: "Fall 2026" });
  cfg = saveTerm(cfg, { ...a, name: "Winter", start: "2027-01-11", end: "2027-04-16" });
  assert.deepEqual(cfg.terms.map((t: any) => t.name), ["Fall 2026", "Winter"]);
  assert.ok(!("dates_source" in cfg.terms[0]), "review-only fields aren't saved");
  assert.deepEqual(removeTerm(cfg, "2026-09-07").terms.map((t: any) => t.name), ["Winter"]);
  let ex = saveExams({}, [{ course: "MATH 2007", title: "Final", date: "2030-12-15", start: "09:00", end: "12:00", room: "" }]);
  ex = saveExams(ex, [{ course: "MATH 2007", title: "Final exam", date: "2030-12-15", start: "09:00", end: "12:00", room: "FH" }]);
  assert.deepEqual(ex.exams.map((e: any) => e.room), ["FH"]);
  assert.deepEqual(removeExam(ex, "MATH 2007|2030-12-15|09:00").exams, []);
});

test("the engine skips classes on days the Brightspace feed marks as no classes, even if the term doesn't say so", () => {
  const term = { name: "Fall 2026", start: "2026-09-07", end: "2026-12-11", no_class: [], day_swaps: {},
    classes: [{ course: "PSYC 2101", section: "A", kind: "Lecture", days: ["MO", "WE", "FR"], start: "09:00", end: "09:50", room: "LA C164", crn: "" }] };
  const cfg = { terms: [term], lookback_days: 9999 };
  const plain = timetableItems(cfg, TZ)[0], withFeed = timetableItems(cfg, TZ, FEED)[0];
  assert.ok(plain.meetings!.includes("2026-10-26"));
  assert.ok(!withFeed.meetings!.some((d) => d >= "2026-10-26" && d <= "2026-10-30"), "Reading Week skipped");
  assert.match(withFeed.recurrence_extra!.join(), /EXDATE;TZID=America\/Toronto:20261026T090000/);
  assert.deepEqual(feedBreaks(FEED, { start: "2027-01-11", end: "2027-04-16" }), [["2027-02-15", "2027-02-19"]]);
});

test("in the cloud script, an imported term becomes weekly class events, skipping the feed's reading week", async () => {
  const s = await sandbox();
  const term = { name: "Fall 2030", start: "2030-09-09", end: "2030-12-06", no_class: [], day_swaps: {},
    classes: [{ course: "COMP 2401", section: "A", kind: "Lecture", days: ["MO", "WE"], start: "10:00", end: "11:20", room: "SA 302", crn: "" }] };
  s.props.setProperty("v:config", JSON.stringify({ ...CONFIG, terms: [term] }));
  await s.run("duelyTick");
  const ev = s.api.events().find((e: any) => /^class-COMP2401/.test(e.extendedProperties.private.bsUid));
  assert.ok(ev, "the class is in the calendar");
  assert.match(ev.recurrence.join("\n"), /RRULE:FREQ=WEEKLY;BYDAY=MO,WE/);
  assert.match(ev.recurrence.join("\n"), /EXDATE;TZID=America\/Toronto:[^\n]*20301028T100000/, "Reading Week (from the fixture feed) is skipped");
});
