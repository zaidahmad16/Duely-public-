// Test-eve briefing: 19:00 the evening before, once per test; time, room (or not yet), what the prof
// said (real links), study blocks; no AI = titles + links.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefingText, maybeBriefing, testsOn } from "../src/core/briefing.ts";
import { memStore } from "../src/core/util.ts";

const TZ = "America/Toronto";
const FRI7PM = Date.parse("2026-10-16T19:05:00-04:00");
const T1 = { uid: "t1", course: "STAT 2507", title: "Test 1", type: "exam", role: "event", start: "2026-10-17T10:00:00-04:00", end: "2026-10-17T11:30:00-04:00", keep: true, location: "" };
const RSS = `<rss><channel><title>Announcements - STAT2507A Stats (LEC)</title><item><title>Test 1 Topics and Practice Test</title><link>https://bs.example/stat/1</link><guid>g1</guid>`
  + `<pubDate>${new Date(FRI7PM - 7 * 864e5).toUTCString()}</pubDate><description>Test 1 will cover Chapters 1 to 4. A practice test is posted. Bring a calculator.</description></item></channel></rss>`;
const f = (async (url: any) => (String(url).startsWith("https://bs.example/rss") ? new Response(RSS) : new Response("no", { status: 404 }))) as typeof fetch;
const CFG = { announcement_feeds: ["https://bs.example/rss/stat"] };

test("the briefing: time, 'room not announced yet', what the posts say (titles + links without AI), study blocks", async () => {
  const study: any = { approved: { t1: { blocks: [{ s: Date.parse("2026-10-16T18:00:00-04:00"), e: Date.parse("2026-10-16T20:00:00-04:00") }, { s: Date.parse("2026-10-15T18:00:00-04:00"), e: Date.parse("2026-10-15T20:00:00-04:00") }] } } };
  const [o] = testsOn([T1], "2026-10-17", TZ, FRI7PM);
  const text = await briefingText(o, [T1], CFG, {}, f, FRI7PM, TZ, study);
  assert.match(text, /^📝 \*Tomorrow: STAT 2507 Test 1\*\n🕙 Sat Oct 17, 10:00–11:30 AM\n📍 Room not announced yet/);
  assert.match(text, /What the prof said:[\s\S]*<https:\/\/bs\.example\/stat\/1\|Test 1 Topics and Practice Test>/);
  assert.match(text, /📖 You had 2 study blocks for it\.|📖 Study block left: Fri 6:00 PM/, "only the ones still ahead are 'left', in order");
  const early = await briefingText(o, [T1], CFG, {}, f, Date.parse("2026-10-14T19:00:00-04:00"), TZ, study);
  assert.match(early, /📖 Study blocks left: Thu 6:00 PM, Fri 6:00 PM/, "in time order");
  const withRoom = await briefingText({ ...o, it: { ...T1, location: "SA 515" } }, [T1], CFG, {}, f, FRI7PM, TZ, { approved: {} });
  assert.match(withRoom, /\n📍 SA 515\n/);
});

test("once per test, only 19:00-19:30 the evening before, never for done tests", async () => {
  const store = memStore({ state: { items: [T1] } });
  const sent: string[] = [];
  const post = async (t: string) => { sent.push(t); };
  assert.equal(await maybeBriefing(store, CFG, TZ, Date.parse("2026-10-16T18:59:00-04:00"), {}, post, f), 0);
  assert.equal(await maybeBriefing(store, CFG, TZ, Date.parse("2026-10-15T19:05:00-04:00"), {}, post, f), 0, "two days before");
  assert.equal(await maybeBriefing(store, CFG, TZ, FRI7PM, {}, post, f), 1);
  assert.equal(await maybeBriefing(store, CFG, TZ, FRI7PM + 60e3, {}, post, f), 0, "once");
  assert.equal(sent.length, 1);
  const done = memStore({ state: { items: [T1] }, done: { t1: 1 } });
  assert.equal(await maybeBriefing(done, CFG, TZ, FRI7PM, {}, post, f), 0, "done = no briefing");
});
