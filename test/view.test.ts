// What the UI is given: Upcoming's groups, the open questions, chat answers split into prose + rows,
// and settings <-> config (validation; secrets never included).
import assert from "node:assert/strict";
import { test } from "node:test";
import { propose } from "../src/core/actions.ts";
import { memStore } from "../src/core/util.ts";
import { applyPatch, capResult, friendlyAIError, toSettings } from "../src/node/settings.ts";
import { chatText, question, rowsFor, upcoming } from "../src/node/view.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const WED_NOON = Date.parse("2026-10-07T12:00:00-04:00");   // a Wednesday

test("upcoming: today / rest of this week / next week; classes only today; done work left out", () => {
  const u = upcoming(ITEMS, {}, [], TZ, WED_NOON);
  assert.deepEqual(u.today.map((r) => r.title), [], "nothing due Wednesday");
  assert.deepEqual(u.thisWeek.map((r) => r.title), ["Assignment 1 - Client-side Programming", "Tutorial 3", "Tutorial 4", "Assignment 1", "Optional Quiz 3", "Test 1 Review Session"]);
  assert.ok(u.nextWeek.some((r) => r.title === "Test 1" && r.category === "test" && r.label === "Test"));
  assert.ok(!u.nextWeek.some((r) => r.category === "class"), "Monday's lecture isn't listed next week");
  const mon = upcoming(ITEMS, {}, [], TZ, Date.parse("2026-10-12T07:00:00-04:00"));
  assert.ok(mon.today.some((r) => r.title === "Lecture" && r.end! > r.t), "today's class, with its end time");
  const done = upcoming(ITEMS, { "COMP 2406/Tutorial 3": 1 }, [], TZ, WED_NOON);
  assert.ok(!done.thisWeek.some((r) => r.title === "Tutorial 3"));
  const later = upcoming(ITEMS, {}, [], TZ, Date.parse("2026-10-12T10:30:00-04:00"));
  assert.ok(later.today.some((r) => r.title === "Test 1"), "an event still on stays");
  assert.ok(!later.today.some((r) => r.title === "Lecture"), "a class that's over is gone");
});

test("questions: vanished, study plan, keep old blocks — titles a student can read", async () => {
  const store = memStore();
  const [v, s] = await propose(store, [
    { type: "keep_vanished", key: "v", args: { items: [{ uid: "q2", course: "COMP 2401", title: "Quiz 2" }] }, summary: "📅 *COMP 2401 Quiz 2* disappeared…" },
    { type: "add_study_blocks", key: "s", args: { name: "Midterm", plan: { uid: "m", course: "ECON 3001", title: "Midterm", kind: "test", due: WED_NOON + 5 * 864e5, blocks: [{ s: WED_NOON + 864e5, e: WED_NOON + 864e5 + 7200e3 }] } }, summary: "…" },
  ], WED_NOON);
  assert.deepEqual([question(v).title, question(v).buttons], ["COMP 2401 Quiz 2 disappeared from Brightspace", ["keep", "remove"]]);
  assert.equal(question(s).title, "Study for ECON 3001 Midterm");
  assert.match(question(s).body, /2 hours/);
  assert.deepEqual(question(s).buttons, ["add", "notnow", "change"]);
  const u = upcoming(ITEMS, {}, [v, s], TZ, WED_NOON);
  assert.equal(u.questions.length, 2);
});

test("chat: the list becomes rows, the prose stays", () => {
  const text = "*5 deadlines in the next 4 days*\n\n*Tomorrow, Thu Oct 8*\n1. 11:59 PM  COMP 2406: Assignment 1 (due)\n\n*Fri Oct 9*\n2. 10:00 AM  COMP 2406: Tutorial 3 (due)\n• 1:00 PM  STAT: Review\n\n_Finished one? Reply *done 2* (its number)._";
  assert.equal(chatText(text, true), "*5 deadlines in the next 4 days*");
  assert.equal(chatText("Nothing due 🎉", false), "Nothing due 🎉");
  const rows = rowsFor(ITEMS, [{ uid: "t1", day: "2026-10-12" }, { uid: "nope", day: "2026-10-12" }], {}, TZ, WED_NOON);
  assert.deepEqual(rows.map((r) => r.title), ["Test 1"]);
});

test("settings: round trip, validation, the key is never part of it", () => {
  const s = toSettings({ feed_url: "https://x.ca/f.ics", ai: { provider: "openai", model: "m", apiKey: "sk-leak" } }, true);
  assert.equal(s.ai.keySet, true);
  assert.ok(!JSON.stringify(s).includes("sk-leak"));
  const c = applyPatch({}, { feedUrl: "webcal://school.ca/feed.ics", announcementFeeds: ["https://a.ca/rss", "https://a.ca/rss"], digestTime: "08:00",
    ai: { provider: "anthropic", model: " claude-x ", baseUrl: "", dailyLimit: 150 }, studyBlocks: true });
  assert.equal(c.feed_url, "https://school.ca/feed.ics");
  assert.deepEqual(c.announcement_feeds, ["https://a.ca/rss"]);
  assert.deepEqual([c.ai.provider, c.ai.model, c.ai_daily_limit, c.study_blocks], ["anthropic", "claude-x", 150, true]);
  assert.throws(() => applyPatch({}, { feedUrl: "http://school.ca/f.ics" }), /https/);
  assert.throws(() => applyPatch({}, { digestTime: "25:00" }), /time/);
  assert.throws(() => applyPatch({}, { studyDay: ["21:00", "09:00"] }), /before they end/);
  assert.throws(() => applyPatch({}, { ai: { baseUrl: "http://evil.example/v1" } }), /https/);
  assert.equal(applyPatch({}, { ai: { baseUrl: "http://localhost:11434/v1/" } }).ai.baseUrl, "http://localhost:11434/v1");
});

test("Test connection results in plain words", () => {
  assert.match(friendlyAIError("401: Incorrect API key provided"), /key wasn't accepted/);
  assert.match(friendlyAIError("404: model not found"), /model wasn't found/);
  assert.match(friendlyAIError("fetch failed"), /Couldn't reach/);
  const r = capResult({ chat: true, tools: true, json: true, vision: false });
  assert.deepEqual(r.caps!.map((c) => [c.label, c.ok]), [["Chat", true], ["Reading", true], ["Screenshots", false]]);
  assert.equal(capResult({ chat: false, tools: false, json: false, vision: false, error: "429 rate limit" }).ok, false);
});
