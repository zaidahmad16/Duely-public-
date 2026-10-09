// Done tracking: resolving "done …", hiding done work, ✓ in the calendar, pruning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../src/core/ask.ts";
import { applyDone, resolveTarget, saveDone } from "../src/core/done.ts";
import { eventBody } from "../src/core/sync.ts";
import { memStore } from "../src/core/util.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-04T12:00:00-04:00");

test("resolveTarget: course + short names, numbers, ambiguity, nothing", () => {
  const r = (t: string, last: string[] = []) => resolveTarget(t, ITEMS, last, NOW);
  assert.equal(r("comp 2406 a1").match?.title, "Assignment 1 - Client-side Programming");
  assert.equal(r("comp3106 assignment 1").match?.course, "COMP 3106");
  assert.equal(r("tutorial 3").match?.title, "Tutorial 3");
  assert.deepEqual(r("a1").choices?.map((c) => c.course), ["COMP 2406", "COMP 3106"], "two A1s -> ask which");
  assert.equal(r("2", ["COMP 2406/Tutorial 3", "COMP 2406/Tutorial 4"]).match?.title, "Tutorial 4");
  assert.deepEqual(r("calculus homework"), {});
});

test("chat: done by name asks first -> yes -> hidden everywhere -> listed as finished -> undo", async () => {
  const store = memStore();
  const say = (t: string) => answer(t, ITEMS, {}, store, TZ, fetch, NOW);
  assert.match(await say("done comp 2406 a1"), /^Mark \*COMP 2406: Assignment 1 - Client-side Programming\* done\? Reply \*yes\* or \*no\*/);
  assert.equal(await store.get("done"), null, "nothing changes before the yes");
  assert.match(await say("yes"), /^✅ Marked \*COMP 2406: Assignment 1 - Client-side Programming\* done/);
  assert.ok(((await store.get("done")) as any)["COMP 2406/Assignment 1 - Client-side Programming"]);
  const list = await say("assignments due in the next two weeks");
  assert.doesNotMatch(list, /^(\d+\.|•) .*Client-side/m);
  assert.match(list, /^\*1 assignment due in the next 2 weeks\*/);
  assert.match(await say("done comp 2406 a1"), /already done/);
  assert.match(await say("what have I finished?"), /^\*1 thing you've marked done\*[\s\S]*Client-side Programming \(due\) ✓/);
  assert.match(await say("undo comp 2406 a1"), /^Put \*COMP 2406: Assignment 1 - Client-side Programming\* back on your list\?/);
  assert.match(await say("yep"), /back on your list/);
  assert.match(await say("assignments due in the next two weeks"), /^\*2 assignments/);
});

test("chat: no to a done check changes nothing; bare undo reverts the last change within 10 min", async () => {
  const store = memStore();
  const say = (t: string, at = NOW) => answer(t, ITEMS, {}, store, TZ, fetch, at);
  await say("done tutorial 3");
  assert.match(await say("no"), /stays on your list/);
  assert.deepEqual((await store.get("done")) ?? {}, {});
  await say("whats due friday");
  assert.match(await say("done 1"), /^✅ Marked/, "by number: at once");
  assert.equal(Object.keys((await store.get("done")) as any).length, 1);
  assert.match(await say("undo", NOW + 60e3), /^↩️ Undone: /);
  assert.deepEqual(await store.get("done"), {});
  await say("done 1", NOW + 120e3);
  assert.doesNotMatch(await say("undo", NOW + 120e3 + 11 * 60e3), /^↩️ Undone/, "too late for a bare undo");
});

test('chat: numbered lists make "done 2" work; ambiguous asks which', async () => {
  const store = memStore();
  const say = (t: string) => answer(t, ITEMS, {}, store, TZ, fetch, NOW);
  const list = await say("what's due in the next 6 days");
  assert.match(list, /\n2\. 11:59 PM  COMP 2406: Assignment 1/);
  assert.match(list, /Reply \*done 2\*/);
  assert.match(await say("done 2"), /Marked \*COMP 2406: Assignment 1/);
  assert.match(await say("done a1"), /^Mark \*COMP 3106: Assignment 1\* done\?/, "only one A1 is still open; by name, so it checks");

  const fresh = memStore();
  const ask = await answer("done a1", ITEMS, {}, fresh, TZ, fetch, NOW);
  assert.match(ask, /^Which one\? Reply \*done 1\*, \*done 2\*…\n1\. Thu Oct 8  COMP 2406: Assignment 1/);
  assert.match(await answer("done 2", ITEMS, {}, fresh, TZ, fetch, NOW), /Marked \*COMP 3106: Assignment 1\*/,
    "the shortlist became the numbers");
});

test("calendar: a done item gets a ✓ and no reminders", async () => {
  const raw: any = { uid: "x", raw_title: "A1", title: "A1", course: "COMP 2406", role: "deadline", type: "assignment",
    start: { t: NOW + 864e5, tz: TZ }, end: { t: NOW + 864e5, tz: TZ }, all_day: false, opens: null, description: "",
    location: "", url: "", rrule: "", keep: true, reason: "", source: "ai" };
  const before = await eventBody(raw, { reminders: [1440, 120] }, TZ);
  applyDone([raw], { x: NOW });
  const after = await eventBody(raw, { reminders: [1440, 120] }, TZ);
  assert.equal(after.summary, "✓ " + before.summary);
  assert.deepEqual(after.reminders.overrides, []);
  assert.notEqual(after.extendedProperties.private.bsHash, before.extendedProperties.private.bsHash, "so the event updates");
});

test("saveDone forgets marks after a term", async () => {
  const store = memStore();
  await saveDone(store, { old: NOW - 200 * 864e5, fresh: NOW }, NOW);
  assert.deepEqual(Object.keys((await store.get("done")) as any), ["fresh"]);
});

test("only hand-ins get numbers (and checkboxes): tests are listed plain; 'done 1' is the first deadline", async () => {
  const store = memStore();
  const say = (t: string) => answer(t, ITEMS, {}, store, TZ, fetch, NOW);
  const list = await say("what do i have in the next 10 days");
  assert.match(list, /\n• 10:00 AM  STAT 2507: Test 1\b/, "a test has no number");
  assert.match(list, /\n1\. 11:59 PM  PHYS 1905: Quiz - Sports Module \(due\)/, "deadlines are numbered");
  assert.match(await say("done 1"), /Marked \*PHYS 1905: Quiz - Sports Module\*/);
});
