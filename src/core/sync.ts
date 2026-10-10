// Feed -> classify -> AI filter -> timetable -> announcements -> diff against the Google calendar.
// Port of syllabus/core/sync.py; event bodies hash identically to the desktop app's.
import { announcementItems, type AskAnn, type Send } from "./announcements.ts";
import { type Item, COURSE_RE, buildItems, deadlineWindow, head } from "./classify.ts";
import type { Cal } from "./gcal.ts";
import { type Ask, type Ctx, apply } from "./aifilter.ts";
import { nextOccurrence, parse, rruleUntil } from "./ical.ts";
import { timetableItems } from "./timetable.ts";
import { type DT, type When, addDays, asDT, isDate, iso, strftime, today } from "./time.ts";
import { pyDumps, sha1hex } from "./util.ts";
import { STUDY_DEFAULTS } from "./study.ts";

const ANNOUNCED_COLOR = "5";
const COLORS: Record<string, string> = { assignment: "9", quiz: "6", exam: "11", event: "2", class: "8", study: "7" };
const VERB: Record<string, string> = { assignment: "due", quiz: "closes", exam: "closes" };
const WRITE_CAP = 30;   // Workers Free allows 50 outbound requests per run

export const DEFAULTS = {
  calendar_name: "Brightspace", calendar_id: null,
  sync_types: { assignment: true, quiz: true, exam: true, event: true, class: true },
  reminders: [1440, 120], event_reminders: false, lookback_days: 14,
  use_ai: true, ai_neuron_daily_limit: 3000,
  overrides: {}, term: null, classes: [], announcement_feeds: [], phone_alerts: true,   // notify about important announcements
  slack_user_id: "", tz: "",   // "" = the computer's time zone
  digest_daily: true, digest_time: "07:30", digest_weekly: true, weekly_day: 6, weekly_time: "19:00", heavy_threshold: 4,
  ...STUDY_DEFAULTS,
};

function last(it: Item, tz: string): number {
  if (it.rrule) return rruleUntil(it.rrule, tz)?.t ?? Number.MAX_SAFE_INTEGER;
  return asDT(it.end || it.start, tz).t;
}

export async function build(
  ctx: Ctx, feedText: string, opts: { ask?: Ask; annAsk?: AskAnn; annFetch?: (u: string) => Promise<string>; send?: Send } = {},
): Promise<[Item[], string]> {
  const { cfg, tz } = ctx;
  const cutoff = Date.now() - cfg.lookback_days * 86400e3;
  // 2 days of slack so time zones never decide what gets pre-skipped; the exact cutoff is applied below
  const minDay = strftime({ t: cutoff - 2 * 86400e3, tz: "UTC" }, "%Y%m%d");
  const items = buildItems(parse(feedText, tz, minDay), tz).filter((it) => last(it, tz) >= cutoff);
  let status = await apply(items, ctx, opts.ask);
  items.push(...timetableItems(cfg, tz));
  const [annItems, annStatus] = await announcementItems(ctx, items, { ask: opts.annAsk, fetchFeed: opts.annFetch, send: opts.send });
  items.push(...annItems);
  if (annStatus) status = status ? `${status}  ·  ${annStatus}` : annStatus;
  for (const it of items) {
    const ov = cfg.overrides?.[it.uid];
    if (ov) { it.keep = ov === "keep"; it.source = "you"; }
    if (it.keep && cfg.sync_types?.[it.type] === false) {
      it.keep = false;
      it.reason = `${it.type[0].toUpperCase()}${it.type.slice(1)}s turned off`;
    }
  }
  return [items, status];
}

function when(value: When, allDay: boolean, recurring: boolean, tz: string): any {
  if (allDay && isDate(value)) return { date: value };
  const dt = asDT(value, tz);
  const out: any = { dateTime: iso(dt) };
  if (recurring) out.timeZone = dt.tz === "Z" ? tz : dt.tz;
  return out;
}

export async function eventBody(it: Item, cfg: any, tz: string): Promise<any> {
  let [start, end] = deadlineWindow(it, tz);
  const allDay = it.all_day && isDate(start);
  if (allDay && isDate(start) && isDate(end) && end <= start) end = addDays(start, 1);
  const prefix = it.course && !it.title.includes(it.course) ? `[${it.course}] ` : "";
  let title = ((it as any).done ? "✓ " : "") + prefix + it.title;   // done: Worker-only flag (done.ts)
  if (it.announced) title += it.source === "email" ? " (from email)" : " (from announcement)";   // email: Worker only
  const same = isDate(start) || isDate(end) ? start === end : (start as DT).t === (end as DT).t;
  if (it.role === "deadline" && same && VERB[it.type] && !it.announced) title += ` ${VERB[it.type]}`;

  const lines: string[] = [];
  if (it.opens) lines.push(`Opens: ${strftime({ t: asDT(it.opens, tz).t, tz }, "%a %b %-d, %-I:%M %p")}`);
  if (it.description) lines.push(head(it.description, 1500));
  if (it.url) lines.push(it.url);
  lines.push(({ timetable: "From your timetable, synced by Duely",
    announcement: "Read from a course announcement by AI. Double-check the original.",
    study: "Planned by Duely" } as Record<string, string>)[it.source]
    ?? "Synced from Brightspace by Duely");

  // weekly classes never get reminders (a pop-up the day before every lecture is noise)
  const remind = !(it as any).done && it.type !== "study" && it.type !== "class" && (it.type !== "event" || cfg.event_reminders);
  const body: any = {
    summary: title,
    description: lines.join("\n\n"),
    start: when(start, allDay, !!it.rrule, tz),
    end: when(end, allDay, !!it.rrule, tz),
    colorId: it.announced ? ANNOUNCED_COLOR : COLORS[it.type],
    transparency: it.role === "deadline" ? "transparent" : "opaque",
    reminders: { useDefault: false, overrides: remind ? cfg.reminders.slice(0, 5).map((m: number) => ({ method: "popup", minutes: Math.trunc(m) })) : [] },
  };
  if (it.rrule) body.recurrence = ["RRULE:" + it.rrule, ...(it.recurrence_extra ?? [])];
  // a room for events, classes, tests and quizzes (a hand-in's "location" is just the course name)
  if (it.location && ["event", "class", "exam", "quiz"].includes(it.type) && !COURSE_RE.test(it.location)) body.location = it.location;
  const h = (await sha1hex(pyDumps(body))).slice(0, 16);
  body.extendedProperties = { private: { bsUid: head(it.uid, 900), bsHash: h } };
  return body;
}

export async function push(items: Item[], ctx: Ctx, cal: Cal, cap = WRITE_CAP) {
  const { cfg, tz } = ctx;
  const calId = await cal.ensureCalendar(cfg.calendar_name, cfg.calendar_id, tz);
  if (calId !== cfg.calendar_id) { cfg.calendar_id = calId; await ctx.store.put("config", stripSecrets(cfg)); }
  const existing = new Map<string, any>();
  for (const ev of await cal.listEvents(calId)) {
    const uid = ev.extendedProperties?.private?.bsUid;
    if (uid) existing.set(uid, ev);
  }
  let added = 0, updated = 0, removed = 0, writes = 0, pending = 0;
  const wanted = new Set<string>();
  for (const it of items) {
    if (!it.keep) continue;
    const body = await eventBody(it, cfg, tz);
    const uid = body.extendedProperties.private.bsUid;
    wanted.add(uid);
    const ev = existing.get(uid);
    const change = !ev ? "insert" : ev.extendedProperties?.private?.bsHash !== body.extendedProperties.private.bsHash ? "update" : null;
    if (!change) continue;
    if (writes >= cap) { pending++; continue; }
    writes++;
    if (change === "insert") { await cal.insert(calId, body); added++; }
    else { await cal.update(calId, ev.id, body); updated++; }
  }
  const now = Date.now();
  for (const [uid, ev] of existing) {
    if (wanted.has(uid)) continue;
    let whenStr: string = ev.end?.dateTime ?? ev.end?.date ?? "";
    const rec = (ev.recurrence ?? []).find((r: string) => r.startsWith("RRULE:"));
    if (rec) { const u = rruleUntil(rec.slice(6), tz); whenStr = u ? new Date(u.t).toISOString() : "9999-12-31"; }
    const ends = whenStr.includes("T") ? Date.parse(whenStr) : asDT(whenStr || today(tz), tz).t;
    if (!(ends >= now)) continue;   // past events stay as a record
    if (writes >= cap) { pending++; continue; }
    writes++;
    await cal.delete(calId, ev.id);
    removed++;
  }
  return { added, updated, removed, pending };
}

/** Items as the desktop app's state.json has them (ISO strings, plus `next` for repeats). */
export function serial(it: Item, tz: string): any {
  const out: any = { ...it };
  const fmt = (w: When | null | undefined) => (w == null ? null : isDate(w) ? w : iso(w));   // older saved records may lack a field
  if (it.meetings?.length) {
    const day = today(tz);
    const s = asDT(it.start, tz);
    const at = (d: string) => {
      const diff = s.t - asDT(strftime({ t: s.t, tz }, "%Y-%m-%d"), tz).t;
      return { t: asDT(d, tz).t + diff, tz };
    };
    let d = it.meetings.find((m) => m >= day);
    let nxt = d ? at(d) : null;
    if (nxt && nxt.t < Date.now()) { d = it.meetings.find((m) => m > day); nxt = d ? at(d) : null; }
    out.next = nxt ? iso(nxt) : null;
  } else if (it.rrule) {
    const n = nextOccurrence(it.start, it.rrule, Date.now(), tz);
    out.next = n ? iso(n) : null;
  }
  out.start = fmt(it.start); out.end = fmt(it.end); out.opens = fmt(it.opens);
  return out;
}

export function stripSecrets(cfg: any): any {
  const { gemini_key, slack_webhook, slack_bot_token, slack_signing_secret, mistral_key, ...rest } = cfg;   // gemini_key: old configs
  return rest;
}
