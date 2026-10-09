// Chat with the Slack bot about what's coming up.
//
// A message is cleaned up first (slang, typos, course nicknames: normalize.ts), then becomes a
// *filter* (an Intent: dates, courses, categories, how many), and code lists the matching calendar
// items, so an AI can never invent or drop an assignment. The filter comes from Workers AI (Llama
// 3.3 70B), else Mistral, else the built-in rules, and sees the last few messages so
// follow-ups work. An empty result is broadened before saying "nothing". Questions that need
// reasoning get a second AI call that sees only the selected items, and its answer is checked by
// code (guard.ts) before it's sent.
import { nextOccurrence } from "./ical.ts";
import { type DT, addDays, localDate, strftime, strftimeDate, weekday } from "./time.ts";
import type { Store } from "./util.ts";
import { CATEGORIES, category, isWork } from "./kinds.ts";
import { fetchRss, parseRss } from "./announcements.ts";
import { type Done, loadDone, resolveTarget } from "./done.ts";
import { type Action, decide, pendingAction, propose, record, undoLast } from "./actions.ts";
import { courseAliases, coursesOf, normalize } from "./normalize.ts";
import { type GuardItem, datesIn, guard } from "./guard.ts";
import type { LLM } from "../llm/types.ts";
import { agentReply } from "./agent.ts";


// ---------------------------------------------------------------- the filter

const MODES = ["list", "next", "count", "free_text", "help", "done", "undone", "finished", "announcements"] as const;

export type Intent = {
  mode: (typeof MODES)[number];
  from: string; to: string;          // local dates, inclusive
  courses: string[];                 // ["STAT 2507"]; [] = every course
  categories: string[];              // CATEGORIES; [] = anything
  due_only: boolean;                 // only things to hand in
  include_classes: boolean;          // weekly lectures/tutorials/labs
  limit: number | null;              // "next 3 assignments" -> 3
  target?: string;                   // done/undone: which item ("comp 2406 a1", "2")
  topic?: string;                    // announcements: what about ("midterm")
  defaulted?: boolean;               // the window was our default, not something they said
  broadened?: boolean;               // already widened once after finding nothing
};

const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "from", "to", "courses", "categories", "due_only", "include_classes", "limit", "target", "topic"],
  properties: {
    mode: { type: "string", enum: [...MODES] },
    from: { type: "string", description: "YYYY-MM-DD" },
    to: { type: "string", description: "YYYY-MM-DD" },
    courses: { type: "array", items: { type: "string" } },
    categories: { type: "array", items: { type: "string", enum: [...CATEGORIES] } },
    due_only: { type: "boolean" },
    include_classes: { type: "boolean" },
    limit: { type: ["integer", "null"] },
    target: { type: "string", description: "done/undone: the item, else empty" },
    topic: { type: "string", description: "announcements: the subject, else empty" },
  },
};

export type Occ = { t: number; allDay: boolean; day: string; it: any };

// ---------------------------------------------------------------- occurrences

/** Milliseconds to add so a time moved by whole days keeps its wall-clock time across a DST change. */
function dstShift(from: number, to: number, tz: string): number {
  const off = (t: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(t))
      .find((x) => x.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(p);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60e3 : 0;
  };
  return off(from) - off(to);
}

const parseWhen = (s: string | null | undefined, tz: string): DT | null =>
  !s ? null : /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : { t: Date.parse(s), tz };

/** Every occurrence of the saved (serialised) items between two local dates. */
export function occurrences(items: any[], from: string, to: string, tz: string, now = Date.now()): Occ[] {
  const out: Occ[] = [];
  for (const it of items) {
    if (it.keep === false) continue;
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(it.start ?? ""));
    const push = (t: number, day: string) => { if (day >= from && day <= to && t >= now - 3600e3) out.push({ t, allDay, day, it }); };
    if (allDay) {
      const day = it.role === "deadline" && it.end ? String(it.end) : String(it.start);
      if (day >= from && day <= to && day >= localDate({ t: now, tz }, tz)) out.push({ t: Date.parse(day + "T00:00:00Z"), allDay, day, it });
      continue;
    }
    const start = parseWhen(it.start, tz);
    if (!start) continue;
    if (it.meetings?.length) {
      // the first meeting's wall-clock time, on each meeting day
      const first = localDate(start, tz);
      for (const day of it.meetings as string[]) {
        if (day < from || day > to) continue;
        const shift = Date.parse(day + "T00:00:00Z") - Date.parse(first + "T00:00:00Z");
        const t = start.t + shift;
        push(t + dstShift(start.t, t, tz), day);
      }
    } else if (it.rrule) {
      let after = Math.max(now - 3600e3, Date.parse(from + "T00:00:00Z") - 86400e3);
      for (let i = 0; i < 60; i++) {
        const n = nextOccurrence(start, it.rrule, after, tz);
        if (!n) break;
        const day = localDate(n, tz);
        if (day > to) break;
        push(n.t, day);
        after = n.t + 60e3;
      }
    } else {
      const w = it.role === "deadline" ? parseWhen(it.end, tz) ?? start : start;
      push(w.t, localDate(w, tz));
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function matches(o: Occ, q: Intent): boolean {
  const it = o.it;
  if (q.mode === "finished" ? !it.done : it.done) return false;
  if ((it.source === "study" || it.type === "study") && !q.categories.includes("study")) return false;   // only when asked for
  if (q.courses.length && !q.courses.includes(it.course)) return false;
  const cat = category(it);
  const cats = q.categories;
  if (cat === "class" && !(q.include_classes || cats.includes("class"))) return false;
  if (cats.length && !cats.includes(cat)) return false;
  if (q.due_only && it.role !== "deadline" && !(cat === "test" && cats.includes("test"))) return false;   // "tests due" = tests, though not handed in
  return true;
}

// ---------------------------------------------------------------- the reply

const NOUN: Record<string, [string, string]> = {
  assignment: ["assignment", "assignments"], tutorial: ["tutorial", "tutorials"], lab: ["lab", "labs"],
  module: ["module", "modules"], quiz: ["quiz", "quizzes"], test: ["test", "tests"], other: ["deliverable", "deliverables"],
  event: ["event", "events"], class: ["class", "classes"], study: ["study block", "study blocks"],
};

function noun(q: Intent, n: number): string {
  const one = n === 1;
  const cats = q.categories.filter((c) => NOUN[c]);
  let w = cats.length ? cats.map((c) => NOUN[c][one ? 0 : 1]).join(" or ")
    : q.due_only ? (one ? "deadline" : "deadlines") : (one ? "thing" : "things");
  if (q.courses.length) w = `${q.courses.join(" / ")} ${w}`;
  return w;
}

/** "today", "tomorrow", "this week", "next week", "in the next 2 weeks", "on Fri Oct 9", "Oct 5 – Oct 18". */
export function describeRange(from: string, to: string, tz: string, now = Date.now()): string {
  const t = localDate({ t: now, tz }, tz);
  const mon = addDays(t, -weekday(t));
  if (from === to) return from === t ? "today" : from === addDays(t, 1) ? "tomorrow" : "on " + strftimeDate(from, "%a %b %-d");
  const wk = weekday(t) >= 5 ? 7 : 0;                         // Sat/Sun: "this week" is the coming one
  if (from <= addDays(mon, wk) && to === addDays(mon, wk + 6)) return "this week";
  if (from === addDays(mon, wk + 7) && to === addDays(mon, wk + 13)) return "next week";
  const monthEnd = addDays(to.slice(0, 8) + "01", 32).slice(0, 8) + "01";
  if (from.slice(0, 7) === to.slice(0, 7) && (from.endsWith("-01") || from === t) && addDays(monthEnd, -1) === to) {
    return "in " + ["January", "February", "March", "April", "May", "June", "July", "August", "September",
      "October", "November", "December"][Number(to.slice(5, 7)) - 1];
  }
  if (from <= t) {
    const days = Math.round((Date.parse(to) - Date.parse(t)) / 864e5);
    if (days >= 100) return "for the rest of the term";
    if (days % 7 === 0 && days >= 7) return days === 7 ? "in the next week" : `in the next ${days / 7} weeks`;
    return `in the next ${days} days`;
  }
  return `${strftimeDate(from, "%b %-d")} – ${strftimeDate(to, "%b %-d")}`;
}

/** One item. Work items get a number ("2.") so "done 2" can refer to them. */
export function line(o: Occ, tz: string, n?: number): string {
  const it = o.it;
  const when = o.allDay ? "all day" : strftime({ t: o.t, tz }, "%-I:%M %p");
  const what = `${it.course ? it.course + ": " : ""}${it.title}`;
  const tag = it.role === "deadline" ? " (due)" : it.role === "opens" ? " (opens)" : "";
  const where = category(it) === "class" && it.location && !/zoom|online/i.test(it.location) ? ` · ${it.location}` : "";
  return `${n ? n + "." : "•"} ${when}  ${what}${tag}${where}${it.announced ? " _(from announcement)_" : ""}${it.done ? " ✓" : ""}`;
}

export function dayHeader(day: string, tz: string, now: number): string {
  const t = localDate({ t: now, tz }, tz);
  const name = strftimeDate(day, "%a %b %-d");
  return day === t ? `*Today, ${name}*` : day === addDays(t, 1) ? `*Tomorrow, ${name}*` : `*${name}*`;
}

/** Turn a filter into the reply: a count line, then the items grouped by day. */
export function execute(q: Intent, items: any[], tz: string, now = Date.now()): string {
  return executeRefs(q, items, tz, now).text;
}

/** execute() plus the uids behind the numbered lines, for "done 2". */
function executeRefs(q: Intent, items: any[], tz: string, now = Date.now(),
  picked?: { occ: Occ[]; phrase: string }): { text: string; refs: string[]; found: number; rows: Occ[] } {
  let occ = picked ? picked.occ : occurrences(items, q.from, q.to, tz, now).filter((o) => matches(o, q));
  const range = describeRange(q.from, q.to, tz, now);
  const due = q.categories.some((c) => !["test", "event", "class", "study"].includes(c)) ? " due" : "";   // "deadlines" says it already
  const laterNote = () => {
    if (!q.defaulted || q.mode === "next") return "";
    const later = occurrences(items, addDays(q.to, 1), addDays(q.to, 120), tz, now).filter((o) => matches(o, q));
    if (!later.length) return "";
    const first = later[0];
    return `\n_${later.length} more later this term (next: ${first.it.course ? first.it.course + " " : ""}${first.it.title}, `
      + `${strftimeDate(first.day, "%a %b %-d")}). Ask "${noun(q, 2)} for the rest of the term" to see them._`;
  };
  if (!occ.length && !q.broadened && !picked && ["list", "count", "next"].includes(q.mode)) {
    // nothing: try a wider reading before saying so (and say what was widened)
    for (const [wider, why] of broaden(q, now, tz)) {
      const r = executeRefs({ ...wider, broadened: true, limit: wider.limit ?? 5 }, items, tz, now);
      if (r.found) return { text: `No ${noun(q, 2)}${due} ${range}. ${why}:\n\n${r.text}`, refs: r.refs, found: 0, rows: r.rows };
    }
  }
  if (!occ.length) {
    const text = picked ? `No ${picked.phrase}. 🎉`
      : q.mode === "finished" ? "Nothing marked done yet. Tell me *done …* when you finish something."
      : q.mode === "next" ? `No upcoming ${noun(q, 2)} found. 🎉` : `No ${noun(q, 2)}${due} ${range}. 🎉${laterNote()}`;
    const note = doneNote(q, items, tz, now);
    return { text: note.length ? `${text}\n${note.join("\n")}` : text, refs: [], found: 0, rows: [] };
  }
  const total = occ.length;
  if (q.mode === "next") occ = occ.slice(0, Math.max(1, q.limit ?? 1));
  else if (q.limit) occ = occ.slice(0, q.limit);
  const shown = occ.slice(0, 25);
  const head = picked
    ? (q.mode === "count" ? `*You have ${total} ${picked.phrase}.*` : q.mode === "next" ? "*Next up:*" : `*${total} ${picked.phrase}*`)
    : q.mode === "finished" ? `*${total} thing${total === 1 ? "" : "s"} you've marked done*` : q.mode === "next"
    ? `*Next ${shown.length > 1 ? shown.length + " " : ""}${noun(q, shown.length)}${due}:*`
    : q.mode === "count"
      ? `*You have ${total} ${noun(q, total)}${due} ${range}.*`
      : `*${total} ${noun(q, total)}${due} ${range}*`;
  const out: string[] = [head];
  const refs: string[] = [];
  let last = "";
  for (const o of shown) {
    if (o.day !== last) { out.push("\n" + dayHeader(o.day, tz, now)); last = o.day; }
    const numbered = o.it.role === "deadline" && o.it.source !== "study" && !refs.includes(o.it.uid);   // hand-ins only: a test isn't "done"
    if (numbered) refs.push(o.it.uid);
    out.push(line(o, tz, numbered ? refs.length : undefined));
  }
  if (occ.length > shown.length) out.push(`\n…and ${occ.length - shown.length} more. Ask about a shorter time or one course.`);
  const note = picked ? "" : laterNote();
  if (note) out.push(note);
  if (refs.length && q.mode !== "finished") out.push(`\n_Finished one? Reply *done ${refs.length > 1 ? "2" : "1"}* (its number)._`);
  out.push(...doneNote(q, items, tz, now));
  return { text: out.join("\n"), refs, found: total, rows: shown };
}

/** "1 you marked done is hidden (PHYS 1905 Quiz - Sports Module)", so a done item never looks lost. */
function doneNote(q: Intent, items: any[], tz: string, now: number): string[] {
  if (q.mode === "finished") return [];
  const hidden = occurrences(items, q.from, q.to, tz, now).filter((o) => o.it.done && matches(o, { ...q, mode: "finished" }));
  if (!hidden.length) return [];
  const names = hidden.slice(0, 3).map((o) => `${o.it.course ? o.it.course + " " : ""}${o.it.title}`).join(", ");
  return [`_${hidden.length} you marked done ${hidden.length === 1 ? "is" : "are"} hidden (${names}). Say *undo* and its name to bring it back._`];
}

/** Wider readings of a filter that found nothing, mildest first. */
function broaden(q: Intent, now: number, tz: string): [Intent, string][] {
  const out: [Intent, string][] = [];
  const t = localDate({ t: now, tz }, tz);
  const term = addDays(t, 120);
  if (q.mode !== "next" && q.to < term) out.push([{ ...q, mode: "list", to: term, defaulted: false }, "The next ones after that"]);
  if (q.categories.includes("test") && !q.categories.includes("quiz")) {
    out.push([{ ...q, mode: "list", categories: [...q.categories, "quiz"], to: term, defaulted: false }, "Closest thing: quizzes"]);
  }
  const WORK = ["assignment", "tutorial", "lab", "module", "quiz", "other"];
  if (q.courses.length && q.categories.length && q.categories.every((c) => WORK.includes(c))) {
    out.push([{ ...q, mode: "list", categories: [], due_only: true }, "Here's everything due for that course instead"]);
  }
  if (q.due_only && q.categories.length === 0 && q.courses.length) {
    out.push([{ ...q, mode: "list", due_only: false, to: term, defaulted: false }, "Here's what's coming up for that course instead"]);
  }
  return out;
}

const HELP = "Ask me anything about what's coming up, like: *assignments due in the next two weeks* · "
  + "*next test* · *what's due friday* · *STAT 2507* · *classes tomorrow* · *how busy is next week?* "
  + "*what did the prof say about the midterm?* Mark work finished with *done 2* or *done comp 2406 a1*. "
  + "Type *clear* (or /clear) to delete my messages here.";

// ---------------------------------------------------------------- built-in rules (fallback)

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_RE = /\b(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/i;
const COURSE = /\b([A-Za-z]{4})\s?-?\s?(\d{4})\b/;
const NUM: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, "a couple": 2, "a couple of": 2, few: 3, "a few": 3,
};
const N = String.raw`(\d{1,3}|one|an?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a )?couple(?: of)?|(?:a )?few)`;
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s.trim()] ?? NUM[s.replace(/^a /, "").trim()] ?? 1);
const CAT_WORDS: [RegExp, string][] = [
  [/\b(assignments?|a\d+)\b/i, "assignment"],
  [/\btutorials?\b/i, "tutorial"],
  [/\blabs?\b|\blab reports?\b/i, "lab"],
  [/\bmodules?\b/i, "module"],
  [/\bquiz(?:zes)?\b/i, "quiz"],
  [/\b(tests?|exams?|midterms?|finals?)\b/i, "test"],
  [/\b(class(?:es)?|lectures?|schedule)\b/i, "class"],
  [/\bstudy(ing)? (blocks?|sessions?|time|plan)\b|\bwhen (should|do|can) i study\b/i, "study"],
];
const GENERIC = /\b(upcoming|coming up|due|deadlines?|next|soon|left|busy|free|what'?s on|anything|plans?|homework|hw|work|deliverables?|submit|submissions?)\b/i;

/** Understand a question with rules, or null if it needs an AI. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseQuery(text: string, tz: string, now = Date.now()): Intent | null {
  const q = text.toLowerCase().replace(/[’']/g, "'");
  const d = localDate({ t: now, tz }, tz);
  const base = { from: d, to: d, courses: [] as string[], categories: [] as string[], due_only: false, include_classes: false, limit: null };
  if (/^\s*(thanks?|thank you|thx|ty|cheers|ok(ay)?|cool|great|nice|hi|hello|hey|yo)\b[\s!.]*$/.test(q)) return { mode: "help", ...base };
  if (/^\s*(what can you do|what do you do|how do (i|you) use (you|this)|help me|commands|what (can|should) i ask( you)?)\b[\s?!.]*$/.test(q)) return { mode: "help", ...base };
  let dm: RegExpExecArray | null;
  if ((dm = /^\s*(?:undo|undone|unmark|not done(?: with)?|mark (.+?) (?:as )?not done)\b\s*(.*)$/.exec(q))) {
    return { mode: "undone", ...base, target: (dm[1] || dm[2] || "").trim() };
  }
  if (/^\s*(what('?s| have| did) i (finish(ed)?|done|complete(d)?|submit(ted)?|hand(ed)? in)|(show |list )?(done|finished|completed) (items|list|stuff|things)|what('?s)? done)\b/.test(q)) {
    return { mode: "finished", ...base, from: addDays(d, -30), to: addDays(d, 60) };
  }
  if ((dm = /^\s*(?:i\s+)?(?:done|finished|submitted|completed|handed in)\b(?:\s+with)?\s*(.*)$/.exec(q))
    || (dm = /^\s*mark\s+(.+?)\s+(?:as\s+)?(?:done|finished|complete)\s*$/.exec(q))) {
    return { mode: "done", ...base, target: dm[1].trim() };
  }
  if (/\b(announce(ment|ments|d)?|news|posted|prof(essor)?|instructor|ta)\b.*\b(say|said|post|posted|about|announce|mention|news)\b|\bany (news|announcements?)\b|\bannouncements?\b/.test(q)) {
    const c0 = COURSE.exec(q);
    const topic = q.replace(COURSE, " ").replace(/\b(what|did|does|do|the|my|prof(essor)?|instructor|ta|say|said|about|any|news|announce(ment|ments|d)?|posted|post|mention(ed)?|in|for|on|this|last|week|recent(ly)?|latest|\?)\b/g, " ")
      .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    return { mode: "announcements", ...base, courses: c0 ? [`${c0[1].toUpperCase()} ${c0[2]}`] : [], topic };
  }
  let from = d, to: string | null = null;
  let m: RegExpExecArray | null;
  const span = new RegExp(String.raw`\b(?:next|in|within|coming|over the next)\s+(?:the\s+)?${N}\s+(days?|weeks?|months?|fortnights?)\b`);
  if ((m = span.exec(q))) {
    const n = num(m[1]), unit = m[2];
    to = addDays(d, unit.startsWith("day") ? n : unit.startsWith("week") ? 7 * n : unit.startsWith("fortnight") ? 14 * n : 30 * n);
  } else if (/\b(?:within|in) a week\b/.test(q)) to = addDays(d, 7);
  else if (/\bfortnight\b/.test(q)) to = addDays(d, 14);
  else if (/\b(today|tonight)\b/.test(q)) to = d;
  else if (/\btomorrow\b/.test(q)) from = to = addDays(d, 1);
  else if (/\bnext week\b/.test(q)) { from = addDays(d, 7 - weekday(d) + (weekday(d) >= 5 ? 7 : 0)); to = addDays(from, 6); }   // Sat/Sun: "this week" is the coming one, so "next" is the one after
  else if (/\bthis week\b|\bweek\b/.test(q)) to = addDays(d, 6 - weekday(d) + (weekday(d) >= 5 ? 7 : 0));   // Sat/Sun: the coming week
  else if (/\bweekend\b/.test(q)) { from = addDays(d, (5 - weekday(d) + 7) % 7); to = addDays(from, 1); }
  else if (/\bnext month\b/.test(q)) { from = addDays(d, 30); to = addDays(d, 60); }
  else if (/\bthis month\b|\bmonth\b/.test(q)) to = addDays(d, 30);
  else if (/\b(rest of (the )?(term|semester)|this (term|semester)|all)\b/.test(q)) to = addDays(d, 120);
  else if ((m = /\b(?:in|during|for|this|next)?\s*(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/.exec(q))
    && !/\bmay i\b/.test(q)) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3));
    let y = Number(d.slice(0, 4));
    if (mi + 1 < Number(d.slice(5, 7))) y += 1;                          // a past month means next year's
    const first = `${y}-${String(mi + 1).padStart(2, "0")}-01`;
    const last = addDays(`${mi === 11 ? y + 1 : y}-${String(mi === 11 ? 1 : mi + 2).padStart(2, "0")}-01`, -1);
    from = first < d ? d : first; to = last;
  }
  else if ((m = DAY_RE.exec(q))) {
    const want = DAYS.findIndex((n) => n.startsWith(m![1].slice(0, 3)));
    from = to = addDays(d, (want - weekday(d) + 7) % 7);
  }
  const c = COURSE.exec(q);
  const courses = c ? [`${c[1].toUpperCase()} ${c[2]}`] : [];
  const categories: string[] = [];
  for (const [re, cat] of CAT_WORDS) if (re.test(q) && !categories.includes(cat)) categories.push(cat);
  const due_only = /\b(due|deadlines?|homework|hw|deliverables?|submit|submissions?|hand in)\b/.test(q) && !categories.length;
  if (!to && !courses.length && !categories.length && !GENERIC.test(q)) return null;

  // "next test" / "next 3 assignments" = the soonest ones; "next week" / "next 2 weeks" are times
  let mode: Intent["mode"] = /\bhow many\b/.test(q) ? "count" : "list";
  let limit: number | null = null;
  const nx = new RegExp(String.raw`\bnext\s+(?:${N}\s+)?(?:[a-z]{3,4}\s?-?\s?\d{4}\s+)?(assignments?|tutorials?|labs?|modules?|quiz(?:zes)?|tests?|exams?|midterms?|finals?|deadlines?|things?|class(?:es)?|lectures?)\b`).exec(q);
  if (nx && !span.test(q)) { mode = "next"; limit = nx[1] ? num(nx[1]) : 1; }

  const single = !!to && from === to;
  let defaulted = false;
  if (!to) {
    defaulted = true;
    const testsOnly = categories.length > 0 && categories.every((x) => x === "test");
    to = addDays(d, mode === "next" ? 180 : testsOnly ? 120 : courses.length && !categories.length ? 30 : 14);
  }
  const include_classes = categories.includes("class") || (single && !categories.length && !due_only);
  return { mode, from, to, courses, categories, due_only, include_classes, limit, defaulted };
}

// ---------------------------------------------------------------- AI: question -> filter

/** "COMP 2406 (Fundamentals of Web Applications), …": codes, with names from the item locations. */
function courseList(items: any[]): string {
  return coursesOf(items).map(({ code, name }) => (name ? `${code} (${name})` : code)).join(", ") || "(none)";
}

function intentPrompt(text: string, items: any[], tz: string, now = Date.now(), turns: Turn[] = []): string {
  const t = localDate({ t: now, tz }, tz);
  const mon = addDays(t, -weekday(t));
  const dd = (n: number) => addDays(t, n);
  const nw = weekday(t) >= 5 ? 14 : 7;                      // days from Monday to "next week" (a week later on weekends)
  const ex = (q: string, o: Partial<Intent>) => `Q: ${q}\nA: ${JSON.stringify({
    mode: "list", from: t, to: dd(14), courses: [], categories: [], due_only: false, include_classes: false, limit: null,
    target: "", topic: "", ...o })}`;
  return `You turn a student's question about their university calendar into a JSON search filter. You never answer the question yourself.
Questions can be casual, vague or misspelled ("wats due", "am i cooked this week"): pick the most sensible reading, never give up.

Today is ${strftimeDate(t, "%a")} ${t} (time zone ${tz}). Weeks run Monday to Sunday: this week is ${mon}..${addDays(mon, 6)}, next week is ${addDays(mon, 7)}..${addDays(mon, 13)}.${weekday(t) >= 5 ? ` It's the weekend, so "this week" means today..${addDays(mon, 13)} and "next week" means ${addDays(mon, 14)}..${addDays(mon, 20)}.` : ""}
Their courses: ${courseList(items)}.

Categories (use only these words):
- assignment: things titled "Assignment …" or A1, A2… Only these. NOT tutorials, labs, modules, quizzes or reports.
- tutorial: tutorial submissions (graded tutorial work)
- lab: labs and lab reports
- module: online modules
- quiz: quizzes
- test: tests, midterms, exams, finals
- other: any other deliverable
- event: non-class events (review sessions, office hours, announcements' events)
- class: weekly lectures / tutorials / labs on the timetable
- study: the study blocks Duely planned in their calendar ("study block", "study sessions", "when should I study", "my study plan")

Fields:
- mode: "list" = show matching items; "next" = only the soonest (limit = how many, default 1); "count" = how many; "free_text" = anything that isn't a plain list: reasoning (which day is busiest, what to start first), advice, planning, feelings ("I'm stressed"), small talk, or any question you're unsure about; "help" = only "hi"/"hello", thanks, or "what can you do"; "done" = they finished / submitted something (target = which one, e.g. "comp 2406 a1" or a list number "2"); "undone" = undo a done mark (target as for done); "finished" = list what they marked done; "announcements" = what a professor posted / said / announced (topic = the subject, e.g. "midterm"; courses if named).
- from, to: inclusive dates YYYY-MM-DD. "next N days/weeks" = today .. today + N days/weeks (two weeks = today..${dd(14)}). "this week" = today..${weekday(t) >= 5 ? addDays(mon, 13) : addDays(mon, 6)}. A weekday = its next date (today if it's today).
  If no time is mentioned: deliverables / "what's due" / assignments etc. = today..${dd(14)}; tests or exams = today..${dd(120)}; one course with no type = today..${dd(30)}; "next X" = today..${dd(180)}; "rest of the term" / "this term" / "all" = today..${dd(120)}.
- courses: course codes mentioned, written like "COMP 2406". Map names or partial codes to their codes (e.g. "stats" -> the STAT course, "2406" -> "COMP 2406"). [] = all courses.
- categories: [] = any kind. "homework", "deliverables", "what's due", "work" = [] with due_only true.
- due_only: true when they ask what is due / to submit / deadlines.
- include_classes: true only if they ask about classes, lectures or their schedule, or ask what's on a single day.
- limit: a number for "next 3 …"; 1 for "next test"; otherwise null.

Examples:
${ex("assignments due in the next two weeks", { categories: ["assignment"], due_only: true })}
${ex("assignments due", { categories: ["assignment"], due_only: true })}
${ex("what's due this week", { to: weekday(t) >= 5 ? addDays(mon, 13) : addDays(mon, 6), due_only: true })}
${ex("next test", { mode: "next", to: dd(180), categories: ["test"], limit: 1 })}
${ex("next 3 comp 2406 assignments", { mode: "next", to: dd(180), courses: ["COMP 2406"], categories: ["assignment"], due_only: true, limit: 3 })}
${ex("what do I have on friday", { from: dd((4 - weekday(t) + 7) % 7), to: dd((4 - weekday(t) + 7) % 7), include_classes: true })}
${ex("how many quizzes this month", { mode: "count", to: dd(30), categories: ["quiz"], due_only: true })}
${ex("tutorials and labs due next week", { from: addDays(mon, nw), to: addDays(mon, nw + 6), categories: ["tutorial", "lab"], due_only: true })}
${ex("which day next week is busiest?", { mode: "free_text", from: addDays(mon, nw), to: addDays(mon, nw + 6) })}
${ex("thanks!", { mode: "help" })}
${ex("am i cooked this week lol", { mode: "free_text", to: weekday(t) >= 5 ? addDays(mon, 13) : addDays(mon, 6) })}
${ex("what should i work on tonight", { mode: "free_text", to: dd(7) })}
${ex("done with comp 2406 a1", { mode: "done", target: "comp 2406 a1" })}
${ex("finished 2", { mode: "done", target: "2" })}
${ex("oops undo tutorial 3", { mode: "undone", target: "tutorial 3" })}
${ex("what did the prof say about the midterm?", { mode: "announcements", topic: "midterm" })}
${ex("any COMP 3106 news?", { mode: "announcements", courses: ["COMP 3106"] })}
${ex("what's on the STAT 2507 test?", { mode: "announcements", courses: ["STAT 2507"], topic: "test" })}
${ex("film hw", { courses: ["FILM 1101"], due_only: true })}

${turns.length ? `\nEarlier in this chat (oldest first):\n${turns.map((x) => `Q: ${x.q}\nfilter: ${x.intent ? JSON.stringify({ ...x.intent, defaulted: undefined, broadened: undefined }) : "(none)"}`).join("\n")}
If the new question is a follow-up ("what about next week", "and for 3106?", "only assignments", "and tomorrow?", "the second one", "done that one"), start from the latest filter and change only what the new question says. "the first/second/last one", "that one", "it" after a list = done/undone target "1"/"2"/"last"/"that one".
` : ""}
Question: ${text.slice(0, 500)}
Answer with the JSON filter only.`;
}

/** Words an AI may use for a category -> ours (null = "any kind"). */
const CAT_SYN: Record<string, string | null> = {
  assignments: "assignment", homework: null, hw: null, work: null, deliverable: null, deliverables: null, deadline: null, deadlines: null,
  tutorials: "tutorial", labs: "lab", "lab report": "lab", modules: "module", quizzes: "quiz", tests: "test", midterm: "test",
  midterms: "test", exam: "test", exams: "test", final: "test", finals: "test", lecture: "class", lectures: "class", classes: "class",
  events: "event", "study block": "study", "study blocks": "study", "study session": "study", "study sessions": "study", project: "other", projects: "other", essay: "other", report: "other", reading: "other", readings: "other",
};

/** Check an AI's filter; null if it can't be trusted. `known` = the calendar's course codes. */
export function validIntent(x: any, t: string, known: string[] = []): Intent | null {
  if (x && typeof x === "object" && typeof x.mode === "string") x = { ...x, mode: x.mode.toLowerCase().replace(/[\s-]+/g, "_") };
  if (!x || typeof x !== "object") return null;
  const date = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!MODES.includes(x.mode)) return null;
  const base = { from: t, to: t, courses: [] as string[], categories: [] as string[], due_only: false, include_classes: false, limit: null };
  if (x.mode === "help") return { mode: "help", ...base };
  if (x.mode === "done" || x.mode === "undone") {
    const target = String(x.target ?? "").trim();
    return target ? { mode: x.mode, ...base, target } : null;
  }
  if (x.mode === "finished") return { mode: "finished", ...base, from: addDays(t, -30), to: addDays(t, 60) };
  let courses: string[] = Array.isArray(x.courses) ? [...new Set<string>(x.courses.map((c: any) => {
    const code = String(c).toUpperCase().replace(/^([A-Z]{3,4})\s*-?\s*(\d{4}).*$/, "$1 $2");
    if (!known.length || known.includes(code)) return code;
    const num = /\d{4}/.exec(code)?.[0];                                // "COMP 3106" written "CS 3106" -> the one with that number
    return known.find((k) => num && k.endsWith(num)) ?? known.find((k) => k.startsWith(code.slice(0, 4)) && known.filter((j) => j.startsWith(code.slice(0, 4))).length === 1) ?? code;
  }).filter(Boolean))] : [];
  if (courses.length > 1 && known.length && known.every((k) => courses.includes(k))) courses = [];   // "all of them" = any
  if (x.mode === "announcements") return { mode: "announcements", ...base, courses, topic: String(x.topic ?? "").trim() };
  // repair rather than reject: swapped dates, a window in the past, too long -> the term
  if (!date(x.from) || !date(x.to)) return null;                    // nonsense dates: the rules do better
  let from: string = x.from, to: string = x.to;
  if (from > to) [from, to] = [to, from];
  if (to < t) to = addDays(t, 14);
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 400) to = addDays(from, 120);
  x = { ...x, from, to };
  const categories: string[] = [];
  for (const c of Array.isArray(x.categories) ? x.categories : []) {
    const k = String(c).toLowerCase().trim();
    const cat = (CATEGORIES as readonly string[]).includes(k) ? k : CAT_SYN[k];
    if (cat && !categories.includes(cat)) categories.push(cat);
  }
  const limit = Number.isInteger(x.limit) && x.limit > 0 ? Math.min(x.limit, 50) : null;
  return { mode: x.mode, from: x.from < t ? t : x.from, to: x.to, courses, categories,
    due_only: !!x.due_only, include_classes: !!x.include_classes, limit };
}

/** One KV record per chat ("chat-session"), written once per message (KV: one write per key per
 *  second, 1,000 a day): today's AI usage, the numbers behind the last list, recent turns. */
type Turn = { q: string; intent: Intent | null; said: string; at: number };
export type Session = {
  date: string; requests: number; fails: number;
  lastList: string[]; turns: Turn[];
};
type Usage = Session & { dirty?: boolean; deadline?: number; engine?: string };
/** A reply is posted in the background, and Workers get ~30 s for that: all AI calls for one
 *  message share this budget, and the rules answer if it runs out. */
const MESSAGE_BUDGET_MS = 22000;
const TURN_MS = 30 * 60e3;

async function loadSession(store: Store, tz: string, now: number): Promise<Session> {
  const day = localDate({ t: now, tz }, tz);
  const s = (await store.get<Session>("chat-session")) ?? { date: day, requests: 0, fails: 0, lastList: [], turns: [] };
  const fresh = { lastList: s.lastList ?? [], turns: (s.turns ?? []).filter((t) => now - t.at < TURN_MS).slice(-3) };
  return s.date === day
    ? { ...s, requests: s.requests ?? 0, fails: s.fails ?? 0, ...fresh }
    : { date: day, requests: 0, fails: 0, ...fresh };
}

export type AI = {
  /** the student's one AI provider (src/llm); absent = rules only */
  llm?: LLM;
  /** Called on every failed message (shown or reported, once per distinct error). */
  onFailure?: (message: string) => Promise<void>;
  /** Told which calendar rows a reply listed (uid + local day), for the UI's checkboxes and tests. */
  onList?: (rows: { uid: string; day: string }[]) => void;
  /** Told about a proposal made while answering, so the reply can carry Yes / No buttons. */
  onProposal?: (a: Action) => void;
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms); })])
    .finally(() => clearTimeout(timer));
};


/** Ask the available AIs in order (Workers AI, then Mistral), counting into `u` (saved once per
 *  message: KV allows one write per key per second). Null when none could answer. */
async function askAI(prompt: string, json: boolean, cfg: any, ai: AI, u: Usage,
  _f: typeof fetch, maxTokens?: number, schema?: object): Promise<string | null> {
  // json = the filter (INTENT_SCHEMA); `schema` = another JSON answer; neither = free text
  const sch = schema ?? (json ? INTENT_SCHEMA : undefined);
  const cap = Number(cfg.chat_daily_limit ?? 300) || 0;
  const remaining = () => (u.deadline ?? Infinity) - Date.now();
  if (!ai.llm || remaining() < 1500 || (cap && u.requests >= cap)) return null;   // no AI, out of time or over today's cap: rules
  u.requests += 1; u.dirty = true;
  try {
    const r = await withTimeout(ai.llm.chat([{ role: "user", content: prompt }], { schema: sch, maxTokens: maxTokens ?? (sch ? 300 : 600) }),
      Math.min(15000, remaining()));
    return r.content || null;
  } catch {
    return null;                                                        // busy, bad key, slow: the rules answer
  }
}

/** Markdown -> Slack mrkdwn: **bold** -> *bold*, "* item"/"- item" -> "• item", "### x" -> *x*. */
export function slackify(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^(\s*)[*-]\s+/gm, "$1• ");
}

function itemLines(occ: Occ[], tz: string, tag: (o: Occ) => string = () => ""): string {
  return occ.slice(0, 150).map((o) => `${strftimeDate(o.day, "%a %b %-d")}${tag(o)} ${o.allDay ? "all day" : strftime({ t: o.t, tz }, "%-I:%M %p")} | `
    + `${o.it.course || "-"} | ${category(o.it)}${o.it.role === "deadline" ? " (due)" : ""} | ${o.it.title}`
    + `${o.it.location && category(o.it) === "class" ? " | " + o.it.location : ""}`).join("\n");
}


/** What the course's recent posts say about a topic, with the real links (the chat's announcement reader,
 *  for other parts of Duely: the test-eve briefing). */
export async function announcementAnswer(courses: string[], topic: string, question: string, items: any[], cfg: any, ai: AI,
  f: typeof fetch, now: number, tz: string): Promise<string> {
  const day = localDate({ t: now, tz }, tz);
  const u: Usage = { date: day, requests: 0, fails: 0, lastList: [], turns: [], deadline: Date.now() + MESSAGE_BUDGET_MS };
  const q: Intent = { mode: "announcements", from: day, to: day, courses, categories: [], due_only: false, include_classes: false, limit: null, topic };
  return announcementsReply(q, question, items, cfg, ai, u, f, now, tz);
}

/** Recent announcements, best match first, for "what did the prof say about …". */
// Students say "midterm" for any in-term test ("Test 1", "Term test"), so these all mean the same topic.
const TEST_WORDS = ["midterm", "midterms", "test", "tests", "exam", "exams", "final", "finals", "quiz"];

async function announcementsReply(q: Intent, text: string, items: any[], cfg: any, ai: AI, u: Usage,
  f: typeof fetch, now: number, tz: string): Promise<string> {
  const feeds: string[] = (cfg.announcement_feeds ?? []).filter((x: string) => x && x.trim());
  if (!feeds.length) return "No announcement feeds are set up yet (Duely → Preferences → Announcements).";
  const got = await Promise.allSettled(feeds.map((url) => fetchRss(url, f)));
  let anns = got.flatMap((g) => (g.status === "fulfilled" ? parseRss(g.value) : []))
    .filter((a) => a.posted >= now - 30 * 86400e3 && (!q.courses.length || q.courses.includes(a.course)));
  let words = String(q.topic ?? "").toLowerCase().replace(/\bmid[\s-]+term/g, "midterm").split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const testTopic = words.some((w) => TEST_WORDS.includes(w));
  if (testTopic) words = [...new Set([...words, "test", "midterm", "exam", "final"])];
  const score = (a: any) => words.filter((w) => new RegExp(`\\b${w}`).test(`${a.title} ${a.body}`.toLowerCase())).length;
  anns = anns.sort((a, b) => score(b) - score(a) || b.posted - a.posted).slice(0, 12);
  const where = `${q.courses.length ? " for " + q.courses.join(" / ") : ""}${q.topic ? ` about “${q.topic}”` : ""}`;
  if (!anns.length) return `No announcements${where} in the last 30 days.`;
  const day = (t: number) => strftime({ t, tz }, "%a %b %-d");
  // their actual upcoming tests, so "the midterm" can be tied to "Test 1" on the calendar
  const d0 = localDate({ t: now, tz }, tz);
  const tests = testTopic
    ? occurrences(items, d0, addDays(d0, 90), tz, now).filter((o) => category(o.it) === "test"
      && (!q.courses.length || q.courses.includes(o.it.course)))
    : [];
  const prompt = `You are Duely, a student's assistant on Slack. Answer the question using ONLY these course announcements${tests.length ? " and calendar tests" : ""}.
Summarise what was said (dates, times, places, what's covered) in at most 5 short "• " bullets, plain text, no bold inside quotes.
End each bullet with its source number in square brackets, like [1]. Don't write links yourself. Read the question loosely (synonyms, typos, casual wording). If nothing answers it exactly, share the closest related posts and say briefly what's missing; only say there's nothing if no post is related at all. Leave out posts that aren't about the question.
"The prof" / "they" means anyone teaching the course (professor, instructor or TAs): answer with what the course staff posted, don't split hairs about who wrote it.
"Midterm" means any in-term test: a course's "Test 1" or "Term Test" IS its midterm. Don't say there's no midterm when there's a test.

${anns.map((a, i) => `[${i + 1}] ${a.course || "-"} | posted ${day(a.posted)} | ${a.title}\n${a.body.slice(0, 800)}`).join("\n\n")}
${tests.length ? `\nCALENDAR TESTS (no source number):\n${itemLines(tests, tz)}` : ""}

QUESTION: ${text.slice(0, 500)}`;
  // dates the answer may mention: the posts' own dates, when they were posted, the calendar tests
  const d0n = localDate({ t: now, tz }, tz);
  const allowed = anns.flatMap((a) => [...datesIn(`${a.title} ${a.body}`, d0n), localDate({ t: a.posted, tz }, tz)]);
  const gItems: GuardItem[] = tests.map((o) => ({ title: o.it.title, course: o.it.course, day: o.day }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await askAI(prompt + (attempt ? "\n\nUse only dates that appear in the announcements or calendar tests above." : ""), false, cfg, ai, u, f, 500);
    if (!out) break;
    // the code adds the links, so they're always the real Brightspace ones:
    // "[1]", "[1, 3]" or "[1, CALENDAR TESTS]" -> links to the cited posts (anything else is dropped)
    const cited = slackify(out).replace(/\s*\[([^\]\n]{1,40})\]/g, (m, inner) => {
      if (!/\d/.test(inner) && !/calendar/i.test(inner)) return m;
      const links = [...new Set(inner.match(/\d{1,2}/g) ?? [])].map((n) => anns[Number(n) - 1]).filter(Boolean)
        .map((a) => `<${a.link}|${a.title.replace(/[<>|]/g, "")}>`);
      return links.length ? ` (${links.join(", ")})` : "";
    });
    const g = guard(cited, gItems, d0n, allowed, { maxLines: 8, maxChars: 2500 });
    if (!g.unknownDates.length) return g.text;
  }
  return `*Recent announcements${where}:*\n` + anns.slice(0, 5)
    .map((a) => `• ${day(a.posted)}  ${a.course ? a.course + ": " : ""}<${a.link}|${a.title.replace(/[<>|]/g, "")}>`).join("\n");
}

const TIME_WORDS = /\b(today|tonight|tomorrow|week|weekend|weeks|month|months|term|semester|days?|fortnight|mon|tues?|wed|thu|thurs|fri|sat|sun|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|before|after|until|by)\b|\d{1,2}[/-]\d{1,2}/i;

/** The whole reply to one DM. Never throws: on any failure it answers with the rules instead. */
export async function answer(text: string, items: any[], cfg: any, store: Store, tz: string,
  f: typeof fetch = fetch, now = Date.now(), ai: AI = {}): Promise<string> {
  const u: Usage = { ...(await loadSession(store, tz, now)), deadline: Date.now() + MESSAGE_BUDGET_MS };
  let out: string, intent: Intent | null = null;
  const t0 = Date.now();
  let uids: string[] = [];
  const inner = ai.onList;
  ai = { ...ai, onList: (r) => { uids = r.map((x) => x.uid); inner?.(r); } };
  try {
    const done = await loadDone(store);
    const marked = items.map((it) => (done[it.uid] ? { ...it, done: true } : it.done && !done[it.uid] ? { ...it, done: false } : it));
    ({ text: out, intent } = await reply(text, marked, cfg, store, tz, f, now, ai, u, done));
  } catch (e) {
    u.fails += 1;
    out = "I hit a snag answering that 😕 " + safeRules(text, items, tz, now, u, ai);
    // every failure is reported; the Worker's reporter sends each distinct error once
    await ai.onFailure?.(`A message failed (${u.fails} today): “${text.slice(0, 80)}”. Error: ${String((e as Error)?.message ?? e).slice(0, 300)}`)
      .catch(() => {});
  }
  u.turns = [...u.turns, { q: text.slice(0, 200), intent, said: out.slice(0, 300), at: now }].slice(-3);
  try {
    const { dirty, deadline, engine, ...save } = u;
    await store.put("chat-session", save);
  } catch { /* the reply still goes out */ }
  return out;
}

/** The rules' best answer, for when something broke. */
function safeRules(text: string, items: any[], tz: string, now: number, u: Usage, ai: AI): string {
  try {
    const q = parseQuery(normalize(text), tz, now);
    if (q && ["list", "next", "count"].includes(q.mode)) {
      const r = executeRefs(q, items, tz, now);
      if (r.refs.length) u.lastList = r.refs;
      ai.onList?.(r.rows.map((o) => ({ uid: o.it.uid, day: o.day })));
      return "Here's my best guess:\n" + r.text;
    }
  } catch { /* fall through */ }
  return "Try asking again in a moment, or ask something simple like *what's due this week*.";
}

function itemName(it: any): string {
  return `*${it.course ? it.course + ": " : ""}${it.title}*`;
}

/** Replies to a proposal. "keep" / "remove" answer the one-time question about old study blocks. */
const YES = /^(y|ya|yes|yep|yeah|yup|sure|ok|okay|k|add( it| them)?|do it|keep( them| it)?|yes please|please do|go ahead|sounds good|confirm|correct|right)$/;
const NO = /^(n|no|nope|nah|not now|skip( it)?|no thanks|nevermind|never mind|remove( them| it)?|don'?t|cancel|wrong one)$/;

/** Words that make a time window more than the rules understand ("before thursday"). */
const TIME_QUALIFIER = /\b(before|after|until|till|til|by|since|from|between|except|other than|starting|through|thru|end of|beginning of|start of|later than|earlier than|past|ago|last)\b|\b\d{1,2}(st|nd|rd|th)\b/;

const FOLLOW_UP = /^(and|what about|how about|wbu|only|just|same|also|ok(ay)? (and|what about)|now|then|but)\b/;

/** Rules for a follow-up when no AI is around: keep the last filter, change what they said. */
function followUp(n: string, ruled: Intent | null, last: Intent | null): Intent | null {
  if (!last || !["list", "next", "count"].includes(last.mode) || !FOLLOW_UP.test(n)) return null;
  const q: Intent = { ...last, broadened: false };
  if (ruled && !ruled.defaulted && (ruled.from !== last.from || ruled.to !== last.to)) { q.from = ruled.from; q.to = ruled.to; q.defaulted = false; }
  if (ruled?.courses.length) q.courses = ruled.courses;
  if (ruled?.categories.length) { q.categories = ruled.categories; q.due_only = ruled.due_only; }
  if (/\b(all|any|every) (courses?|classes)\b/.test(n)) q.courses = [];
  return q;
}

async function reply(text: string, items: any[], cfg: any, store: Store, tz: string, f: typeof fetch, now: number, ai: AI,
  u: Usage, done: Done): Promise<{ text: string; intent: Intent | null }> {
  const t = text.trim();
  const day = localDate({ t: now, tz }, tz);
  if (!t || /^(help|\?)$/i.test(t)) return { text: "Hi! " + HELP, intent: null };
  const n = normalize(t, courseAliases(coursesOf(items)));
  const last = u.turns.length ? u.turns[u.turns.length - 1].intent : null;

  // 0. answers to a proposal ("yes" / "no", same as the buttons) and "undo" of the last change
  const plain = t.toLowerCase().replace(/[.!👍🙏]+/gu, "").trim();
  if (YES.test(plain) || NO.test(plain)) {
    const pend = await pendingAction(store, now);
    if (pend) return { text: (await decide(store, pend.id, YES.test(plain), "text", now)).text, intent: null };
  }
  if (/^(undo|undo (that|it)|take (that|it|them) (out|back))$/.test(plain)) {
    const d = await undoLast(store, now);
    if (d.action) return { text: d.text, intent: null };
  }
  const ruled = parseQuery(n, tz, now);
  let intent: Intent | null = ruled && ["done", "undone", "finished", "help"].includes(ruled.mode) ? ruled : null;

  // the agent answers everything but commands and announcement questions; the filter pipeline if it
  // can't (no AI, a model without tool calling, or no checked answer)
  if (cfg.chat_engine !== "v1" && cfg.ai_tools !== false && !intent && ruled?.mode !== "announcements" && ai.llm) {
    const cap = Number(cfg.chat_daily_limit ?? 300) || 0;
    // the cleaned-up text (typos, slang, course nicknames: "assignmnts", "tmrw", "stats" -> STAT 2507), plus
    // the original when cleaning changed it, so tone and wording survive
    const said = n.trim() === t.trim().toLowerCase() ? t : `${t}\n(cleaned up: ${n})`;
    u.engine = "agent";
    const r = await agentReply(said, items, tz, now, u.turns.map((x) => ({ q: x.q, said: x.said })), {
      llm: ai.llm, deadline: u.deadline,
      budgetLeft: () => !cap || u.requests < cap,
      spend: () => { u.requests += 1; u.dirty = true; },
    });
    if (r?.handoff) {
      // announcement questions: the v1 reader (real posts, links inserted by code)
      const known = new Set(items.map((i: any) => i.course));
      const courses = r.handoff.courses.map((c) => c.toUpperCase().replace(/^([A-Z]{4})\s*-?(\d{4}).*$/, "$1 $2")).filter((c) => known.has(c));
      const q: Intent = { mode: "announcements", from: day, to: day, courses, categories: [], due_only: false, include_classes: false, limit: null, topic: r.handoff.topic };
      return { text: await announcementsReply(q, t, items, cfg, ai, u, f, now, tz), intent: q };
    }
    if (!r || r.handoff) u.engine = r?.handoff ? "agent>announcements" : "agent>v1";
    if (r) {
      if (r.refs.length) u.lastList = r.refs;
      ai.onList?.(r.rows.map((o) => ({ uid: o.it.uid, day: o.day })));
      return { text: r.text, intent: null };
    }
  }
  if (!intent) {
    const raw = await askAI(intentPrompt(n, items, tz, now, u.turns), true, cfg, ai, u, f);
    if (raw) {
      const known = [...new Set<string>(items.map((i: any) => i.course).filter(Boolean))];
      try { intent = validIntent(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")), day, known); } catch { intent = null; }
      if (intent && !TIME_WORDS.test(n) && !(FOLLOW_UP.test(n) && last && !last.defaulted)) intent.defaulted = true;   // no time said: the window is ours
      // "what quiz do I have this week" is a list; "next" only when they say so
      if (intent?.mode === "next" && !/\b(next|soonest|upcoming|first|closest)\b/.test(n)) { intent.mode = "list"; intent.limit = null; }
      // plain time words ("friday", "tomorrow", "next 2 weeks") are the rules' strength, date maths the AI's weakness
      if (intent && ruled && !ruled.defaulted && !TIME_QUALIFIER.test(n) && ["list", "next", "count", "free_text"].includes(intent.mode)
        && ["list", "next", "count"].includes(ruled.mode)) {
        intent.from = ruled.from; intent.to = ruled.to; intent.defaulted = false;
        if (ruled.from === ruled.to && !intent.due_only && !intent.categories.length) intent.include_classes = true;
      }
    }
    if (!intent) intent = followUp(n, ruled, last) ?? ruled;
    if (!intent && raw) intent = { mode: "free_text", from: day, to: addDays(day, 30), courses: [], categories: [], due_only: false, include_classes: false, limit: null, defaulted: true };
  }
  if (!intent) return { text: "I'm best with questions about your courses and deadlines. " + HELP, intent: null };
  if (intent.mode === "help") return { text: /\b(thanks?|thank you|ty)\b/i.test(n) ? "Any time! 👍" : "Hi! " + HELP, intent };
  const done_ = await doneReply(intent, items, u, done, store, now, tz, ai);
  if (done_ !== null) return { text: done_, intent };

  // 3. announcements
  if (intent.mode === "announcements") return { text: await announcementsReply(intent, t, items, cfg, ai, u, f, now, tz), intent };

  // 4. free-form questions: an AI answers from exactly the filtered items, and code checks it
  if (intent.mode === "free_text") {
    const to = intent.defaulted && intent.to < addDays(day, 30) ? addDays(day, 30) : intent.to;
    const occ = occurrences(items, intent.from, to, tz, now).filter((o) => matches(o, intent!));
    const rel = (o: Occ) => { const d = (Date.parse(o.day) - Date.parse(day)) / 864e5; return d === 0 ? " [today]" : d === 1 ? " [tomorrow" + (o.it.role === "deadline" ? " night, NOT tonight]" : "]") : ""; };
    const prompt = `You are Duely, a student's calendar assistant on Slack. It is now ${strftime({ t: now, tz }, "%a %b %-d %Y, %-I:%M %p")} (${tz}).
Get "today", "tonight" and "tomorrow" right from that: an item marked [tomorrow…] is NOT due tonight, so never say "tonight" about it.
HARD LIMIT: 8 lines in total. Only the most important items, no "pro tips" sections, no repeating the list.
Talk like a helpful friend: casual, warm, short. Read the question generously (slang, typos, vague asks are fine) and actually help:
plans, priorities, encouragement and general study tips are welcome. For facts about their schedule use ONLY these calendar items
(${describeRange(intent.from, to, tz, now)}); never invent items, dates or grades. Copy dates exactly as written in ITEMS.
Slack formatting: *bold* for dates, "• " bullets. Dates like "Tue Oct 7, 11:59 PM".
${recentChat(u.turns)}
ITEMS:
${itemLines(occ, tz, rel) || "(none)"}
${perDay(occ)}
QUESTION: ${t.slice(0, 500)}`;
    const gItems: GuardItem[] = occ.map((o) => ({ title: o.it.title, course: o.it.course, day: o.day }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const extra = attempt ? "\n\nYour last answer mentioned dates that aren't in ITEMS. Use only the dates in ITEMS." : "";
      const out = await askAI(prompt + extra, false, cfg, ai, u, f, 500);
      if (!out) break;
      const g = guard(slackify(out), gItems, day);
      if (!g.unknownDates.length) return { text: g.text, intent };
    }
    intent = { ...intent, mode: "list", to };                       // no AI, or it kept inventing: list the facts
  }

  // 5. everything else: the AI picks which of the real items answer the question (it understands
  //    "lectures" vs tutorials, "stuff to hand in", …), code prints exactly those (numbered, so
  //    "done 2" works). Without an AI, the filter alone decides.
  // only where the filter is too coarse: kinds of classes ("lectures" vs "tutorials"). Elsewhere the
  // filter is exact, and letting the AI narrow it dropped right answers (75/79 vs 79/79, 2026-10-04).
  const needsPick = /\b(lectures?|tutorials?|labs?|seminars?|class(es)?|schedule)\b/i.test(n);
  const picked = needsPick && ["list", "count", "next"].includes(intent.mode) ? await pickItems(intent, n, items, cfg, ai, u, f, now, tz) : undefined;
  const filterEmpty = picked && !picked.occ.length && !occurrences(items, intent.from, intent.to, tz, now).some((o) => matches(o, intent!));
  const r = executeRefs(intent, items, tz, now, filterEmpty ? undefined : picked);
  if (r.refs.length) u.lastList = r.refs;
  ai.onList?.(r.rows.map((o) => ({ uid: o.it.uid, day: o.day })));
  return { text: r.text, intent };
}

const PICK_SCHEMA = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "integer" } },
    phrase: { type: "string", description: "what was picked, as a short plural phrase with the time, e.g. \"lectures tomorrow\"" },
  },
  required: ["ids", "phrase"],
};
const PICK_MAX = 120;
const KIND_WORDS = ["lecture", "tutorial", "lab", "seminar", "quiz", "midterm", "exam"];
const CLASS_KINDS = ["lecture", "tutorial", "lab", "seminar"];

/** The AI narrows the filter's result to exactly what was asked ("lectures" out of classes, "to hand
 *  in" out of everything), choosing by number. It can only remove, never add, so a weak pick can't
 *  bring in wrong kinds (tried 2026-10-04: letting it choose from everything scored 72/79, the
 *  filter alone 75/75). Undefined when there's no AI, nothing to narrow, or its answer is unusable. */
async function pickItems(q: Intent, text: string, items: any[], cfg: any, ai: AI, u: Usage, f: typeof fetch,
  now: number, tz: string): Promise<{ occ: Occ[]; phrase: string } | undefined> {
  if (!ai.llm) return undefined;
  // "tutorials" / "labs" are classes as well as things to hand in: offer both, the AI picks
  const both = q.categories.some((c) => c === "tutorial" || c === "lab");
  const base: Intent = both ? { ...q, categories: [...q.categories, "class"], include_classes: true, due_only: false } : q;
  const pool = occurrences(items, q.from, q.to, tz, now).filter((o) => matches(o, base)).slice(0, PICK_MAX);
  if (pool.length < 2) return undefined;
  // already exact: every item is a kind they named (and not "class", which mixes lectures, tutorials, labs)
  const named = q.categories.filter((c) => c !== "class");
  if (named.length && pool.every((o) => named.includes(category(o.it)))) return undefined;
  const lines = pool.map((o, i) => `[${i + 1}] ${strftimeDate(o.day, "%a %b %-d")} ${o.allDay ? "all day" : strftime({ t: o.t, tz }, "%-I:%M %p")}`
    + ` | ${o.it.course || "-"} | ${o.it.title} | kind: ${category(o.it)}${o.it.role === "deadline" ? " (due)" : ""}`).join("\n");
  const prompt = `A student asked their calendar assistant: "${text.slice(0, 300)}"
Today is ${strftimeDate(localDate({ t: now, tz }, tz), "%a %b %-d %Y")}. Here is what their calendar has for that (${describeRange(q.from, q.to, tz, now)}):
${lines}

Pick exactly the items that answer the question, by number. Be precise about kinds, reading titles too:
- "lectures" = only lectures (not tutorials, labs, quizzes or deadlines); "tutorials" = tutorial classes and tutorial submissions; "labs" likewise
- "classes" / "schedule" = lectures, tutorials, labs and seminars; "what's due" / "deadlines" / "homework" = only items marked (due)
- "tests" / "exams" / "midterms" = tests, midterms and exams (not quizzes unless they ask); "quizzes" = quizzes
- a broad question ("what do I have tomorrow", "what's on friday") = everything listed
- if they name a kind ("assignments"), pick every item of that kind; don't drop any for being early, small or optional
- "next X" = only the soonest matching item(s)
If nothing fits, return no ids. phrase: what you picked as a short lowercase plural phrase with the time, e.g. "lectures tomorrow", "deadlines this week", "tests this term".
Answer with only this JSON: {"ids": [numbers], "phrase": "..."}`;
  // Mistral Small with forced JSON sometimes emits "{" and then only whitespace (seen live 2026-10-04),
  // so: Mistral Small answering in plain text (we pull the JSON out), then Llama with forced JSON
  let ans: any;
  for (const schema of [undefined, PICK_SCHEMA]) {
    const raw = await askAI(prompt, false, cfg, ai, u, f, 300, schema);
    const json = raw?.match(/\{[\s\S]*\}/)?.[0];
    try { ans = json ? JSON.parse(json) : null; } catch { ans = null; }
    if (ans && Array.isArray(ans.ids)) break;
    ans = null;
  }
  if (!ans) return undefined;
  const ids = new Set<number>(ans.ids.filter((n: any) => Number.isInteger(n) && n >= 1 && n <= pool.length));
  if (ans.ids.length && !ids.size) return undefined;               // only nonsense numbers: don't trust it
  // safety net: a kind they named ("tutorials") that's in an item's title is always included, in
  // case the AI overlooked a line (it skipped one tutorial in a live check)
  const words = KIND_WORDS.filter((w) => new RegExp(`\\b${w}s?\\b`, "i").test(text));
  pool.forEach((o, i) => { if (words.some((w) => new RegExp(`\\b${w}`, "i").test(o.it.title))) ids.add(i + 1); });
  const phrase = String(ans.phrase ?? "").replace(/[*_`<>\n]/g, " ").replace(/^\s*no\s+/i, "").replace(/\s+/g, " ").trim().slice(0, 60)
    || `${noun(q, 2)} ${describeRange(q.from, q.to, tz, now)}`;
  // a class titled with another kind than the one asked for ("Tutorial" when they asked for lectures) is dropped
  const other = CLASS_KINDS.filter((k) => !words.includes(k));
  const occ = [...ids].sort((a, b) => a - b).map((n) => pool[n - 1])
    .filter((o) => !(words.some((w) => CLASS_KINDS.includes(w)) && category(o.it) === "class"
      && other.some((k) => new RegExp(`\\b${k}`, "i").test(o.it.title))));
  return { occ, phrase };
}

/** "DUE PER DAY (counted by code): Fri Oct 9: 4 · Mon Oct 5: 1" so the AI doesn't have to count. */
function perDay(occ: Occ[]): string {
  const n = new Map<string, number>();
  for (const o of occ) if (isWork(o.it)) n.set(o.day, (n.get(o.day) ?? 0) + 1);
  if (!n.size) return "";
  return "DUE PER DAY (counted by code, busiest first): " + [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d, c]) => `${strftimeDate(d, "%a %b %-d")}: ${c}`).join(" · ") + "\n";
}

/** The last few messages, for the AI's context. */
function recentChat(turns: Turn[]): string {
  if (!turns.length) return "";
  return "\nEARLIER IN THIS CHAT (oldest first):\n" + turns.map((x) => `Student: ${x.q}\nDuely: ${x.said.replace(/\n+/g, " / ").slice(0, 200)}`).join("\n") + "\n";
}

/** done / undone. Null when the intent is something else. */
async function doneReply(intent: Intent, items: any[], u: Usage, done: Done, store: Store, now: number, tz: string, ai: AI): Promise<string | null> {
  if (intent.mode === "done" || intent.mode === "undone") {
    const marking = intent.mode === "done";
    let r = resolveTarget(intent.target ?? "", items, u.lastList, now, marking ? false : true);
    if (marking && !r.match && !r.choices) {                       // maybe it's already done
      const again = resolveTarget(intent.target ?? "", items, u.lastList, now, true);
      if (again.match) return `${itemName(again.match)} is already done ✓`;
    }
    if (r.match) {
      if (marking && done[r.match.uid]) return `${itemName(r.match)} is already done ✓`;
      const name = `${r.match.course ? r.match.course + ": " : ""}${r.match.title}`;
      const type = marking ? "mark_done" as const : "undo_done" as const;
      const draft = { type, key: `${type}:${r.match.uid}:${now}`, args: { uid: r.match.uid, name },
        summary: marking ? `Mark *${name}* done?` : `Put *${name}* back on your list?` };
      // picked by number from a list: that's unambiguous, do it. Found by name: check first.
      if (r.exact) return (await record(store, draft, now)).text;
      const [a] = await propose(store, [draft], now);
      if (a) ai.onProposal?.(a);
      return `${draft.summary} Reply *yes* or *no*.`;
    }
    if (r.choices?.length) {
      u.lastList = r.choices.map((c) => c.uid);
      const verb = marking ? "done" : "undo";
      return `Which one? Reply *${verb} 1*, *${verb} 2*…\n` + r.choices.map((c, i) => {
        const w = Date.parse(String(c.role === "deadline" ? c.end ?? c.start : c.start));
        return `${i + 1}. ${Number.isNaN(w) ? "" : strftime({ t: w, tz }, "%a %b %-d") + "  "}${c.course ? c.course + ": " : ""}${c.title}`;
      }).join("\n");
    }
    return marking
      ? `I couldn't find “${intent.target}” in your upcoming work. Ask for a list (like *what's due this week*) and reply *done 2* with its number.`
      : `I couldn't find “${intent.target}” among the things you've marked done. Try *what have I finished*.`;
  }

  return null;
}
