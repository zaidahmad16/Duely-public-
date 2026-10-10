// The Apps Script sandbox for tests: Duely's bundle in a context with only what Apps Script has (no
// fetch, Web Crypto, URL, timers or Intl) and fake Apps Script services, including script properties
// with Apps Script's size limits and a fake Google Calendar behind the Calendar advanced service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Cal } from "../src/core/gcal.ts";
import { memStore } from "../src/core/util.ts";
import { syncOnce } from "../src/node/runner.ts";
import { buildGas } from "../scripts/build-gas.ts";
import { START_FILE } from "../src/gas/manifest.ts";

export const FEED = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8");
export const FEED_URL = "https://brightspace.example.ca/d2l/le/calendar/feed/user/feed.ics?token=x";
export const TZ = "America/Toronto";
export const CONFIG = { feed_url: FEED_URL, use_ai: false, tz: TZ, digest_daily: false, digest_weekly: false, briefings: false };

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

export async function sandbox(feed = () => FEED, ai?: (url: string, o: any) => [number, string]) {
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
  vm.runInContext(START_FILE, ctx);
  props.setProperty("v:config", JSON.stringify(CONFIG));
  return { ctx, api, props, fetched, triggers, run: (fn: string) => vm.runInContext(`${fn}()`, ctx) };
}

/** The desktop engine on the same feed, for comparison. */
export async function desktopEvents(feed = FEED) {
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

