// Announcement dates survive the post scrolling out of Brightspace's short RSS feed (2026-10-09: four
// new STAT 2507 posts pushed out the one that dated Test 1, and Test 1 silently left the calendar).
import assert from "node:assert/strict";
import { test } from "node:test";
import { announcementItems } from "../src/core/announcements.ts";
import { memStore } from "../src/core/util.ts";

const TZ = "America/Toronto";
const post = (guid: string, title: string, body: string, daysAgo: number) =>
  `<item><title>${title}</title><link>https://bs.example/${guid}</link><guid>${guid}</guid><pubDate>${new Date(Date.now() - daysAgo * 864e5).toUTCString()}</pubDate><description>${body}</description></item>`;
const feed = (...items: string[]) => `<rss><channel><title>Announcements - STAT2507A Stats (LEC)</title>${items.join("")}</channel></rss>`;
const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 10);

test("dates from a post that scrolled out of the feed stay until they pass; an edited post still replaces them", async () => {
  const store = memStore();
  const ctx: any = { store, cfg: { announcement_feeds: ["https://bs.example/rss"], use_ai: true }, tz: TZ, fetch };
  const test1 = { title: "Test 1", type: "exam", date: day(8), time: "10:00", end_time: "11:30", quote: "Test 1 is on …" };
  const ask = async (anns: any[]) => anns.map((a, i) => ({ ann: `a${i}`, important: false, alert: "",
    events: /Test 1 date/.test(a.title) ? [/moved/.test(a.body) ? { ...test1, date: day(9) } : test1] : [] }));
  const run = async (xml: string) => (await announcementItems(ctx, [], { ask, fetchFeed: async () => xml }))[0].map((i) => `${i.title} ${String((i.start as any).t ? new Date((i.start as any).t).toISOString().slice(0, 10) : i.start)}`);

  const original = post("p1", "Test 1 date", "Test 1 is on the date below", 10);
  assert.equal((await run(feed(original))).length, 1);
  // five newer posts push it out of the feed: Test 1 must stay
  const newer = [1, 2, 3, 4, 5].map((n) => post(`n${n}`, `Note ${n}`, "nothing dated", 0));
  const after = await run(feed(...newer));
  assert.equal(after.length, 1, "Test 1 kept after its post left the feed");
  assert.match(after[0], /^Test 1/);
  // the same post edited (same guid, new text): the new date replaces the old one
  const edited = await run(feed(post("p1", "Test 1 date", "Test 1 moved to the next day", 10), ...newer.slice(0, 4)));
  assert.equal(edited.length, 1);
  assert.ok(((await store.get("announcement-cache")) as any) && Object.values((await store.get("announcement-cache")) as any).filter((e: any) => e.events?.length).length === 1, "the old version is gone");
});

test("a later post with the room fills it in on the existing test (no duplicate event), and Google gets the location", async () => {
  const { eventBody } = await import("../src/core/sync.ts");
  const store = memStore();
  const ctx: any = { store, cfg: { announcement_feeds: ["https://bs.example/rss"], use_ai: true }, tz: TZ, fetch };
  const t1: any = { uid: "bs-t1", course: "STAT 2507", title: "Test 1", raw_title: "Test 1", type: "exam", role: "event",
    start: { t: Date.parse(`${day(8)}T10:00:00-04:00`), tz: TZ }, end: { t: Date.parse(`${day(8)}T11:30:00-04:00`), tz: TZ },
    all_day: false, opens: null, description: "", location: "", url: "", rrule: "", keep: true, reason: "" };
  const ask = async (anns: any[]) => anns.map((a, i) => ({ ann: `a${i}`, important: true, alert: "Test 1 room: SA 515",
    events: [{ title: "Test 1", type: "exam", date: day(8), time: "10:00", end_time: "11:30", quote: "Test 1 will be held in SA 515.", location: "SA 515" }] }));
  const [found] = await announcementItems(ctx, [t1], { ask, fetchFeed: async () => feed(post("r1", "Test 1 room", "Test 1 will be held in SA 515.", 0)) });
  assert.equal(found.length, 0, "no second Test 1");
  assert.equal(t1.location, "SA 515");
  assert.match(t1.description, /Room from the announcement “Test 1 room”.*SA 515/);
  assert.equal((await eventBody(t1, { reminders: [] }, TZ)).location, "SA 515", "tests carry their room into Google Calendar");
});
