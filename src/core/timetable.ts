// Weekly class timetable from config -> recurring calendar items (port of core/timetable.py).
import type { Item } from "./classify.ts";
import { strftime, strftimeDate, zoned, type DT } from "./time.ts";

const WEEKDAY_CODE = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

// Day numbers instead of Date objects: this runs ~100 days x every class on each sync.
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400e3;
const dayStr = (n: number) => new Date(n * 86400e3).toISOString().slice(0, 10);
const wdOf = (n: number) => (n + 3) % 7;   // 1970-01-01 was a Thursday; Monday = 0

function days(a: string, b: string): string[] {
  const out: string[] = [];
  for (let n = dayNum(a), end = dayNum(b); n <= end; n++) out.push(dayStr(n));
  return out;
}

export function timetableItems(cfg: any, tz: string): Item[] {
  // Long-finished terms are skipped: their events stay as a record (only future events are removed).
  const cutoff = new Date(Date.now() - (cfg.lookback_days ?? 14) * 86400e3).toISOString().slice(0, 10);
  const out: Item[] = [];
  for (const [t, classes, tag] of [[cfg.term, cfg.classes, ""], ...(cfg.terms ?? []).map((t: any) => [t, t.classes, "@" + t.start])]) {
    if (t && (t.end ?? "9999") >= cutoff) out.push(...termItems(t, classes, tag, tz));
  }
  out.push(...examItems(cfg, tz, cutoff));
  return out;
}

/** Final exams from cfg.exams (syllabus/core/exam_import.py) as exam events (twin: timetable.py exam_items). */
export function examItems(cfg: any, tz: string, cutoff = ""): Item[] {
  const out: Item[] = [];
  for (const e of cfg.exams ?? []) {
    if (e.date < cutoff) continue;
    const [y, mo, d] = e.date.split("-").map(Number);
    const [h0, m0] = e.start.split(":").map(Number), [h1, m1] = e.end.split(":").map(Number);
    out.push({
      uid: `exam-${e.course.replace(/ /g, "")}-${e.date}-${e.start}`, raw_title: `${e.course} ${e.title}`, title: e.title, course: e.course,
      role: "event", type: "exam", start: zoned(y, mo, d, h0, m0, 0, tz), end: zoned(y, mo, d, h1, m1, 0, tz), all_day: false, opens: null,
      description: "From your final exam schedule", location: e.room ?? "", url: "", rrule: "", keep: true, reason: "", source: "exams",
    } as Item);
  }
  return out;
}

function termItems(term: any, classes: any[], tag: string, tz: string): Item[] {
  if (!term || !classes?.length) return [];
  const t0: string = term.start, t1: string = term.end;
  const skip = new Set<string>();
  for (const [a, b] of term.no_class ?? []) for (const d of days(a, b)) skip.add(d);
  const swaps: Record<string, string> = term.day_swaps ?? {};

  const span = days(t0, t1);
  const wd = span.map((d) => WEEKDAY_CODE[wdOf(dayNum(d))]);
  const out: Item[] = [];
  for (const c of classes) {
    const dys: string[] = c.days.map((d: string) => d.toUpperCase());
    const [h0, m0] = c.start.split(":").map(Number);
    const [h1, m1] = c.end.split(":").map(Number);
    const at = (d: string, h = h0, m = m0): DT => {
      const [y, mo, dd] = d.split("-").map(Number);
      return zoned(y, mo, dd, h, m, 0, tz);
    };
    const meetings: string[] = [], regular: string[] = [];
    span.forEach((d, i) => {
      if (!skip.has(d) && dys.includes(swaps[d] ?? wd[i])) meetings.push(d);
      if (dys.includes(wd[i])) regular.push(d);
    });
    if (!meetings.length) continue;
    const first = regular[0];
    const mset = new Set(meetings), rset = new Set(regular);
    const exdates = regular.filter((d) => !mset.has(d));
    const rdates = meetings.filter((d) => !rset.has(d));

    const until = at(t1, 23, 59);
    const untilUtc = strftime({ t: until.t + 59000, tz: "UTC" }, "%Y%m%dT%H%M%SZ");
    const rrule = `FREQ=WEEKLY;BYDAY=${dys.join(",")};UNTIL=${untilUtc}`;
    const stamp = (ds: string[]) => ds.map((d) => strftime(at(d), "%Y%m%dT%H%M%S")).join(",");
    const extra: string[] = [];
    if (exdates.length) extra.push(`EXDATE;TZID=${tz}:${stamp(exdates)}`);
    if (rdates.length) extra.push(`RDATE;TZID=${tz}:${stamp(rdates)}`);

    const kind = c.kind || "Class";
    const sec = c.section ? `-${c.section}` : "";
    const desc = [`${c.course}${sec} ${kind}`];
    if (c.crn) desc.push(`CRN ${c.crn}`);
    if (exdates.length) desc.push("No class: " + exdates.map((d) => strftimeDate(d, "%b %-d")).join(", "));
    if (rdates.length) desc.push("Extra meeting: " + rdates.map((d) => strftimeDate(d, "%b %-d")).join(", "));
    out.push({
      uid: `class-${c.course.replace(/ /g, "")}${sec}-${dys.join("")}-${c.start}${tag}`,
      raw_title: `${c.course}${sec} ${kind}`, title: kind, course: c.course, role: "event", type: "class",
      start: at(first), end: at(first, h1, m1), all_day: false, opens: null,
      description: desc.join("\n"), location: c.room ?? "", url: "", rrule,
      recurrence_extra: extra, meetings, keep: true, reason: "", source: "timetable",
    });
  }
  return out;
}
