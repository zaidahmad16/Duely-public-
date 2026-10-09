// Merge open/close pairs, guess type, rule-based junk filter: port of syllabus/core/classify.py.
import type { RawEvent } from "./ical.ts";
import { type When, asDT } from "./time.ts";

export type Item = {
  uid: string; raw_title: string; title: string; course: string;
  role: "deadline" | "opens" | "event"; type: string;
  start: When; end: When; all_day: boolean; opens: When | null;
  description: string; location: string; url: string; rrule: string;
  keep: boolean; reason: string; source: string;
  recurrence_extra?: string[]; meetings?: string[]; announced?: boolean;
};

export const COURSE_RE = /\b([A-Z]{3,4})\s?-?\s?(\d{4})[A-Z]?\b/;
const SUFFIX_RE = /^(.*?)\s*[-–:]\s*(due(?: date)?|availability (?:starts|ends)|start date|end date|opens?|closes?|unlocks?|locks?|available|end)\s*$/i;
const START_KINDS = new Set(["availability starts", "start date", "open", "opens", "unlock", "unlocks", "available"]);
const EXAM_RE = /\b(exam|midterm|mid-term|final)\b/i;
const QUIZ_RE = /\b(quiz|test|quest|poll)\b/i;
const ASSIGN_RE = /\b(assignment|assgn|asg|a\d+|lab|project|report|homework|hw|essay|deliverable|submission|tutorial|worksheet|reflection|proposal|presentation|milestone|dropbox)\b/i;
const JUNK_RE = /\b(checklist|content|module|unit \d+ (?:opens|available)|course (?:start|end)|release conditions?|announcement|survey reminder)\b/i;

/** Python-compatible slice by code points (str[:n]). */
export const head = (s: string, n: number) => (/[\uD800-\uDFFF]/.test(s) ? Array.from(s).slice(0, n).join("") : s.slice(0, n));

export function courseOf(...texts: string[]): string {
  for (const t of texts) {
    const m = COURSE_RE.exec(t || "");
    if (m) return `${m[1]} ${m[2]}`;
  }
  return "";
}

function splitTitle(summary: string): [string, string] {
  const m = SUFFIX_RE.exec(summary);
  if (!m) return [summary.trim(), "event"];
  const k = m[2].toLowerCase();
  const kind = k.startsWith("due") ? "due" : START_KINDS.has(k) ? "start" : "end";
  return [m[1].trim() || summary.trim(), kind];
}

function guessType(title: string, kind: string): string {
  if (EXAM_RE.test(title)) return "exam";
  if (QUIZ_RE.test(title)) return "quiz";
  if (kind === "due" || ASSIGN_RE.test(title)) return "assignment";
  return "event";
}

type Ev = RawEvent & { base: string; kind: string; course: string };

export function buildItems(events: RawEvent[], localTz: string): Item[] {
  const groups = new Map<string, Record<string, Ev>>();
  const singles: Ev[] = [];
  for (const raw of events) {
    const [base, kind] = splitTitle(raw.summary);
    const course = courseOf(raw.location, raw.summary, raw.description, raw.categories);
    const ev: Ev = { ...raw, base, kind, course };
    if (kind === "event") singles.push(ev);
    else {
      const key = `${course}\u0000${base.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, {});
      groups.get(key)![kind] = ev;
    }
  }
  const items: Item[] = [];
  for (const g of groups.values()) {
    const deadline = g.due ?? g.end;
    if (deadline) items.push(item(deadline, "deadline", g.start));
    else items.push(item(g.start, "opens"));
  }
  for (const ev of singles) items.push(item(ev, "event"));
  const key = (i: Item) => asDT(i.start, localTz).t;
  return items.map((it, n) => [it, n] as const).sort((a, b) => key(a[0]) - key(b[0]) || a[1] - b[1]).map(([it]) => it);
}

function item(ev: Ev, role: Item["role"], opens?: Ev): Item {
  const title = ev.base;
  const type = role !== "event" ? guessType(title + " " + head(ev.description, 200), ev.kind) : guessType(title, "event");
  const it: Item = {
    uid: ev.uid, raw_title: ev.summary, title, course: ev.course, role, type,
    start: ev.start, end: ev.end, all_day: ev.all_day, opens: opens ? opens.start : null,
    description: ev.description, location: ev.location, url: ev.url || firstUrl(ev.description),
    rrule: ev.rrule ?? "", keep: true, reason: "", source: "rules",
  };
  [it.keep, it.reason] = ruleVerdict(it);
  return it;
}

function firstUrl(text: string): string {
  const m = /https?:\/\/\S+/.exec(text || "");
  return m ? m[0].replace(/[).,]+$/, "") : "";
}

function ruleVerdict(it: Item): [boolean, string] {
  if (JUNK_RE.test(`${it.raw_title} ${head(it.description, 200)}`)) return [false, "Course content / admin noise"];
  if (it.role === "opens") return [false, "Only an 'opens' date, no deadline"];
  return [true, ""];
}

/** (start, end) for the calendar event. Long quiz windows collapse to the closing time. */
export function deadlineWindow(it: Item, localTz: string): [When, When] {
  if (it.role === "deadline") {
    const due = it.end && !it.all_day ? it.end : it.start;
    if (it.opens && (it.type === "quiz" || it.type === "exam") && !it.all_day) {
      const opens = asDT(it.opens, localTz);
      const gap = asDT(due, localTz).t - opens.t;
      if (gap > 0 && gap <= 12 * 3600e3) return [opens, due];
    }
    return it.all_day ? [it.start, it.end] : [due, due];
  }
  return [it.start, it.end];
}
