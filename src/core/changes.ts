// Tests and deadlines that change: moved (extensions, rescheduled tests) or a room added/changed
// (2026-10-09: the STAT prof will post the Test 1 room later). One DM per change, once. They only
// inform: the calendar already follows the sources (announcement dates are automatic by the user's
// choice). Vanished items are vanished.ts's job; this one is about items still there.
//   matched by uid, else by course + title (a "moved" item can come back with a new uid)
import { isWork } from "./kinds.ts";
import { strftime } from "./time.ts";

const MANY = 5;
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const when = (it: any): number => {
  const v = it.role === "deadline" ? it.end ?? it.start : it.start;
  return typeof v === "string" ? Date.parse(v.includes("T") ? v : v + "T00:00:00") : Number(v?.t ?? NaN);
};
const allDay = (it: any) => typeof it.start === "string" && !it.start.includes("T");

export type Change = { key: string; title: string; text: string };

/** Changes between the last sync's items and this one's (both serialised). */
export function changedItems(prev: any[], now: any[], tz: string, at = Date.now()): Change[] {
  if (!prev.length) return [];                                       // first sync: nothing to compare
  const byUid = new Map(prev.map((i) => [String(i.uid), i]));
  const byName = new Map(prev.map((i) => [`${i.course}|${norm(i.title)}`, i]));
  const out: Change[] = [];
  for (const it of now) {
    if (!isWork(it) || it.done || ["study", "email"].includes(it.source) || it.keep === false) continue;
    const t = when(it);
    if (!(t > at)) continue;
    const old = byUid.get(String(it.uid)) ?? byName.get(`${it.course}|${norm(it.title)}`);
    if (!old || old.done) continue;
    const name = `${it.course ? it.course + " " : ""}${it.title}`;
    const fmt = (x: any) => strftime({ t: when(x), tz }, allDay(x) ? "%a %b %-d" : "%a %b %-d, %-I:%M %p");
    const t0 = when(old);
    if (!Number.isNaN(t0) && t0 !== t) {
      out.push({ key: `moved:${it.uid}:${t}`, title: `📅 ${name} moved`, text: `${fmt(old)} → *${fmt(it)}*` });
    }
    const room = String(it.location ?? "").trim(), was = String(old.location ?? "").trim();
    if (room && room !== was && it.type !== "assignment" && !/^[A-Z]{4}\s?\d{4}/.test(room)) {
      out.push({ key: `room:${it.uid}:${room}`, title: `📍 ${name}: room ${room}`, text: was ? `It was ${was}. ${fmt(it)}.` : `${fmt(it)}.` });
    }
  }
  return out;
}

/** What to send: changes not sent before; many at once = one summary (a feed glitch, most likely). */
export function changeMessages(changes: Change[], sent: Record<string, number>): { title: string; text: string }[] {
  const fresh = changes.filter((c) => !sent[c.key]);
  if (fresh.length > MANY) {
    return [{ title: `${fresh.length} tests and deadlines changed at once`, text: fresh.slice(0, 8).map((c) => `• ${c.title.replace(/^\S+ /, "")}: ${c.text}`).join("\n")
      + (fresh.length > 8 ? `\n…and ${fresh.length - 8} more` : "") + "\n_If that looks wrong, Brightspace may have had a hiccup; I'll keep checking._" }];
  }
  return fresh.map((c) => ({ title: c.title, text: c.text }));
}

/** Remember what was sent (60 days). */
export function markSent(changes: Change[], sent: Record<string, number>, at = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(sent)) if (at - v < 60 * 864e5) out[k] = v;
  for (const c of changes) out[c.key] = out[c.key] ?? at;
  return out;
}
