// Tests and deadlines that vanish from the sources are kept and asked about (2026-10-09: STAT 2507
// Test 1 silently left the calendar). Unit rules + a full sync with a fake calendar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, loadActions, propose } from "../src/core/actions.ts";
import { runSync } from "../src/core/index.ts";
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

test("full sync: Test 1 leaves the feed -> still in the calendar + one Slack question; asked once", async () => {
  const ICS = (withA2: boolean) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:America/Toronto\r\n` + (withA2
    ? `BEGIN:VEVENT\r\nUID:a2@bs\r\nDTSTART;TZID=America/Toronto:29991105T235900\r\nDTEND;TZID=America/Toronto:29991105T235900\r\nSUMMARY:Assignment 2 - Due\r\nLOCATION:COMP 2406A Web (Fall 2999)\r\nEND:VEVENT\r\n`
    : "") + `BEGIN:VEVENT\r\nUID:a3@bs\r\nDTSTART;TZID=America/Toronto:29991112T235900\r\nDTEND;TZID=America/Toronto:29991112T235900\r\nSUMMARY:Assignment 3 - Due\r\nLOCATION:COMP 2406A Web (Fall 2999)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  let feed = ICS(true);
  const cal = new Map<string, any>(), dms: any[] = [];
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? String(init.body) : "";
    if (url.startsWith("https://bs.example/feed")) return new Response(feed);
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at" });
    if (url === "https://slack.com/api/chat.postMessage") { dms.push(JSON.parse(body)); return Response.json({ ok: true }); }
    if (url.includes("/calendar/v3/calendars")) {
      if (method === "GET" && /calendars\/cal1$/.test(url)) return Response.json({ id: "cal1" });
      if (method === "GET" && url.includes("/events")) return Response.json({ items: [...cal.values()] });
      if (method === "POST") { const e = { ...JSON.parse(body), id: String(++n) }; cal.set(e.id, e); return Response.json(e); }
      if (method === "PUT") { const id = url.split("/").pop()!; cal.set(id, { ...JSON.parse(body), id }); return Response.json({}); }
      if (method === "DELETE") { cal.delete(url.split("/").pop()!); return new Response(null, { status: 204 }); }
    }
    throw new Error("unexpected fetch " + method + " " + url);
  }) as any;
  try {
    const m = new Map<string, string>();
    const STATE = { get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k: string, v: string) => { m.set(k, v); } };
    m.set("config", JSON.stringify({ feed_url: "https://bs.example/feed", calendar_id: "cal1", use_ai: false, slack_user_id: "U1", tz: TZ, lookback_days: 100000 }));
    const env: any = { STATE, GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", SYNC_SECRET: "x", SLACK_BOT_TOKEN: "xoxb" };
    const titles = () => [...cal.values()].map((e) => e.summary).sort();
    assert.equal((await runSync(env)).error, "");
    assert.equal(titles().filter((t) => /Assignment 2/.test(t)).length, 1);
    feed = ICS(false);                                             // A2 drops out of the feed
    assert.equal((await runSync(env, true)).error, "");
    assert.equal(titles().filter((t) => /Assignment 2/.test(t)).length, 1, "still in the calendar");
    assert.equal(dms.length, 1);
    assert.match(dms[0].text, /COMP 2406 Assignment 2.*disappeared from Brightspace/);
    assert.match(JSON.stringify(dms[0].blocks), /Keep it.*Remove it/);
    await runSync(env, true);
    assert.equal(dms.length, 1, "asked once");
    // "Remove it" -> gone at the next sync
    const store = { get: async (k: string) => STATE.get(k), put: async (k: string, v: unknown) => STATE.put(k, JSON.stringify(v)) };
    const id = dms[0].blocks[1].elements[1].value;
    await decide(store, id, false, "button");
    await runSync(env, true);
    assert.equal(titles().filter((t) => /Assignment 2/.test(t)).length, 0, "removed after 'Remove it'");
    assert.equal(dms.length, 1, "and not asked again");
  } finally {
    globalThis.fetch = realFetch;
  }
});
