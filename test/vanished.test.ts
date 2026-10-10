// Tests and deadlines that vanish from the sources are kept and asked about (2026-10-09: STAT 2507
// Test 1 silently left the calendar). Unit rules + a full sync with a fake calendar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, loadActions, propose } from "../src/core/actions.ts";
import { memStore } from "../src/core/util.ts";
import { keptItems, vanishedDrafts, vanishedItems } from "../src/core/vanished.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-09T16:00:00-04:00");
const test1 = { uid: "ann-t1", course: "STAT 2507", title: "Test 1", type: "exam", role: "event", start: "2026-10-17T10:00:00-04:00", end: "2026-10-17T11:30:00-04:00", keep: true, source: "announcement" };
const a2 = { uid: "bs-a2", course: "COMP 2406", title: "Assignment 2", type: "assignment", role: "deadline", start: "2026-11-05T23:59:00-05:00", end: "2026-11-05T23:59:00-05:00", keep: true };
const lecture = { uid: "class-x", course: "STAT 2507", title: "Lecture", type: "class", role: "event", start: "2026-10-14T08:35:00-04:00", end: "2026-10-14T09:55:00-04:00", keep: true };

test("what counts as vanished", () => {
  const v = (prev: any[], now: any[], cfg: any = {}) => vanishedItems(prev, now, cfg, NOW).map((i) => i.uid);
  assert.deepEqual(v([test1, a2, lecture], [a2]), ["ann-t1"], "a test that's gone (classes don't count)");
  assert.deepEqual(v([test1], [{ ...test1, uid: "ann-other", start: "2026-10-18T10:00:00-04:00" }]), [], "moved: same course + title, other date");
  assert.deepEqual(v([{ ...test1, done: true }], []), [], "done");
  assert.deepEqual(v([{ ...test1, start: "2026-10-01T10:00:00-04:00", end: "2026-10-01T11:00:00-04:00" }], []), [], "past");
  assert.deepEqual(v([test1], [], { overrides: { "ann-t1": "hide" } }), [], "hidden by the user");
  assert.deepEqual(v([{ ...test1, source: "study" }, { ...a2, source: "email" }], []), [], "Duely's own items");
});

test("one question per item; a broken feed (> 5 at once) is one question for all", () => {
  const one = vanishedDrafts([test1], TZ, NOW);
  assert.equal(one.length, 1);
  assert.match(one[0].summary, /^📅 \*STAT 2507 Test 1 \(Sat Oct 17, 10:00 AM\)\* disappeared from Brightspace/);
  const many = vanishedDrafts([1, 2, 3, 4, 5, 6].map((n) => ({ ...a2, uid: `x${n}`, title: `Assignment ${n}` })), TZ, NOW);
  assert.equal(many.length, 1);
  assert.match(many[0].summary, /^⚠️ 6 tests and deadlines disappeared from Brightspace at once/);
});

test("kept while asked, kept with no answer, kept on yes, let go on no; back in the feed = no copy", async () => {
  for (const [answer, stays] of [["none", true], ["expired", true], ["yes", true], ["no", false]] as const) {
    const store = memStore();
    const [a] = await propose(store, vanishedDrafts([test1], TZ, NOW), NOW);
    let at = NOW + 60e3;
    if (answer === "yes" || answer === "no") await decide(store, a.id, answer === "yes", "button", at);
    if (answer === "expired") at = NOW + 2 * 864e5;
    const acts = Object.values(await loadActions(store, at));
    assert.equal(keptItems(acts, new Set(), TZ, at).length, stays ? 1 : 0, `answer ${answer}`);
    assert.equal(keptItems(acts, new Set(["ann-t1"]), TZ, at).length, 0, "back in the sources: no duplicate");
  }
});

