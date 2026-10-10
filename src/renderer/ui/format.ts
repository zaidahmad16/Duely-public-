// Human dates and times in the student's time zone, and the engine's Slack-style text as safe DOM.
import type { Row } from "../../shared/types.ts";
import { h } from "./h.ts";

let LOCALE: string | undefined;
/** Dates and times follow the computer's locale (set from the main process at start). */
export function setLocale(l: string | undefined) {
  try { if (l) { new Intl.DateTimeFormat(l); LOCALE = l; } } catch { /* unknown locale: keep the default */ }
}
const fmt = (tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { timeZone: tz, ...o });


/** A calendar date ("YYYY-MM-DD") in the computer's locale, e.g. "Sep 7" / "7 Sept". */
export const dayText = (day: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", ...o }).format(Date.parse(`${day}T12:00:00Z`));

export function isoDay(t: number, tz: string): string {
  const p = Object.fromEntries(fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export const time = (t: number, tz: string) => fmt(tz, { hour: "numeric", minute: "2-digit" }).format(t);
export const weekdayShort = (t: number, tz: string) => fmt(tz, { weekday: "short" }).format(t);
export const dateShort = (t: number, tz: string) => fmt(tz, { weekday: "short", month: "short", day: "numeric" }).format(t);

function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A time range "10:00–11:30 AM" (the AM/PM once when both ends share it, in any locale). */
export function range(a: number, b: number, tz: string): string {
  const f = fmt(tz, { hour: "numeric", minute: "2-digit" });
  const pa = f.formatToParts(a), pb = f.formatToParts(b);
  const period = (p: Intl.DateTimeFormatPart[]) => p.find((x) => x.type === "dayPeriod")?.value;
  if (period(pa) && period(pa) === period(pb)) {
    const bare = pa.filter((x) => x.type !== "dayPeriod").map((x) => x.value).join("").trim();
    return `${bare}–${f.format(b)}`;
  }
  return `${f.format(a)}–${f.format(b)}`;
}

/** "Today", "Tomorrow", or "Wednesday, Oct 14" for a local day. */
export function dayLong(day: string, tz: string, now: number): string {
  const today = isoDay(now, tz);
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return fmt("UTC", { weekday: "long", month: "short", day: "numeric" }).format(Date.parse(day + "T12:00:00Z"));
}

/** The due/when column: "11:59 PM", "Due in 2h", "Tomorrow · 10:00 AM", "Fri · 11:59 PM", "Mon, Oct 19". */
export function when(r: Row, tz: string, now: number, timeOnly = false): { text: string; urgent: boolean } {
  const today = isoDay(now, tz);
  const left = r.t - now;
  if (r.deadline && !r.allDay && left > 0 && left < 6 * 3600e3) {
    const min = Math.max(1, Math.round(left / 60e3));
    return { text: min >= 60 ? `Due in ${Math.round(min / 60)}h` : `Due in ${min} min`, urgent: true };
  }
  const t = r.allDay ? "" : r.end && !r.deadline ? range(r.t, r.end, tz) : time(r.t, tz);
  let day: string;
  if (timeOnly) day = r.allDay ? "All day" : "";
  else if (r.day === today) day = r.allDay ? "Today" : "";
  else if (r.day === addDays(today, 1)) day = "Tomorrow";
  else if (r.day <= addDays(today, 6)) day = weekdayShort(r.t, tz);
  else day = dateShort(r.allDay ? Date.parse(r.day + "T12:00:00Z") : r.t, r.allDay ? "UTC" : tz);
  return { text: [day, t].filter(Boolean).join(" · "), urgent: false };
}

/** "just now", "2 min ago", "3 h ago", "yesterday". */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return s < 172800 ? "yesterday" : `${Math.round(s / 86400)} days ago`;
}

/** Slack-style markup (*bold*, _italic_, <url|text>, bare links, "• " lists) -> DOM nodes. */
export function rich(text: string, openLink: (url: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*(•|-|\d+\.)\s/.test(l))) {
      const list = h("ul", { class: "rich-list" });
      for (const l of lines) list.append(h("li", null, inline(l.replace(/^\s*(•|-|\d+\.)\s/, ""), openLink)));
      frag.append(list);
    } else {
      const p = h("p", { class: "rich-p" });
      lines.forEach((l, i) => { if (i) p.append(h("br")); p.append(inline(l, openLink)); });
      frag.append(p);
    }
  }
  return frag;
}

const TOKEN = /<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>|\*([^*\n]+)\*|_([^_\n]+)_|(https?:\/\/[^\s<>)]+)/g;

function inline(s: string, openLink: (url: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    frag.append(s.slice(last, m.index));
    const url = m[1] ?? m[5];
    if (url) {
      frag.append(h("a", { href: "#", on: { click: (e) => { e.preventDefault(); openLink(url); } } }, m[2] ?? url.replace(/^https?:\/\//, "").slice(0, 48)));
    } else if (m[3]) frag.append(h("strong", null, m[3]));
    else if (m[4]) frag.append(h("em", null, m[4]));
    last = (m.index ?? 0) + m[0].length;
  }
  frag.append(s.slice(last));
  return frag;
}
