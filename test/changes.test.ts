// Change alerts: moved tests/deadlines and rooms, once each; first sync silent; many = one summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeMessages, changedItems, markSent } from "../src/core/changes.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-09T18:00:00-04:00");
const t1 = { uid: "t1", course: "STAT 2507", title: "Test 1", type: "exam", role: "event", start: "2026-10-17T10:00:00-04:00", end: "2026-10-17T11:30:00-04:00", location: "", keep: true };
const a2 = { uid: "a2", course: "COMP 2406", title: "Assignment 2", type: "assignment", role: "deadline", start: "2026-11-05T23:59:00-05:00", end: "2026-11-05T23:59:00-05:00", location: "COMP2406A Web (LEC)", keep: true };

test("room added, deadline moved (same uid or a new uid with the same name), time changed", () => {
  const c = changedItems([t1, a2], [{ ...t1, location: "SA 515" }, { ...a2, uid: "a2-new", start: "2026-11-06T23:59:00-05:00", end: "2026-11-06T23:59:00-05:00" }], TZ, NOW);
  assert.deepEqual(c.map((x) => `${x.title} | ${x.text}`), [
    "📍 STAT 2507 Test 1: room SA 515 | Sat Oct 17, 10:00 AM.",
    "📅 COMP 2406 Assignment 2 moved | Thu Nov 5, 11:59 PM → *Fri Nov 6, 11:59 PM*",
  ]);
  const t = changedItems([t1], [{ ...t1, start: "2026-10-17T13:00:00-04:00" }], TZ, NOW);
  assert.match(t[0].text, /Sat Oct 17, 10:00 AM → \*Sat Oct 17, 1:00 PM\*/);
});

test("ignored: first sync, unchanged, done, past, study/email, a hand-in's course-name 'location'", () => {
  assert.deepEqual(changedItems([], [{ ...t1, location: "SA 515" }], TZ, NOW), []);
  assert.deepEqual(changedItems([t1, a2], [t1, a2], TZ, NOW), []);
  assert.deepEqual(changedItems([t1], [{ ...t1, location: "SA 515", done: true }], TZ, NOW), []);
  const past = { ...t1, start: "2026-10-01T10:00:00-04:00", end: "2026-10-01T11:00:00-04:00" };
  assert.deepEqual(changedItems([past], [{ ...past, location: "SA 515" }], TZ, NOW), []);
  assert.deepEqual(changedItems([{ ...t1, source: "study" }], [{ ...t1, source: "study", location: "x" }], TZ, NOW), []);
  assert.deepEqual(changedItems([a2], [{ ...a2, location: "COMP2406B Web (LEC)" }], TZ, NOW), []);
});

test("each change is sent once; more than 5 at once = one summary", () => {
  const c = changedItems([t1], [{ ...t1, location: "SA 515" }], TZ, NOW);
  assert.equal(changeMessages(c, {}).length, 1);
  assert.equal(changeMessages(c, markSent(c, {}, NOW)).length, 0, "not again");
  const many = [1, 2, 3, 4, 5, 6].map((n) => ({ ...a2, uid: `x${n}`, title: `Assignment ${n}` }));
  const moved = changedItems(many, many.map((i) => ({ ...i, end: "2026-11-07T23:59:00-05:00", start: "2026-11-07T23:59:00-05:00" })), TZ, NOW);
  const msgs = changeMessages(moved, {});
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].title, /^6 tests and deadlines changed at once$/);
});
