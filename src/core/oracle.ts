// (moved from test/oracle.ts 2026-10-09 so the daily self-test can use it; still imports only kinds.ts)
// The oracle: schedule questions with answers computed by code, for any calendar (the sample
// fixture or the real snapshot) at any moment. It is a SEPARATE reference implementation: its own
// windows, its own occurrence expansion, only `category()` from kinds.ts (the data-level truth).
// It must not import ask.ts's filter, or a shared bug would grade itself correct.
//
// Meaning of the questions (what a person means, written down once):
//   due …            things to hand in (role deadline), not tests, not Duely's study blocks
//   tests / quizzes  items of that kind, whether hand-ins or sittings
//   lectures …       timetable classes titled Lecture or Brightspace "(LEC)" events; "tutorial classes" likewise
//   what's on …      everything that day except study blocks
//   this week        Mon–Sun containing today; on Sat/Sun: today..next Sunday
//   next week        the Mon–Sun after "this week"
//   a weekday        its next date, today if today
// Hidden: items marked done, occurrences more than an hour past (like Slack's list); "next" = after now.
import { category } from "./kinds.ts";

export type Row = { uid: string; day: string };
export type OracleCase = {
  id: string;            // stable: template + fixture + moment, for baselines
  q: string;
  now: number;
  kind: "list" | "next" | "count";
  window: [string, string];
  expected: Row[];
  /** for `next`: rows tied for first (any one of them is right) */
  tied?: Row[];
};

const TZ = "America/Toronto";

// ------------------------------------------------------------------ own time helpers

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "YYYY-MM-DD HH:MM" local wall clock. */
function local(t: number): string {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const dayOf = (t: number) => local(t).slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dow = (d: string) => (new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7;   // Mon = 0
/** Epoch ms of a local wall-clock time (search ±3 h around the naive UTC guess; fine for Toronto). */
function epoch(day: string, hhmm: string): number {
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  for (let h = 0; h <= 6; h++) for (const s of [1, -1]) {
    const t = guess + s * h * 3600e3;
    if (local(t) === `${day} ${hhmm}`) return t;
  }
  return guess;
}

// ------------------------------------------------------------------ occurrences

type Occ = { it: any; day: string; t: number };

function expand(items: any[]): Occ[] {
  const out: Occ[] = [];
  for (const it of items) {
    if (it.keep === false) continue;
    const s = String(it.start ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const day = it.role === "deadline" && it.end ? String(it.end) : s;
      out.push({ it, day, t: epoch(day, "23:59") });
      continue;
    }
    const st = Date.parse(s);
    if (Number.isNaN(st)) continue;
    const hhmm = local(st).slice(11);
    if (it.meetings?.length) {
      for (const day of it.meetings) out.push({ it, day, t: epoch(day, hhmm) });
    } else if (it.rrule) {
      const m = /BYDAY=([A-Z,]+)/.exec(it.rrule), u = /UNTIL=(\d{8})/.exec(it.rrule);
      const days = (m?.[1] ?? "").split(",").map((d) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(d));
      const until = u ? `${u[1].slice(0, 4)}-${u[1].slice(4, 6)}-${u[1].slice(6)}` : plusDays(dayOf(st), 200);
      for (let d = dayOf(st); d <= until; d = plusDays(d, 1)) if (days.includes(dow(d))) out.push({ it, day: d, t: epoch(d, hhmm) });
    } else {
      const t = it.role === "deadline" && it.end ? Date.parse(it.end) : st;
      out.push({ it, day: dayOf(t), t });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const isStudy = (it: any) => it.source === "study" || it.type === "study";
const visible = (o: Occ, now: number) => !o.it.done && o.t >= now - 3600e3;

// ------------------------------------------------------------------ windows

function windows(now: number) {
  const d = dayOf(now), wd = dow(d), mon = plusDays(d, -wd);
  const weekEnd = wd >= 5 ? plusDays(mon, 13) : plusDays(mon, 6);
  return {
    today: [d, d] as [string, string],
    tomorrow: [plusDays(d, 1), plusDays(d, 1)] as [string, string],
    "this week": [d, weekEnd] as [string, string],
    "next week": [plusDays(weekEnd, 1), plusDays(weekEnd, 7)] as [string, string],
    "in the next 2 weeks": [d, plusDays(d, 14)] as [string, string],
    // the whole of next month
    "next month": [`${new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1)).toISOString().slice(0, 10)}`, plusDays(`${new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) + 1, 1)).toISOString().slice(0, 10)}`, -1)] as [string, string],
    // today .. the last day of next month
    "this month and next month": [d, plusDays(`${new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) + 1, 1)).toISOString().slice(0, 10)}`, -1)] as [string, string],
  };
}
const DAYNAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function weekdayWindow(now: number, target: number): [string, string] {
  const d = dayOf(now);
  const day = plusDays(d, (target - dow(d) + 7) % 7);
  return [day, day];
}

// ------------------------------------------------------------------ templates

type Pred = (it: any) => boolean;
type Template = { name: string; q: (w: string) => string; kind: OracleCase["kind"]; pred: Pred; windows: string[] | "next" };

const due: Pred = (it) => it.role === "deadline" && !isStudy(it);
const cat = (c: string): Pred => (it) => !isStudy(it) && category(it) === c;
const classTitled = (word: RegExp): Pred => (it) => category(it) === "class" && word.test(String(it.title));
const anything: Pred = (it) => !isStudy(it);
const and = (a: Pred, b: Pred): Pred => (it) => a(it) && b(it);

const TIMES = ["today", "tomorrow", "this week", "next week", "in the next 2 weeks"];

function templates(courses: { code: string; num: string }[]): Template[] {
  const t: Template[] = [
    { name: "due", q: (w) => `what's due ${w}`, kind: "list", pred: due, windows: TIMES },
    { name: "assignments-due", q: (w) => `assignments due ${w}`, kind: "list", pred: and(due, cat("assignment")), windows: ["this week", "next week", "in the next 2 weeks"] },
    { name: "count-assignments", q: (w) => `how many assignments do i have due ${w}`, kind: "count", pred: and(due, cat("assignment")), windows: ["this week", "in the next 2 weeks"] },
    { name: "quizzes", q: (w) => `quizzes ${w}`, kind: "list", pred: cat("quiz"), windows: ["this week", "next week"] },
    { name: "tests", q: (w) => `any tests ${w}`, kind: "list", pred: cat("test"), windows: ["this week", "next week", "in the next 2 weeks"] },
    { name: "lectures", q: (w) => `what lectures do i have ${w}`, kind: "list", pred: classTitled(/\blecture\b|\(LEC\)/i), windows: ["today", "tomorrow", "this week"] },
    { name: "tutorial-classes", q: (w) => `when are my tutorial classes ${w}`, kind: "list", pred: classTitled(/\btutorial\b|\(TUT\)/i), windows: ["tomorrow", "this week"] },
    { name: "classes", q: (w) => `what classes do i have ${w}`, kind: "list", pred: cat("class"), windows: ["today", "tomorrow"] },
    { name: "on", q: (w) => `what do i have ${w}`, kind: "list", pred: anything, windows: ["today", "tomorrow"] },
    { name: "study", q: (w) => `my study blocks ${w}`, kind: "list", pred: (it) => isStudy(it), windows: ["this week"] },
    { name: "due-weekday", q: (w) => `what's due ${w}`, kind: "list", pred: due, windows: ["friday", "monday"] },
    { name: "next-test", q: () => "when is my next test", kind: "next", pred: cat("test"), windows: "next" },
    { name: "next-quiz", q: () => "what's my next quiz", kind: "next", pred: cat("quiz"), windows: "next" },
    { name: "next-assignment", q: () => "what's the next assignment due", kind: "next", pred: and(due, cat("assignment")), windows: "next" },
  ];
  for (const c of courses) {
    t.push({ name: `due-${c.num}`, q: (w) => `what's due for ${c.code} ${w}`, kind: "list", pred: (it) => due(it) && it.course === c.code, windows: ["in the next 2 weeks"] });
    t.push({ name: `next-${c.num}`, q: () => `what's next for ${c.num}`, kind: "next", pred: (it) => due(it) && it.course === c.code, windows: "next" });
  }
  return t;
}

/** Courses that have hand-ins, with their numbers ("2406") as students write them. */
function coursesWithWork(items: any[]): { code: string; num: string }[] {
  const codes = [...new Set(items.filter((i) => i.role === "deadline" && i.course).map((i) => String(i.course)))].sort();
  return codes.map((code) => ({ code, num: code.split(" ")[1] ?? code }));
}

const rowsOf = (occ: Occ[]): Row[] => occ.map((o) => ({ uid: String(o.it.uid), day: o.day }));

/** Every case for one calendar at the given moments. */
export function oracleCases(items: any[], moments: number[], label: string): OracleCase[] {
  const all = expand(items);
  const out: OracleCase[] = [];
  for (const now of moments) {
    const W: Record<string, [string, string]> = windows(now) as any;
    const stamp = local(now).replace(" ", "T");
    for (const tp of templates(coursesWithWork(items))) {
      if (tp.windows === "next") {
        const horizon = plusDays(dayOf(now), 180);
        const hits = all.filter((o) => visible(o, now) && o.t > now && o.day <= horizon && tp.pred(o.it));
        const tied = hits.filter((o) => o.t === hits[0]?.t);
        out.push({ id: `${tp.name}|${label}|${stamp}`, q: tp.q(""), now, kind: "next", window: [dayOf(now), horizon], expected: rowsOf(tied.slice(0, 1)), tied: rowsOf(tied) });
        continue;
      }
      for (const w of tp.windows) {
        const di = DAYNAMES.indexOf(w);
        const win = di >= 0 ? weekdayWindow(now, di) : W[w];
        const hits = all.filter((o) => visible(o, now) && o.day >= win[0] && o.day <= win[1] && tp.pred(o.it));
        out.push({ id: `${tp.name}:${w}|${label}|${stamp}`, q: tp.q(w), now, kind: tp.kind, window: win, expected: rowsOf(hits) });
      }
    }
  }
  return out;
}

/** 00:30, 12:00 and 23:30 on each of the 7 days starting at `firstDay` (local). */
export function weekMoments(firstDay: string, times = ["00:30", "12:00", "23:30"]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 7; i++) for (const hm of times) out.push(epoch(plusDays(firstDay, i), hm));
  return out;
}
export const localDay = dayOf;

// ------------------------------------------------------------------ grading

export type Graded = { ok: boolean; why: string[] };
const key = (r: Row) => `${r.uid}@${r.day}`;

/** `rows` = what the reply listed (from the `onList` hook); null if it listed nothing structured. */
export function grade(c: OracleCase, reply: string, rows: Row[] | null, items: any[]): Graded {
  const why: string[] = [];
  const byUid = new Map(items.map((i) => [String(i.uid), i]));
  const name = (r: Row) => `${byUid.get(r.uid)?.course ?? ""} ${byUid.get(r.uid)?.title ?? r.uid} ${r.day}`.trim();
  if (rows === null) {
    // prose answer: every expected title must be there, by course and title
    for (const r of c.expected) {
      const it = byUid.get(r.uid);
      if (it && !reply.includes(String(it.title))) why.push(`missing ${name(r)}`);
    }
    if (!c.expected.length && !/\b(no|nothing|none|free|clear)\b/i.test(reply)) why.push("expected nothing, reply doesn't say so");
    return { ok: !why.length, why: why.length ? ["(no list) " + why[0], ...why.slice(1)] : [] };
  }
  if (c.kind === "next") {
    const tied = new Set((c.tied ?? []).map(key));
    if (!c.expected.length) { if (rows.some((r) => r.day <= c.window[1])) why.push(`expected none, got ${rows.map(name).join(", ")}`); }
    else if (!rows.length) why.push(`missing ${name(c.expected[0])}`);
    else if (!tied.has(key(rows[0]))) why.push(`first is ${name(rows[0])}, wanted ${name(c.expected[0])}`);
    return { ok: !why.length, why };
  }
  // "No tests next week. Closest thing: quizzes: …" is a right answer to an empty question
  if (!c.expected.length && /^\W*no\b/i.test(reply)) return { ok: true, why: [] };
  const want = new Set(c.expected.map(key));
  const inWin = rows.filter((r) => r.day >= c.window[0] && r.day <= c.window[1]);
  const got = new Set(inWin.map(key));
  for (const r of c.expected) if (!got.has(key(r))) why.push(`missing ${name(r)}`);
  for (const r of inWin) if (!want.has(key(r))) why.push(`extra ${name(r)}`);
  // rows outside the window are only fine as a clearly-labelled widening of an empty answer
  if (rows.length > inWin.length && c.expected.length) why.push(`${rows.length - inWin.length} row(s) outside ${c.window.join("..")}`);
  if (c.kind === "count") {
    const head = reply.split("\n")[0] ?? "";
    const m = /\b(\d+)\b/.exec(head);
    const n = /^\W*no\b/i.test(head) ? 0 : m ? Number(m[1]) : NaN;
    if (n !== c.expected.length) why.push(`count ${m?.[1] ?? "?"}, wanted ${c.expected.length}`);
  }
  return { ok: !why.length, why };
}

// ------------------------------------------------------------------ single cases (regression set)

export const preds = { due, cat, classTitled, anything, and, isStudy };

/** One case: question `q` at `now`, answer = items matching `pred` in the named window
 *  ("today", "tomorrow", "this week", "next week", "in the next 2 weeks", a weekday) or "next". */
export function oneCase(items: any[], now: number, label: string, id: string, q: string,
  kind: OracleCase["kind"], when: string, pred: Pred): OracleCase {
  const all = expand(items).filter((o) => visible(o, now) && pred(o.it));
  const stamp = local(now).replace(" ", "T");
  if (when === "next") {
    const horizon = plusDays(dayOf(now), 180);
    const hits = all.filter((o) => o.t > now && o.day <= horizon);
    const tied = hits.filter((o) => o.t === hits[0]?.t);
    return { id: `${id}|${label}|${stamp}`, q, now, kind, window: [dayOf(now), horizon], expected: rowsOf(tied.slice(0, 1)), tied: rowsOf(tied) };
  }
  const di = DAYNAMES.indexOf(when);
  const win = di >= 0 ? weekdayWindow(now, di) : (windows(now) as any)[when] as [string, string];
  return { id: `${id}|${label}|${stamp}`, q, now, kind, window: win, expected: rowsOf(all.filter((o) => o.day >= win[0] && o.day <= win[1])) };
}

/** The first local `weekday` (Mon = 0) after `t`'s day, at hh:mm. */
export function nextWeekdayAt(t: number, weekday: number, hhmm: string): number {
  let d = plusDays(dayOf(t), 1);
  while (dow(d) !== weekday) d = plusDays(d, 1);
  return epoch(d, hhmm);
}
