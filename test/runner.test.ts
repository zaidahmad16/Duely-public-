// The desktop engine run against an in-memory Google Calendar: the sample feed fills the calendar,
// a second run changes nothing, edits/removals sync, failures notify once and recovery says so,
// Google not connected keeps the items, digests catch up after a sleep, ticks never overlap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NeedsAuth, type Cal } from "../src/core/gcal.ts";
import { memStore } from "../src/core/util.ts";
import { type Deps, FULL_EVERY_MS, maybeDigest, newSched, plainText, runSync, syncOnce, tick } from "../src/node/runner.ts";

const FEED = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8");
const FEED_URL = "https://brightspace.example.ca/d2l/le/calendar/feed/user/feed.ics?token=x";

export function memCal() {
  const cals = new Map<string, Map<string, any>>();
  let n = 0;
  const writes: string[] = [];
  const cal: Cal = {
    async ensureCalendar(name, id) {
      if (id && cals.has(id)) return id;
      const cid = `cal${++n}@group.calendar.google.com`;
      cals.set(cid, new Map());
      return cid;
    },
    async listEvents(calId) { return [...(cals.get(calId)?.values() ?? [])]; },
    async insert(calId, body) { const id = `ev${++n}`; cals.get(calId)!.set(id, { ...body, id }); writes.push("insert"); },
    async update(calId, id, body) { cals.get(calId)!.set(id, { ...body, id }); writes.push("update"); },
    async delete(calId, id) { cals.get(calId)!.delete(id); writes.push("delete"); },
  };
  return { cal, cals, writes, events: () => [...cals.values()].flatMap((m) => [...m.values()]) };
}

function setup(cfg: any = {}, feed = () => FEED) {
  const store = memStore({ config: { feed_url: FEED_URL, tz: "America/Toronto", use_ai: false, ...cfg } });
  const g = memCal();
  const notes: { title: string; body: string }[] = [];
  let fetchFails = false;
  const deps: Deps = {
    store, llm: async () => undefined, calendar: async () => g.cal,
    notify: async (title, body) => { notes.push({ title, body }); },
    fetch: (async (u: any) => {
      if (fetchFails) throw new TypeError("fetch failed");
      if (String(u).startsWith("https://brightspace.example.ca/d2l/le/calendar")) return new Response(feed());
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return { store, g, notes, deps, offline: (v: boolean) => { fetchFails = v; } };
}

test("the sample feed fills the calendar; a second run writes nothing", async () => {
  const { g, deps, store } = setup();
  const r = await runSync(deps);
  assert.equal(r.error, "", r.error);
  assert.ok(r.pushed && r.added >= 4, `added ${r.added}`);
  const titles = g.events().map((e) => e.summary);
  assert.ok(titles.some((t) => /Assignment 3/.test(t)), titles.join(" | "));
  assert.ok(g.events().every((e) => e.extendedProperties?.private?.bsUid), "every event is Duely's");
  assert.ok((await store.get<any>("config")).calendar_id, "the new calendar's id is saved");
  const before = g.writes.length;
  const again = await syncOnce(deps, true);                          // forced: diffs against the calendar
  assert.equal(again.added + again.updated + again.removed, 0);
  assert.equal(g.writes.length, before);
  const quiet = await syncOnce(deps);                                 // unforced and unchanged: not even read
  assert.ok(quiet.checked_only);
});

test("an edited and a removed feed item update the calendar", async () => {
  let feed = FEED;
  const { g, deps } = setup({}, () => feed);
  await runSync(deps);
  const n = g.events().length;
  feed = FEED.replace("SUMMARY:Assignment 3 - Due", "SUMMARY:Assignment 3 (extended) - Due")
    .replace(/BEGIN:VEVENT\r?\nUID:6606_3000_2@[\s\S]*?END:VEVENT\r?\n/, "");
  const r = await runSync(deps);
  assert.equal(r.error, "");
  assert.ok(r.updated >= 1, "edited");
  assert.equal(r.removed, 1, "removed");
  assert.equal(g.events().length, n - 1);
  assert.ok(g.events().some((e) => /extended/.test(e.summary)));
});

test("failure notifies once (same reason), recovery notifies; items are kept meanwhile", async () => {
  const { deps, notes, offline, store } = setup();
  await runSync(deps);
  const items = (await store.get<any>("state")).items.length;
  offline(true);
  const r1 = await runSync(deps, true);
  assert.match(r1.error, /Couldn't reach Brightspace/);
  assert.equal((await store.get<any>("state")).items.length, items, "last good items stay");
  await runSync(deps, true);
  assert.equal(notes.filter((x) => /isn't working/.test(x.title)).length, 1, "told once");
  offline(false);
  await runSync(deps, true);
  assert.equal(notes.filter((x) => /syncing again/.test(x.title)).length, 1);
});

test("Google not connected: a clear error, the items are still read", async () => {
  const { deps, store } = setup();
  deps.calendar = async () => { throw new NeedsAuth("Connect Google in Duely's settings."); };
  const r = await syncOnce(deps);
  assert.match(r.error, /Connect Google/);
  assert.ok(r.needs_google);
  assert.ok((await store.get<any>("state")).items.length >= 4);
});

test("no notifications when they're turned off", async () => {
  const { deps, notes, offline } = setup({ notifications: false });
  offline(true);
  await runSync(deps);
  assert.equal(notes.length, 0);
});

test("morning digest catches up after a sleep, once", async () => {
  const { deps, notes, store } = setup({ digest_daily: true, digest_weekly: false, digest_time: "07:30" });
  await runSync(deps);
  assert.equal(await maybeDigest(deps, Date.parse("2030-10-08T07:00:00-04:00")), null, "not yet");
  assert.equal(await maybeDigest(deps, Date.parse("2030-10-08T10:45:00-04:00")), "daily", "woke up at 10:45");
  assert.equal(await maybeDigest(deps, Date.parse("2030-10-08T10:46:00-04:00")), null, "once");
  assert.equal(await maybeDigest(deps, Date.parse("2030-10-09T13:00:00-04:00")), null, "too late the next day");
  assert.ok(notes.at(-1)!.title && !notes.at(-1)!.title.includes("*"));
  assert.ok((await store.get<any>("digest")).daily);
});

test("tick: full sync every 10 minutes, nothing before setup, overlapping ticks run one at a time", async () => {
  const s = newSched();
  const blank = setup();
  await blank.store.put("config", {});
  assert.deepEqual(await tick(blank.deps, s, { now: 1e12 }), { synced: false }, "no feed link yet");

  const { deps, g } = setup({ digest_daily: false, digest_weekly: false });
  const sched = newSched();
  const t0 = Date.now();
  const [a, b] = await Promise.all([tick(deps, sched, { now: t0 }), tick(deps, sched, { now: t0 })]);
  assert.deepEqual([a.synced, b.synced], [true, false], "the second waits, then sees it's not due");
  assert.equal((await tick(deps, sched, { now: t0 + 60e3 })).synced, false);
  assert.equal((await tick(deps, sched, { now: t0 + FULL_EVERY_MS })).synced, true);
  assert.equal((await tick(deps, sched, { now: t0 + FULL_EVERY_MS + 1, forceSync: true })).synced, true, "Sync now");
  assert.ok(g.events().length >= 4);
});

test("plainText turns Slack markup into notification text", () => {
  assert.equal(plainText("*Today* <https://x.ca/a|Quiz 2> and _soon_ <https://y.ca>"), "Today Quiz 2 and soon https://y.ca");
});

test("a kept item saved without every date field doesn't break the sync", async () => {
  const { deps, store } = setup();
  await store.put("actions", { a1: { id: "a1", type: "keep_vanished", key: "vanished:x", status: "proposed", created: Date.now(), summary: "",
    args: { items: [{ uid: "old-q", course: "COMP 1", title: "Quiz 2", type: "quiz", role: "deadline", start: "2030-10-20T23:59:00-04:00", end: "2030-10-20T23:59:00-04:00", keep: true }] } } });
  const r = await syncOnce(deps, true);
  assert.equal(r.error, "");
  assert.ok(r.items.some((i: any) => i.uid === "old-q"), "kept on the calendar while asked about");
});
