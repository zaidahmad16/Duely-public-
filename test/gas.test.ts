// The Apps Script bundle, run in a sandbox that has only what Apps Script has: no fetch, Web Crypto,
// URL, timers or Intl; fake UrlFetchApp / Utilities / PropertiesService (with Apps Script's size limits)
// / ScriptApp / Session, and a fake Google Calendar REST API behind UrlFetchApp. It must put exactly
// the same events in the calendar as the desktop engine does for the same feed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import type { Cal } from "../src/core/gcal.ts";
import { memStore } from "../src/core/util.ts";
import { syncOnce } from "../src/node/runner.ts";
import { buildGas } from "../scripts/build-gas.ts";

const FEED = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8");
const FEED_URL = "https://brightspace.example.ca/d2l/le/calendar/feed/user/feed.ics?token=x";
const TZ = "America/Toronto";
const CONFIG = { feed_url: FEED_URL, use_ai: false, tz: TZ, digest_daily: false, digest_weekly: false, briefings: false };

/** A fake Google Calendar v3 REST API (just the calls the engine makes). */
function fakeCalendarApi() {
  const cals = new Map<string, Map<string, any>>();
  let n = 0;
  const counter = { writes: 0 };
  const handle = (method: string, url: string, body: string | undefined): [number, string] => {
    if (method !== "get") counter.writes++;
    const u = new URL(url);
    const p = u.pathname.replace("/calendar/v3", "").split("/").map(decodeURIComponent);
    if (method === "post" && p[1] === "calendars" && p.length === 2) {
      const id = `cal${++n}@group.calendar.google.com`; cals.set(id, new Map());
      return [200, JSON.stringify({ id, summary: JSON.parse(body!).summary })];
    }
    const cal = cals.get(p[2]);
    if (!cal) return [404, JSON.stringify({ error: { message: "Not Found" } })];
    if (method === "get" && p.length === 3) return [200, JSON.stringify({ id: p[2] })];
    if (p[3] === "events" && p.length === 4) {
      if (method === "get") return [200, JSON.stringify({ items: [...cal.values()] })];
      if (method === "post") { const id = `ev${++n}`; cal.set(id, { ...JSON.parse(body!), id }); return [200, JSON.stringify({ id })]; }
    }
    if (p[3] === "events" && p[4]) {
      if (method === "put") { cal.set(p[4], { ...JSON.parse(body!), id: p[4] }); return [200, "{}"]; }
      if (method === "delete") { cal.delete(p[4]); return [204, ""]; }
    }
    return [400, JSON.stringify({ error: { message: `unexpected ${method} ${url}` } })];
  };
  return { cals, handle, get writes() { return counter.writes; }, events: () => [...cals.values()].flatMap((m) => [...m.values()]) };
}

/** Script properties with Apps Script's limits (9 KB a value, 500 KB in all). */
function fakeProps() {
  const m = new Map<string, string>();
  const check = () => {
    const total = [...m].reduce((s, [k, v]) => s + k.length + v.length, 0);
    if (total > 500 * 1024) throw new Error(`property store over 500 KB (${total})`);
  };
  const set = (k: string, v: string) => {
    if (k.length + v.length > 9 * 1024) throw new Error(`property ${k} over 9 KB (${v.length})`);
    m.set(k, v);
  };
  return {
    m,
    getProperty: (k: string) => m.get(k) ?? null,
    setProperty: (k: string, v: string) => { set(k, String(v)); check(); },
    setProperties: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) set(k, String(v)); check(); },
    deleteProperty: (k: string) => { m.delete(k); },
    getProperties: () => Object.fromEntries(m),
  };
}

async function sandbox(feed = () => FEED, ai?: (url: string, o: any) => [number, string]) {
  const api = fakeCalendarApi();
  const props = fakeProps();
  const fetched: string[] = [];
  const triggers: any[] = [];
  const response = (code: number, text: string) => ({ getResponseCode: () => code, getContentText: () => text, getHeaders: () => ({}) });
  const g: any = {
    console,
    UrlFetchApp: {
      fetch(url: string, o: any = {}) {
        fetched.push(url);
        if (url.startsWith("https://www.googleapis.com/calendar/v3")) throw new Error("the calendar must go through the Calendar advanced service, not UrlFetchApp");
        if (url === FEED_URL) return response(200, feed());
        if (ai) { const [code, text] = ai(url, o); return response(code, text); }
        return response(404, "not found");
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_1: "sha1" }, Charset: { UTF_8: "utf8" },
      computeDigest: (_a: string, s: string) => [...createHash("sha1").update(s, "utf8").digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate(d: Date, tz: string, pattern: string) {
        assert.equal(pattern, "Z");
        const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d).find((x) => x.type === "timeZoneName")!.value;
        const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
        return m ? `${m[1]}${m[2]}${m[3] ?? "00"}` : "+0000";
      },
      sleep() {},
    },
    PropertiesService: { getScriptProperties: () => props },
    Session: { getScriptTimeZone: () => TZ, getEffectiveUser: () => ({ getEmail: () => "student@example.com" }) },
    ScriptApp: {
      getOAuthToken: () => "token",
      getProjectTriggers: () => triggers,
      deleteTrigger: (t: any) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn: string) => ({ timeBased: () => ({
        everyMinutes: (n: number) => ({ create: () => { triggers.push({ fn, n, getHandlerFunction: () => fn }); } }),
        after: (ms: number) => ({ create: () => { triggers.push({ fn, after: ms, getHandlerFunction: () => fn }); } }),
      }) }),
    },
    MailApp: { sendEmail() {} },
    // the Calendar advanced service over the same fake API (it throws on errors, like the real one)
    Calendar: (() => {
      const call = (method: string, path: string, body?: unknown) => {
        const [code, text] = api.handle(method, `https://www.googleapis.com/calendar/v3${path}`, body === undefined ? undefined : JSON.stringify(body));
        if (code >= 400) throw new Error(`API call to calendar failed with error: ${code === 404 ? "Not Found" : `code ${code}`}`);
        return text ? JSON.parse(text) : undefined;
      };
      const enc = encodeURIComponent;
      return {
        Calendars: { get: (id: string) => call("get", `/calendars/${enc(id)}`), insert: (b: any) => call("post", "/calendars", b) },
        Events: {
          list: (c: string) => call("get", `/calendars/${enc(c)}/events`),
          insert: (b: any, c: string) => call("post", `/calendars/${enc(c)}/events`, b),
          update: (b: any, c: string, id: string) => call("put", `/calendars/${enc(c)}/events/${id}`, b),
          remove: (c: string, id: string) => call("delete", `/calendars/${enc(c)}/events/${id}`),
        },
      };
    })(),
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }) },
  };
  const ctx = vm.createContext(g);
  // what Apps Script doesn't give a script (or doesn't reliably): the bundle must not need any of it
  vm.runInContext("delete globalThis.Intl; delete globalThis.fetch; delete globalThis.URL; delete globalThis.URLSearchParams;"
    + "delete globalThis.TextEncoder; delete globalThis.setTimeout; delete globalThis.crypto;", ctx);
  vm.runInContext((await buildGas(TZ)).code, ctx);
  props.setProperty("v:config", JSON.stringify(CONFIG));
  return { ctx, api, props, fetched, triggers, run: (fn: string) => vm.runInContext(`${fn}()`, ctx) };
}

/** The desktop engine on the same feed, for comparison. */
async function desktopEvents(feed = FEED) {
  const cals = new Map<string, Map<string, any>>(); let n = 0;
  const cal: Cal = {
    async ensureCalendar(_name, id) { if (id && cals.has(id)) return id; const c = `c${++n}`; cals.set(c, new Map()); return c; },
    async listEvents(c) { return [...cals.get(c)!.values()]; },
    async insert(c, b) { const id = `e${++n}`; cals.get(c)!.set(id, { ...b, id }); },
    async update(c, id, b) { cals.get(c)!.set(id, { ...b, id }); },
    async delete(c, id) { cals.get(c)!.delete(id); },
  };
  const r = await syncOnce({ store: memStore({ config: CONFIG }), llm: async () => undefined, calendar: async () => cal, notify: async () => {},
    fetch: (async () => new Response(feed)) as any }, true);
  assert.equal(r.error, "");
  return [...cals.values()].flatMap((m) => [...m.values()]);
}

const key = (e: any) => `${e.extendedProperties.private.bsUid}|${e.extendedProperties.private.bsHash}|${e.summary}|${JSON.stringify(e.start)}`;

test("the bundle runs without Intl, fetch, URL, crypto or timers, and syncs the same events as the desktop", async () => {
  const s = await sandbox();
  const r = await s.run("duelyTick");
  assert.equal(r.synced, true);
  const got = s.api.events().map(key).sort();
  const want = (await desktopEvents()).map(key).sort();
  assert.ok(want.length >= 4, `desktop made ${want.length} events`);
  assert.deepEqual(got, want, "same events, same hashes, same times");
});

test("a second tick within 10 minutes doesn't sync again; the next one does, and changes nothing", async () => {
  const s = await sandbox();
  await s.run("duelyTick");
  const writes = () => s.api.writes;
  const before = writes();
  assert.equal((await s.run("duelyTick")).synced, false, "too soon");
  const sched = JSON.parse(s.props.m.get("v:sched")!);
  s.props.setProperty("v:sched", JSON.stringify({ ...sched, lastFull: sched.lastFull - 10 * 60e3 }));
  assert.equal((await s.run("duelyTick")).synced, true, "due again");
  assert.equal(s.api.events().length, (await desktopEvents()).length);
  assert.ok(writes() - before <= 2, "the unchanged feed isn't re-written");
});

test("setup makes one 10-minute trigger (again: still one); stop removes it", async () => {
  const s = await sandbox();
  s.run("duelySetup");
  s.run("duelySetup");
  assert.equal(s.triggers.length, 1);
  assert.equal(s.triggers[0].n, 10);
  s.run("duelyStop");
  assert.equal(s.triggers.length, 0);
});

test("big values are split into chunks under Apps Script's 9 KB limit and read back whole", async () => {
  const s = await sandbox();
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ uid: `u${i}`, title: "x".repeat(60) })) };
  await vm.runInContext(`Duely.propsStore().put("big", ${JSON.stringify(big)})`, s.ctx);
  assert.ok([...s.props.m.keys()].filter((k) => k.startsWith("c:big:")).length > 2, "chunked");
  const back = await vm.runInContext(`Duely.propsStore().get("big")`, s.ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), big);   // (objects from the sandbox have its own prototypes)
  await vm.runInContext(`Duely.propsStore().put("big", {"small": true})`, s.ctx);
  assert.equal([...s.props.m.keys()].filter((k) => k.startsWith("c:big:")).length, 0, "old chunks removed");
});

test("AI from inside Apps Script: each provider type gets a well-formed request through UrlFetchApp", async () => {
  for (const [provider, host, auth] of [["openai", "api.mistral.ai", "Authorization"], ["anthropic", "api.anthropic.com", "x-api-key"], ["gemini", "generativelanguage.googleapis.com", "x-goog-api-key"]] as const) {
    const calls: { url: string; o: any }[] = [];
    const s = await sandbox(undefined, (url, o) => { calls.push({ url, o }); return [500, JSON.stringify({ error: { message: "fake provider" } })]; });
    s.props.setProperty("v:config", JSON.stringify({ ...CONFIG, use_ai: true, ai: { provider, model: "m-1", baseUrl: provider === "openai" ? "https://api.mistral.ai/v1" : "" } }));
    s.props.setProperty("secret:llm_key", "k-123");
    const r = await s.run("duelyTick");
    assert.equal(r.synced, true, provider);
    const call = calls.find((c) => c.url.includes(host));
    assert.ok(call, `${provider}: the AI was called (${calls.map((c) => c.url).join(", ")})`);
    assert.equal(call!.o.method, "post");
    assert.match(call!.o.contentType ?? "", /json/, `${provider}: JSON body as UrlFetchApp's contentType`);
    const body = JSON.parse(call!.o.payload);
    assert.ok(JSON.stringify(body).includes("m-1") || call!.url.includes("m-1"), `${provider}: model sent`);
    const headers = Object.fromEntries(Object.entries(call!.o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const keySent = Object.values(headers).some((v) => v.includes("k-123")) || call!.url.includes("k-123");
    assert.ok(keySent, `${provider}: key sent (${auth})`);
    assert.ok(s.api.events().length >= 4, `${provider}: the AI failing falls back to the rules, and the calendar still fills`);
  }
});

test("the desktop's channel (web app): doGet/doPost answer synchronously; Sync now queues one run", async () => {
  const s = await sandbox();
  const call = (src: string) => JSON.parse(vm.runInContext(src, s.ctx).text);
  const empty = call("doGet()");
  assert.equal(empty.ok, true);
  assert.equal(empty.state, null, "nothing synced yet");
  assert.deepEqual(call(`doPost({ postData: { contents: JSON.stringify({ op: "config", config: { digest_time: "08:15" } }) } })`), { ok: true });
  assert.equal(JSON.parse(s.props.m.get("v:config")!).digest_time, "08:15", "merged into the settings");
  assert.equal(JSON.parse(s.props.m.get("v:config")!).feed_url, FEED_URL, "the rest kept");
  call(`doPost({ postData: { contents: JSON.stringify({ op: "secret", name: "llm_key", value: "k-9" }) } })`);
  assert.equal(s.props.m.get("secret:llm_key"), "k-9");
  assert.equal(call(`doPost({ postData: { contents: '{"op":"sync"}' } })`).queued, true);
  call(`doPost({ postData: { contents: '{"op":"sync"}' } })`);
  assert.equal(s.triggers.filter((t) => t.fn === "duelySyncNow").length, 1, "two taps: one queued run");
  assert.equal(call("doGet()").syncQueued, true);
  const r = await s.run("duelySyncNow");
  assert.equal(r.synced, true);
  assert.equal(s.triggers.filter((t) => t.fn === "duelySyncNow").length, 0, "the one-off trigger removed itself");
  const after = call("doGet()");
  assert.equal(after.syncQueued, false);
  assert.ok(after.state.items.length >= 4, "the desktop can read the result");
  assert.equal(call(`doPost({ postData: { contents: "not json" } })`).ok, false);
});

test("a failing sync is recorded, not crashed, inside Apps Script (the error path runs there too)", async () => {
  const s = await sandbox(() => "<html>not a calendar</html>");
  const r = await s.run("duelyTick");
  assert.equal(r.synced, true);
  const state = JSON.parse(s.props.m.get("v:state")!);
  assert.match(state.error, /didn't return a calendar/);
  assert.equal(s.props.m.get("v:errors"), undefined, "nothing crashed");
  const call = JSON.parse(vm.runInContext("doGet()", s.ctx).text);
  assert.match(call.state.error, /didn't return a calendar/, "the desktop sees the reason");
});

test("the bundle doesn't use Node's globals (process, Buffer, require)", async () => {
  const { code } = await buildGas();
  for (const g of ["process.", "Buffer.", "require("]) assert.ok(!code.includes(g), `bundle uses ${g}`);
});
