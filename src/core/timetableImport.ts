// Timetable and final exam schedule from screenshots (port of the personal Duely's term_import.py and
// exam_import.py). The AI reads the images; nothing is saved here: the app shows what was read for review
// first, and only "Add to calendar" saves it to cfg.terms / cfg.exams (src/core/timetable.ts turns those
// into calendar events, in the app and in the script alike).
import type { Item } from "./classify.ts";
import { type AICtx, llmJSON } from "./llm.ts";
import { feedBreaks } from "./timetable.ts";
import { strftime, today } from "./time.ts";
import { plain } from "./util.ts";
import type { Image } from "../llm/types.ts";

export { feedBreaks };

export const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export type Class = { course: string; section: string; kind: string; days: string[]; start: string; end: string; room: string; crn: string };
export type Term = { name: string; start: string; end: string; no_class: [string, string][]; day_swaps: Record<string, string>; classes: Class[]; dates_source?: string };
export type Exam = { course: string; title: string; date: string; start: string; end: string; room: string };
/** What reading screenshots gives: the terms to review, each with what Duely noticed. */
export type TimetableRead = { terms: (Term & { tba: string[]; notes: string[] })[] };

const PROMPT = `You are reading screenshots of a university student's weekly class timetable (for example a
week view from the school's registration system). The screenshots may show ONE OR MORE terms (e.g. Fall and
Winter); return one entry per term. Today is {today}.

For each term, list every class meeting pattern:
 course: subject + number with a space, e.g. "COMP 3804"
 section: e.g. "A", "A1", "A2" (the part after the dash or space), "" if none
 kind: "Lecture" for letter-only sections (A, B, C), "Tutorial" for sections with a digit (A1, A2, D1),
   unless the screenshot says otherwise (Lab, Seminar...)
 days: two-letter codes MO TU WE TH FR SA SU on which this exact section meets at this time
 start, end: 24-hour HH:MM
 room: as shown (e.g. "AT 102"), "" if none
 crn: the registration number shown (e.g. 5 digits), "" if none
Read every box on its own, one weekday column at a time, then combine: days go in ONE entry only when the
course, section, start, end AND room are all identical. If a section's room (or time) differs between days,
make separate entries, one per room. Copy course codes exactly as printed in each box, even if two boxes of
the same class look inconsistent.
Courses listed without meeting times (TBA, online): put their codes in "tba", not in classes.

Work out which term each screenshot is from the dates on it (e.g. "WINTER 2027 (Jan 11, 2027 to Apr 16, 2027)").
{dates_help}
For each term return:
 name: e.g. "Winter 2027"
 start, end: first and last day of classes, YYYY-MM-DD
 no_class: [start, end] date ranges with no classes in this term (breaks, statutory holidays)
 day_swaps: dates in this term when classes follow another weekday's schedule,
   as {"date": "YYYY-MM-DD", "follows": "MO"}; also check notes printed on the screenshot
 dates_source: "academic calendar" if the dates came from the page below, otherwise "estimate"
`;

const DATES_HELP_PAGE = `Use the school's academic dates page below for each term's first/last day of classes,
breaks, holidays and "follows a Monday schedule" days.

Academic dates page (text):
`;
const DATES_HELP_NONE = `No academic calendar is available: take the term's first and last day from the dates printed
on the screenshot (or estimate them), and leave no_class and day_swaps empty unless the screenshot states them.`;

const CLASS = {
  type: "object",
  properties: {
    course: { type: "string" }, section: { type: "string" }, kind: { type: "string" },
    days: { type: "array", items: { type: "string", enum: [...DAY_CODES] } },
    start: { type: "string" }, end: { type: "string" }, room: { type: "string" }, crn: { type: "string" },
  },
  required: ["course", "section", "kind", "days", "start", "end", "room", "crn"],
};
const TERM = {
  type: "object",
  properties: {
    name: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    no_class: { type: "array", items: { type: "array", items: { type: "string" } } },
    day_swaps: { type: "array", items: { type: "object", properties: { date: { type: "string" }, follows: { type: "string" } }, required: ["date", "follows"] } },
    dates_source: { type: "string" },
    classes: { type: "array", items: CLASS },
    tba: { type: "array", items: { type: "string" } },
  },
  required: ["name", "start", "end", "no_class", "day_swaps", "dates_source", "classes", "tba"],
};
export const TIMETABLE_SCHEMA = { type: "object", properties: { terms: { type: "array", items: TERM } }, required: ["terms"] };

const EXAM_PROMPT = `You are reading screenshots of a university student's FINAL EXAM schedule. Today is {today}.

List every exam shown:
 course: subject + number with a space, e.g. "COMP 2406"
 title: what it is, e.g. "Final exam" (or "Deferred exam", "Take-home exam" if the screenshot says so)
 date: YYYY-MM-DD (resolve the year from the screenshot; exams are on or after today)
 start, end: 24-hour HH:MM; if only a start and a duration are shown, compute the end; "" if not shown
 room: as shown (e.g. "FH 1A", "Online"), "" if none
Skip courses with no exam scheduled. Read each row on its own; don't guess values that aren't there.
Return {"exams": [...]}.`;
const EXAM = {
  type: "object",
  properties: { course: { type: "string" }, title: { type: "string" }, date: { type: "string" }, start: { type: "string" }, end: { type: "string" }, room: { type: "string" } },
  required: ["course", "title", "date", "start", "end", "room"],
};
export const EXAMS_SCHEMA = { type: "object", properties: { exams: { type: "array", items: EXAM } }, required: ["exams"] };

// "COMP 3804", "comp-3804", "MATH 1A", "CS 101": schools differ, so letters + a number (+ a letter)
const COURSE = /^\s*([A-Za-z]{2,5})\s*-?\s*(\d{2,4}[A-Za-z]?)\b/;
export function course(s: unknown): string | null {
  const m = COURSE.exec(String(s ?? ""));
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

function iso(s: unknown): string {
  const v = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`bad date ${JSON.stringify(v)}`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new Error(`bad date ${JSON.stringify(v)}`);
  return v;
}

/** "9:00", "09:00", "4:30 pm", "16:30" → "HH:MM"; "" if it isn't a time. */
export function hhmm(s: unknown): string {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?\s*m\.?)?\s*$/i.exec(String(s ?? ""));
  if (!m) return "";
  let h = Number(m[1]); const mi = Number(m[2] ?? 0);
  if (m[3]) h = (h % 12) + (/^p/i.test(m[3]) ? 12 : 0);
  return h < 24 && mi < 60 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : "";
}

/** Validates one term the AI read (or the student edited) into a cfg.terms entry; drops malformed rows.
 *  Throws (with a message for the student) when the term itself is unusable. */
export function cleanTerm(raw: any): Term {
  let name = String(raw?.name || "New term").trim().slice(0, 40);
  if (/[A-Z]/.test(name) && name === name.toUpperCase()) name = name.toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());   // "FALL 2026" from a header
  const term: Term = { name, start: iso(raw?.start), end: iso(raw?.end), no_class: [], day_swaps: {}, classes: [] };
  if (term.end < term.start) throw new Error("the term ends before it starts");
  for (const r of raw?.no_class ?? []) {
    try {
      if (!Array.isArray(r) || !r.length) continue;
      const a = iso(r[0]); const b0 = iso(r[r.length - 1]); const b = b0 < a ? a : b0;
      if (b >= term.start && a <= term.end) term.no_class.push([a < term.start ? term.start : a, b > term.end ? term.end : b]);
    } catch { /* skip */ }
  }
  const swaps = Array.isArray(raw?.day_swaps) ? raw.day_swaps : Object.entries(raw?.day_swaps ?? {}).map(([date, follows]) => ({ date, follows }));
  for (const sw of swaps) {
    try {
      const code = String(sw?.follows ?? "").toUpperCase().slice(0, 2); const d = iso(sw?.date);
      if ((DAY_CODES as readonly string[]).includes(code) && term.start <= d && d <= term.end) term.day_swaps[d] = code;
    } catch { /* skip */ }
  }
  const seen = new Set<string>();
  for (const c of raw?.classes ?? []) {
    const code = course(c?.course);
    if (!code) continue;
    const want = new Set((Array.isArray(c?.days) ? c.days : String(c?.days ?? "").split(/[\s,]+/)).map((x: unknown) => String(x).toUpperCase().slice(0, 2)));
    const days = DAY_CODES.filter((d) => want.has(d));
    const start = hhmm(c?.start), end = hhmm(c?.end);
    if (!days.length || !start || !end || end <= start) continue;
    const cls: Class = {
      course: code, section: String(c?.section ?? "").trim().toUpperCase(),
      kind: String(c?.kind || "Class").trim().replace(/\b\w/g, (x) => x.toUpperCase()).replace(/\B\w+/g, (x) => x.toLowerCase()) || "Class",
      days, start, end, room: String(c?.room ?? "").trim(), crn: String(c?.crn ?? "").replace(/\D/g, ""),
    };
    const key = [cls.course, cls.section, days.join(""), start].join("|");
    if (!seen.has(key)) { seen.add(key); term.classes.push(cls); }
  }
  term.dates_source = /academic/i.test(String(raw?.dates_source ?? "")) ? "academic calendar" : "estimate";
  return term;
}

/** Validated exams: a course, a real date, 24-hour times (end defaults to start + 3 h); one per course + date + start. */
export function cleanExams(raw: any): Exam[] {
  const out: Exam[] = []; const seen = new Set<string>();
  for (const e of raw?.exams ?? []) {
    const code = course(e?.course);
    let date: string;
    try { date = iso(e?.date); } catch { continue; }
    const start = hhmm(e?.start);
    if (!code || !start) continue;
    let end = hhmm(e?.end);
    if (!end || end <= start) {                                    // no end shown: three hours, within the day
      const h = Number(start.slice(0, 2)) + 3;
      end = h > 23 ? "23:59" : `${String(h).padStart(2, "0")}:${start.slice(3)}`;
    }
    const ex: Exam = { course: code, title: String(e?.title || "Final exam").trim().slice(0, 60) || "Final exam", date, start, end, room: String(e?.room ?? "").trim().slice(0, 40) };
    const key = `${ex.course}|${ex.date}|${ex.start}`;
    if (!seen.has(key)) { seen.add(key); out.push(ex); }
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/** The academic dates page as plain text, trimmed to fit next to the screenshots. */
export async function academicText(url: string, f: typeof fetch): Promise<string> {
  if (!url) return "";
  const r = await f(url, { headers: { "user-agent": "Duely" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return "";
  const html = (await r.text()).replace(/<(script|style|nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return plain(html).slice(0, 30000);
}

/** What Duely couldn't decide and the student should look at. `known`: course codes in the Brightspace feed. */
export function notes(term: Term, known: Set<string>): string[] {
  const out: string[] = [];
  const near = (a: string, b: string) => {
    const [sa, na] = a.split(" "), [sb, nb] = b.split(" ");
    if (sa !== sb || na.length !== nb.length || na === nb) return false;
    return [...na].filter((ch, i) => ch !== nb[i]).length === 1;
  };
  // the suspect is the one Brightspace doesn't know, else the one meeting on fewer days (one note per pair)
  const weight = (c: Class) => (known.has(c.course) ? 100 : 0) + c.days.length;
  for (const c of term.classes) {
    const twin = term.classes.find((o) => o !== c && o.section === c.section && o.start === c.start && o.end === c.end && o.room === c.room && near(o.course, c.course)
      && (weight(o) > weight(c) || (weight(o) === weight(c) && term.classes.indexOf(o) < term.classes.indexOf(c))));
    if (twin && !known.has(c.course)) out.push(`${c.course}${c.section ? ` ${c.section}` : ""} (${c.days.map(dayName).join(", ")}) looks like ${twin.course}${twin.section ? ` ${twin.section}` : ""}: same time and room. Check which is right.`);
  }
  return out;
}

export const dayName = (d: string) => ({ MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" } as Record<string, string>)[d] ?? d;

/** Screenshots → terms to review (one AI request). `feedItems`: what Brightspace already has (breaks, course codes). */
export async function readTimetable(ctx: AICtx, images: Image[], feedItems: Item[] = [], academicUrl = ""): Promise<TimetableRead> {
  let page = "";
  try { page = await academicText(academicUrl, ctx.fetch); } catch { /* the screenshot's own dates will do */ }
  const prompt = PROMPT.replace("{today}", strftime({ t: Date.now(), tz: ctx.tz }, "%a %Y-%m-%d")).replace("{dates_help}", page ? DATES_HELP_PAGE + page : DATES_HELP_NONE);
  const raw = await llmJSON(ctx, prompt, TIMETABLE_SCHEMA, { images, maxTokens: 6000 });
  const known = new Set(feedItems.map((i) => i.course).filter(Boolean));
  const terms: TimetableRead["terms"] = [];
  for (const t of raw?.terms ?? []) {
    let term: Term;
    try { term = cleanTerm(t); } catch { continue; }
    if (!term.classes.length) continue;
    if (!page) term.dates_source = "estimate";                       // models claim a source they weren't given
    for (const br of feedBreaks(feedItems, term)) if (!term.no_class.some(([a, b]) => a <= br[0] && br[1] <= b)) term.no_class.push(br);
    term.no_class.sort();
    const tba = [...new Set<string>((t.tba ?? []).map(course).filter((c: string | null): c is string => !!c))].filter((c) => !term.classes.some((x) => x.course === c));
    terms.push({ ...term, tba, notes: notes(term, known) });
  }
  if (!terms.length) throw new Error("No classes were found in those screenshots");
  return { terms: terms.sort((a, b) => a.start.localeCompare(b.start)) };
}

/** Screenshots → exams to review (one AI request). */
export async function readExams(ctx: AICtx, images: Image[]): Promise<Exam[]> {
  const raw = await llmJSON(ctx, EXAM_PROMPT.replace("{today}", strftime({ t: Date.now(), tz: ctx.tz }, "%a %Y-%m-%d")), EXAMS_SCHEMA, { images, maxTokens: 3000 });
  const exams = cleanExams(raw).filter((e) => e.date >= today(ctx.tz));
  if (!exams.length) throw new Error("No upcoming exams were found in those screenshots");
  return exams;
}

/** Adds or replaces (same start date) a term in cfg.terms. */
export function saveTerm(cfg: any, term: Term): any {
  const { dates_source: _, ...t } = term as any;
  const terms = (cfg.terms ?? []).filter((x: any) => x.start !== t.start);
  return { ...cfg, terms: [...terms, t].sort((a: any, b: any) => a.start.localeCompare(b.start)) };
}
export function removeTerm(cfg: any, start: string): any {
  if (start === "legacy") return { ...cfg, term: null, classes: [] };
  return { ...cfg, terms: (cfg.terms ?? []).filter((t: any) => t.start !== start) };
}
/** Adds exams; one with the same course + date + start replaces the old one. */
export function saveExams(cfg: any, exams: Exam[]): any {
  const keys = new Set(exams.map((e) => `${e.course}|${e.date}|${e.start}`));
  const kept = (cfg.exams ?? []).filter((e: any) => !keys.has(`${e.course}|${e.date}|${e.start}`));
  return { ...cfg, exams: [...kept, ...exams].sort((a: any, b: any) => (a.date + a.start).localeCompare(b.date + b.start)) };
}
export function removeExam(cfg: any, key: string): any {
  return { ...cfg, exams: (cfg.exams ?? []).filter((e: any) => `${e.course}|${e.date}|${e.start}` !== key) };
}
