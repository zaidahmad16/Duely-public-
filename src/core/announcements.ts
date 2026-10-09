// Dates and phone alerts from course announcements (port of core/announcements.py).
import { type Item, courseOf, head } from "./classify.ts";
import type { Ctx } from "./aifilter.ts";
import { aiReady, llmJSON } from "./llm.ts";
import { type DT, addDays, asDT, isDate, localDate, strftime, today, zoned } from "./time.ts";
import { plain, sha1hex } from "./util.ts";

const MAX_AGE_DAYS = 120;
const ALERT_WINDOW_MS = 3 * 86400e3;

const PROMPT = `These are course announcements from a university student's Brightspace.
Today is {today}. Go through EVERY announcement, one by one, and list each upcoming
dated thing the student must do, attend, or not miss:
- tests, quizzes, midterms, exams (with their date and time window)
- deadlines: new, extended or moved; academic deadlines like the last day to withdraw
- review sessions, labs, special lectures, cancelled or moved classes/tutorials
Reminders count: if a post reminds students about a dated test or deadline, include it.
Resolve relative dates ("this Friday", "next Wednesday") from the announcement's posted date.

Leave out: things dated before today, regular weekly TA office hours, and anything with
no specific date (e.g. "week of October 5" with no day). If an announcement has nothing
to list, return an empty list for it.

Also judge each announcement as a whole:
 important: true only if the student would really regret missing it: a test/exam/quiz
   date, time or room announced or changed; a class, tutorial or lab cancelled or moved;
   a deadline moved, extended or newly added; a required action with a near deadline;
   anything urgent. false for office hours, "slides/materials posted", welcome posts,
   general tips, FAQs and routine reminders.
 alert: if important, one plain sentence (max 140 chars) saying what changed and when,
   e.g. "Test 1 is Sat Oct 17, 10:00-11:30." Otherwise "".

Return one entry per announcement id, with important, alert and an "events" list. Each event:
 title: short, without the course code ("Test 1", "Assignment 2 deadline extended",
   "Last day to withdraw (WND)", "Test 1 review session")
 type: assignment | quiz | exam | event   (tests and midterms are exam)
 date: YYYY-MM-DD
 time: start or due time as HH:MM 24-hour, or "" if none given
 location: the room or place if the announcement gives one (e.g. "SA 515", "Online on Zoom"), else ""
 end_time: HH:MM 24-hour, or ""
 quote: the exact sentence from the announcement that states it

Return {"results": [...]} with one entry per announcement (ann = its id).

Announcements:
`;

export const EVENT = {
  type: "object",
  properties: {
    title: { type: "string" }, type: { type: "string", enum: ["assignment", "quiz", "exam", "event"] },
    date: { type: "string" }, time: { type: "string" }, end_time: { type: "string" }, quote: { type: "string" },
    location: { type: "string" },
  },
  required: ["title", "type", "date", "time", "end_time", "quote", "location"],
};
const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { ann: { type: "string" }, important: { type: "boolean" }, alert: { type: "string" }, events: { type: "array", items: EVENT } },
        required: ["ann", "important", "alert", "events"],
      },
    },
  },
  required: ["results"],
};

export type Ann = { guid: string; title: string; body: string; link: string; posted: number; course: string };
export type Found = { title: string; type: string; date: string; time?: string; end_time?: string; quote?: string; location?: string };
/** `ann`: enough of the post to rebuild its items after it scrolls out of the feed (Brightspace's RSS only
 *  shows the latest few posts; on 2026-10-09 four new STAT posts pushed out the one that dated Test 1, and
 *  Test 1 vanished from the calendar). No body is kept. */
export type Entry = { events: Found[]; important: boolean; alert: string; notified: boolean;
  ann?: { guid: string; title: string; link: string; posted: number; course: string } };
export type AskAnn = (anns: Ann[]) => Promise<{ ann: string; important: boolean; alert: string; events: Found[] }[]>;

const XML_ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function xmlText(s: string | undefined): string {
  if (!s) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1];
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e.toLowerCase()] ?? m);
}
const tag = (xml: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml)?.[1];

export function parseRss(data: string): Ann[] {
  data = data.replace(/^﻿/, "").replace(/^ï»¿/, "");
  const firstItem = data.search(/<item[\s>]/i);
  const chanTitle = xmlText(tag(firstItem >= 0 ? data.slice(0, firstItem) : data, "title")).trim();
  const course = courseOf(chanTitle);
  const out: Ann[] = [];
  for (const m of data.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const x = m[1];
    const title = xmlText(tag(x, "title")).trim();
    const body = plain(xmlText(tag(x, "description")));
    const link = xmlText(tag(x, "link")).trim();
    const guid = (xmlText(tag(x, "guid")) || link || title).trim();
    const t = Date.parse(xmlText(tag(x, "pubDate")).trim());
    out.push({ guid, title, body, link, posted: Number.isFinite(t) ? t : Date.now(), course: course || courseOf(title, body) });
  }
  return out;
}

/** The course an announcements feed belongs to (from its channel title), even with no posts yet. */
export function rssCourse(data: string): string {
  const firstItem = data.search(/<item[\s>]/i);
  return courseOf(xmlText(tag(firstItem >= 0 ? data.slice(0, firstItem) : data, "title")));
}

export async function annKey(a: Ann): Promise<string> {
  return (await sha1hex(`${a.guid}|${a.title}|${head(a.body, 2000)}`)).slice(0, 16);
}

function defaultAsk(ctx: Ctx): AskAnn {
  return async (anns) => {
    const payload = anns.map((a, n) => ({
      id: `a${n}`, course: a.course, posted: strftime({ t: a.posted, tz: ctx.tz }, "%a %Y-%m-%d"),
      title: a.title, text: head(a.body, 3000),
    }));
    const todayStr = strftime({ t: Date.now(), tz: ctx.tz }, "%a %Y-%m-%d");
    const answer = await llmJSON(ctx, PROMPT.replace("{today}", todayStr) + JSON.stringify(payload), SCHEMA, { maxTokens: 4000 });
    return Array.isArray(answer) ? answer : answer?.results ?? [];
  };
}

function hm(s: string | undefined): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(s || "");
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return [+m[1], +m[2]];
}

/** A found date as a calendar item. `from` = where it was read: an announcement, or a school email
 *  (uid prefix and description differ; announcement items are unchanged). */
export async function toItem(f: Found, a: Ann, tz: string, from: "announcement" | "email" = "announcement"): Promise<Item | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) return null;
  const [y, mo, d] = f.date.split("-").map(Number);
  let t0 = hm(f.time), t1 = hm(f.end_time);
  if (t1 && !t0) [t0, t1] = [t1, null];
  let start: DT | string, end: DT | string, allDay: boolean, role: Item["role"];
  if (t0) {
    start = zoned(y, mo, d, t0[0], t0[1], 0, tz);
    end = t1 && (t1[0] * 60 + t1[1] > t0[0] * 60 + t0[1]) ? zoned(y, mo, d, t1[0], t1[1], 0, tz) : start;
    allDay = false;
    role = end === start && f.type !== "event" ? "deadline" : "event";
  } else {
    start = f.date; end = addDays(f.date, 1); allDay = true; role = "event";
  }
  const uid = (from === "email" ? "mail-" : "ann-") + (await sha1hex(`${a.guid}|${f.title}|${f.date}`)).slice(0, 16);
  const quote = (f.quote || "").trim();
  return {
    uid, raw_title: f.title, title: head(f.title.trim(), 100), course: a.course, role, type: f.type,
    start, end, all_day: allDay, opens: null,
    description: `From the ${from === "email" ? "email" : "announcement"} “${a.title}” (${strftime({ t: a.posted, tz }, "%b %-d")}):\n“${quote}”`,
    location: head(String(f.location ?? "").trim(), 80), url: a.link, rrule: "", keep: true, reason: "", source: from, announced: true,
  };
}

const STOP = new Set(["the", "due", "deadline", "for", "and", "of", "on", "is", "be", "will", "extended", "moved"]);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)));

export function duplicate(it: Item, known: Item[], tz: string): boolean {
  return !!sameAs(it, known, tz);
}

/** The known item this found one is about (same course, same day, a shared title word), or null. */
export function sameAs(it: Item, known: Item[], tz: string): Item | null {
  const day = localDate(asDT(it.start, tz), tz);
  const mine = words(it.title);
  for (const k of known) {
    if (k.course !== it.course || k.keep === false) continue;
    const kd = localDate(asDT(k.role === "deadline" && !k.all_day ? k.end : k.start, tz), tz);
    if (kd === day && [...words(k.title)].some((w) => mine.has(w))) return k;
  }
  return null;
}

/** A later post adds a room to something already in the calendar ("Test 1 will be in SA 515"): put it
 *  on that item instead of dropping the post as a duplicate. Only fills a missing room or replaces one
 *  the post says changed; times stay with the item's own source. */
function mergeRoom(k: Item, it: Item, f: Found, a: Ann, tz: string): void {
  const room = String(f.location ?? "").trim();
  if (!room || room === k.location || COURSE_ROOM.test(room)) return;
  k.location = head(room, 80);
  const note = `Room from the announcement “${a.title}” (${strftime({ t: a.posted, tz }, "%b %-d")}): “${(f.quote || "").trim()}”`;
  k.description = k.description ? `${k.description}\n\n${note}` : note;
}
const COURSE_ROOM = /^[A-Z]{4}\s?\d{4}/;

export type Send = (title: string, message: string, click: string) => Promise<void>;

async function alertPhone(ctx: Ctx, anns: Ann[], keys: string[], cache: Record<string, Entry>, send?: Send): Promise<number> {
  if (!(ctx.cfg.phone_alerts && send)) return 0;   // send is only given when alerts are set up
  const recent = Date.now() - ALERT_WINDOW_MS;
  const day = today(ctx.tz);
  let sent = 0;
  for (let i = 0; i < anns.length; i++) {
    const a = anns[i], entry = cache[keys[i]];
    if (!entry || Array.isArray(entry) || !entry.important || entry.notified || a.posted < recent) continue;
    const dates = entry.events.map((e) => String(e.date ?? ""));
    if (dates.length && dates.reduce((x, y) => (x > y ? x : y)) < day) { entry.notified = true; continue; }
    try {
      await send(a.course ? `${a.course}: ${a.title}` : a.title, entry.alert || a.body.slice(0, 300), a.link);
    } catch { continue; }   // retried next run while still recent
    entry.notified = true;
    sent++;
  }
  return sent;
}

export async function announcementItems(
  ctx: Ctx, known: Item[], opts: { ask?: AskAnn; fetchFeed?: (u: string) => Promise<string>; send?: Send } = {},
): Promise<[Item[], string]> {
  const feeds: string[] = (ctx.cfg.announcement_feeds ?? []).filter((f: string) => f.trim());
  if (!feeds.length) return [[], ""];
  if (!opts.ask && !aiReady(ctx)) return [[], ctx.cfg.use_ai === false ? "Announcements need AI reading (it's off in Preferences)" : "Announcements need an AI (cloud sync or a Mistral key)"];
  const fetchFeed = opts.fetchFeed ?? (async (u: string) => (await ctx.fetch(u, { headers: { "User-Agent": "Duely/1.0" } })).text());
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400e3;
  let anns: Ann[] = [], errors = 0;
  const texts = await Promise.allSettled(feeds.map(fetchFeed));
  for (const r of texts) {
    if (r.status === "fulfilled") {
      try { anns = anns.concat(parseRss(r.value).filter((a) => a.posted >= cutoff)); } catch { errors++; }
    } else errors++;
  }

  const stored = await ctx.store.get<Record<string, Entry>>("announcement-cache");
  const firstRun = stored === null;          // never alert about what was already there
  const cache = stored ?? {};
  const keys = await Promise.all(anns.map(annKey));
  const todo = anns.map((a, i) => [a, keys[i]] as const).filter(([, k]) => !(k in cache));
  let status = "";
  if (todo.length) {
    try {
      const ask = opts.ask ?? defaultAsk(ctx);
      const results: Record<number, { important: boolean; alert: string; events: Found[] }> = {};
      for (let i = 0; i < todo.length; i += 15) {
        for (const e of await ask(todo.slice(i, i + 15).map(([a]) => a))) {
          const n = parseInt(String(e.ann ?? "").replace(/^a+/, ""));
          if (Number.isFinite(n)) results[i + n] = e;
        }
      }
      todo.forEach(([, k], n) => {
        const e = results[n];
        cache[k] = { events: e?.events ?? [], important: !!e?.important, alert: e?.alert ?? "", notified: firstRun };
      });
    } catch (e) {
      status = `Announcements: AI failed (${(e as Error).message})`;
    }
  }
  const alerted = await alertPhone(ctx, anns, keys, cache, opts.send);
  const live = new Set(keys);
  const liveGuids = new Set(anns.map((a) => a.guid));
  const day = today(ctx.tz);
  const kept: Record<string, Entry> = {};
  anns.forEach((a, i) => {
    const e = cache[keys[i]];
    if (e && !Array.isArray(e)) e.ann = { guid: a.guid, title: a.title, link: a.link, posted: a.posted, course: a.course };
  });
  for (const [k, v] of Object.entries(cache)) {
    if (live.has(k)) { kept[k] = v; continue; }
    // gone from the feed: an edited post (same guid, new text) replaces it; one that merely scrolled
    // out of the feed keeps its dates until they've passed
    if (Array.isArray(v) || !v.ann || liveGuids.has(v.ann.guid)) continue;
    if (v.events.some((f) => String(f.date ?? "") >= day)) kept[k] = v;
  }
  await ctx.store.put("announcement-cache", kept);

  const out: Item[] = [];
  const sources: [Entry | Found[], Ann][] = anns.map((a, i) => [kept[keys[i]] ?? [], a]);
  for (const [k, v] of Object.entries(kept)) if (!live.has(k) && !Array.isArray(v) && v.ann) sources.push([v, { ...v.ann, body: "" }]);
  for (const [entry, a] of sources) {
    for (const f of (Array.isArray(entry) ? entry : entry.events) as Found[]) {
      if (String(f.date ?? "") < day) continue;
      const it = await toItem(f, a, ctx.tz);
      if (!it) continue;
      const same = sameAs(it, known.concat(out), ctx.tz);
      if (!same) out.push(it);
      else mergeRoom(same, it, f, a, ctx.tz);
    }
  }
  status ||= `${out.length} date(s) found in ${anns.length} announcement(s)`;
  if (alerted) status += ` · ${alerted} phone alert(s) sent`;
  if (errors) status += ` · ${errors} feed(s) unreachable`;
  return [out, status];
}

export { isDate };

/** Fetch one announcements feed; an error page or a non-RSS answer counts as a failure. */
export function fetchRss(u: string, f: typeof fetch = fetch): Promise<string> {
  return f(u, { headers: { "User-Agent": "Duely/1.0" } }).then(async (r) => {
    if (!r.ok) throw new Error(`Brightspace answered ${r.status}`);
    const t = await r.text();
    if (!/<(rss|feed|channel)[\s>]/i.test(t.slice(0, 4000))) throw new Error("the link didn't return an announcements feed");
    return t;
  });
}
