// Code checks on what an AI wrote, before it goes to Slack. The AI is good at wording and bad at
// facts: it calls tomorrow's 11:59 PM deadline "tonight", pairs a date with the wrong weekday,
// mentions dates that aren't in the calendar, and rambles. Each check here is deterministic.
import { addDays, strftimeDate } from "./time.ts";

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WD_RE = String.raw`(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|rsday|urday)?\.?,?`;
const DATE_RE = new RegExp(String.raw`\b(?:(${WD_RE})\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "gi");

export type GuardItem = { title: string; course?: string; day: string };   // day = local YYYY-MM-DD

/** The local date a "Mon Oct 9" in the text means: the year that puts it nearest to today. */
function resolveDay(mon: number, d: number, today: string): string | null {
  if (d < 1 || d > 31) return null;
  const y = Number(today.slice(0, 4));
  let best: string | null = null, gap = Infinity;
  for (const yy of [y - 1, y, y + 1]) {
    const s = `${yy}-${String(mon + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const t = Date.parse(s + "T00:00:00Z");
    if (Number.isNaN(t) || new Date(t).getUTCDate() !== d) continue;
    const g = Math.abs(t - Date.parse(today + "T00:00:00Z"));
    if (g < gap) { gap = g; best = s; }
  }
  return best;
}

/** Every date the text mentions, as local days. */
export function datesIn(text: string, today: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const day = resolveDay(MON.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[3]), today);
    if (day) out.push(day);
  }
  return out;
}

/** "Thursday Oct 9" when Oct 9 is a Friday -> "Friday Oct 9" (same style: short or long). */
function fixWeekdays(text: string, today: string): string {
  return text.replace(DATE_RE, (all, wd: string | undefined, mon: string, d: string) => {
    if (!wd) return all;
    const day = resolveDay(MON.indexOf(mon.slice(0, 3).toLowerCase()), Number(d), today);
    if (!day) return all;
    const real = new Date(day + "T00:00:00Z").getUTCDay();
    const said = WD.indexOf(wd.slice(0, 3).toLowerCase());
    if (said === real) return all;
    const long = /day/i.test(wd);
    let name = long ? LONG[real] : strftimeDate(day, "%a");
    if (wd[0] === wd[0].toLowerCase()) name = name.toLowerCase();
    return all.replace(new RegExp(`^${wd.replace(/[.,]/g, "")}`), name);
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The items a line talks about: its title, or "COURSE + a distinctive part of the title". */
function itemsIn(line: string, items: GuardItem[]): GuardItem[] {
  const l = ` ${norm(line)} `;
  return items.filter((it) => {
    const t = norm(it.title);
    if (t.length >= 4 && l.includes(` ${t} `)) return true;
    const head = t.split(" ").slice(0, 3).join(" ");                   // "assignment 1 client"
    const course = it.course ? norm(it.course) : "";
    return head.length >= 6 && l.includes(` ${head}`) && (!course || l.includes(course) || l.includes(course.split(" ")[1]));
  });
}

/** Wrong "tonight"/"today"/"tomorrow" for the item a line is about -> the right words. */
function fixDayWords(text: string, items: GuardItem[], today: string): string {
  const tomorrow = addDays(today, 1);
  return text.split("\n").map((line) => {
    const days = [...new Set(itemsIn(line, items).map((i) => i.day))];
    if (days.length !== 1) return line;                                 // none or ambiguous: leave it
    const day = days[0];
    const on = `on ${strftimeDate(day, "%a %b %-d")}`;
    if (day !== today && /\btonight\b/i.test(line)) {
      line = line.replace(/\b(due )?tonight\b/gi, (_m, due) => (due ?? "") + (day === tomorrow ? "tomorrow night" : on));
    }
    if (day !== today && /\btoday\b/i.test(line) && !/\b(today|tonight)\b.*\b(start|begin|work|study|prep)/i.test(line)) {
      line = line.replace(/\b(due )?today\b/gi, (_m, due) => (due ?? "") + (day === tomorrow ? "tomorrow" : on));
    }
    if (day === today && /\btomorrow\b/i.test(line) && !/\btomorrow\b.*\b(start|begin|work|study|prep)/i.test(line)) {
      line = line.replace(/\btomorrow( night)?\b/gi, (_m, night) => (night ? "tonight" : "today"));
    }
    return line;
  }).join("\n");
}

/** Slack-safe formatting the AI tends to break. Links made by our code (<https://…|title>) stay. */
function tidy(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/<LINK\|[^>]*>|\[LINK\]|\(LINK\)/gi, "")
    .replace(/(^|[^<|(])\bhttps?:\/\/\S+/g, "$1")                       // bare URLs it made up
    .replace(/\[(?:source|ref)?\s*\]/gi, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** At most `maxLines` non-empty lines and `maxChars`, cut at a line boundary. */
export function clamp(text: string, maxLines = 10, maxChars = 1500): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let n = 0, chars = 0, cut = false;
  for (const l of lines) {
    if (l.trim()) n++;
    if (n > maxLines || chars + l.length > maxChars) { cut = true; break; }
    out.push(l);
    chars += l.length + 1;
  }
  if (!cut) return text;
  while (out.length && (!out[out.length - 1].trim() || /:\*?$/.test(out[out.length - 1].trim()))) out.pop();  // no dangling heading
  return out.join("\n") + "\n_(Ask for more detail if you want it.)_";
}

export type GuardResult = { text: string; unknownDates: string[] };

/** All checks. `allowed` = extra days that may be mentioned (announcement dates); today and the
 *  items' own days are always allowed. */
export function guard(text: string, items: GuardItem[], today: string, allowed: string[] = [],
  limits: { maxLines?: number; maxChars?: number } = {}): GuardResult {
  let t = tidy(text);
  t = fixWeekdays(t, today);
  t = fixDayWords(t, items, today);
  const ok = new Set([today, addDays(today, 1), ...items.map((i) => i.day), ...allowed]);
  const unknownDates = [...new Set(datesIn(t, today).filter((d) => !ok.has(d)))];
  return { text: clamp(t, limits.maxLines, limits.maxChars), unknownDates };
}
