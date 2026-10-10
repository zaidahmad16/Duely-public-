// Morning digest, Sunday preview, heads-ups, and when they fire.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyDigest, due, heavyClusters, weeklyDigest } from "../src/core/digest.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const at = (s: string) => Date.parse(s);

test("daily digest: today's classes, what's due, tests this week, heads-up", () => {
  const { text, heavy } = dailyDigest(ITEMS, TZ, at("2026-10-05T07:30:00-04:00"));
  assert.match(text, /^☀️ \*Good morning! Mon Oct 5\*/);
  assert.match(text, /\*Classes today\*\n• 8:35 AM  STAT 2507: Lecture · LA C164/);
  assert.match(text, /\*Due today\*\n• 11:59 PM  PHYS 1905: Quiz - Sports Module \(due\)/);
  assert.match(text, /\*Tests this week\*\n\*Mon Oct 12\*|\*Tests this week\*/);
  assert.match(text, /⚠️ \*Heads-up: Thu–Fri \(Oct 8–9\) has 5 things due\*: COMP 2406 Assignment 1/);
  assert.deepEqual(heavy, ["2026-10-08:5"]);
  // already warned -> not repeated
  assert.doesNotMatch(dailyDigest(ITEMS, TZ, at("2026-10-05T07:30:00-04:00"), {}, heavy).text, /Heads-up/);
});

test("daily digest: done work disappears", () => {
  const done = ITEMS.map((i) => (i.title.startsWith("Quiz - Sports") ? { ...i, done: true } : i));
  assert.match(dailyDigest(done, TZ, at("2026-10-05T07:30:00-04:00")).text, /Nothing due today 🎉/);
  const lessHeavy = ITEMS.map((i) => (i.course === "COMP 2406" ? { ...i, done: true } : i));
  assert.equal(heavyClusters(lessHeavy, TZ, at("2026-10-05T07:30:00-04:00")).length, 0, "only 2 left on Thu–Fri");
});

test("weekly preview: the coming Mon–Sun, counts and busiest day", () => {
  const text = weeklyDigest(ITEMS, TZ, at("2026-10-04T19:00:00-04:00"));
  assert.match(text, /^🗓️ \*Your week ahead \(Oct 5–Oct 11\)\*: 6 things due\. Busiest: \*Fri\* \(4\)\./);
  assert.match(text, /\*Tomorrow, Mon Oct 5\*\n1\. 11:59 PM  PHYS 1905: Quiz - Sports Module/);
  assert.doesNotMatch(text, /Lecture/, "no classes in the preview");
});

test("due(): a 30-minute window after the set time, once a day", () => {
  assert.equal(due(at("2026-10-05T07:29:00-04:00"), TZ, "07:30", undefined), false);
  assert.equal(due(at("2026-10-05T07:31:00-04:00"), TZ, "07:30", undefined), true);
  assert.equal(due(at("2026-10-05T08:05:00-04:00"), TZ, "07:30", undefined), false);
  assert.equal(due(at("2026-10-05T07:31:00-04:00"), TZ, "07:30", "2026-10-05"), false, "already sent");
});

