// The chat as an agent (AI v2 M2, design §5.1–5.4). The model gets today's date, a two-week view of
// the calendar and a few tools (plain code over the real items), may call them, and answers in its
// own words, citing items as [#n]. Code then prints exactly the cited items as the usual numbered
// list, and checks the words (guard.ts: today/tonight/tomorrow, weekdays, unknown dates). Anything
// off -> one repair round -> otherwise null, and the caller answers with the v1 pipeline.
// Kinds come from code: lecture vs tutorial vs lab is decided here, not by the model.
// (Duely Public: the student's one provider, through src/llm; was Workers AI in the personal version.)
import { type Occ, dayHeader, describeRange, line, occurrences, parseQuery } from "./ask.ts";
import { type GuardItem, guard } from "./guard.ts";
import { NOT_TEST_RE, category } from "./kinds.ts";
import { addDays, localDate, strftime, strftimeDate } from "./time.ts";
import type { LLM, Msg, Tool } from "../llm/types.ts";

// agent eval 2026-10-09 (42 cases): Llama 3.3 42/42 at 2.0/2.9 s, Mistral Small 3.1 39/42, gpt-oss-120b 25/42

const MAX_STEPS = 6;
const GLANCE_DAYS = 14;
// $ per token, for the chat's neuron budget ($0.011 per 1k neurons)

/** What a calendar item is, in the words students use. Classes are split by title. */
export function kindOf(it: any): string {
  const c = category(it);
  if (c === "class") {
    const t = String(it.title ?? "");
    if (/\blecture\b|\(LEC\)/i.test(t)) return "lecture";
    if (/\btutorial\b|\(TUT\)/i.test(t)) return "tutorial";
    if (/\blab\b|\(LAB\)/i.test(t)) return "lab";
    if (/\bseminar\b|\(SEM\)/i.test(t)) return "seminar";
    return "class";
  }
  return ({ tutorial: "tutorial_work", lab: "lab_work", other: "other_work" } as Record<string, string>)[c] ?? c;
}
const KINDS = ["lecture", "tutorial", "lab", "seminar", "class", "assignment", "tutorial_work", "lab_work", "module", "quiz", "test", "other_work", "event", "study"];
const CLASSES = new Set(["lecture", "tutorial", "lab", "seminar", "class"]);

type Turn = { q: string; said: string };
export type AgentResult = { text: string; rows: Occ[]; refs: string[]; handoff?: { courses: string[]; topic: string } };

/** Tool definitions (OpenAI format, as Workers AI takes them). */
const TOOLS = [
  {
    type: "function", function: {
      name: "search_items",
      description: "Calendar items in a time window. Use for anything not in the two-week view, or to filter it.",
      parameters: {
        type: "object", properties: {
          when: { type: "string", description: 'Plain words: "today", "tomorrow", "friday", "this week", "next week", "next 3 weeks", "in november", "rest of the term", or "YYYY-MM-DD" or "YYYY-MM-DD..YYYY-MM-DD"' },
          kinds: { type: "array", items: { type: "string", enum: [...KINDS, "work", "classes"] }, description: '"work" = everything to hand in; "classes" = all timetable classes. Empty = everything' },
          courses: { type: "array", items: { type: "string" }, description: 'Course codes like "COMP 2406"' },
          text: { type: "string", description: "Words that must appear in the title (optional)" },
        }, required: ["when"],
      },
    },
  },
  {
    type: "function", function: {
      name: "next_items",
      description: "The soonest upcoming items of some kinds (up to 6 months ahead).",
      parameters: {
        type: "object", properties: {
          kinds: { type: "array", items: { type: "string", enum: [...KINDS, "work", "classes"] } },
          courses: { type: "array", items: { type: "string" } },
          text: { type: "string" },
          count: { type: "integer", description: "How many (1-5, default 1)" },
        }, required: [],
      },
    },
  },
  {
    type: "function", function: {
      name: "reply",
      description: "Send your answer. ALWAYS finish with this. To show calendar items, describe them in `show`: the app lists exactly the matching items itself (don't pick them one by one).",
      parameters: {
        type: "object", properties: {
          message: { type: "string", description: "1-3 short friendly sentences. Write {n} where the number of shown items goes (\"You have {n} assignments due this week\"). No dates, times or titles of the shown items: they're listed under your message. May cite extra items as [#id]." },
          show: {
            type: "object", description: "Which items to list under the message (omit for small talk or a clarifying question)",
            properties: {
              when: { type: "string", description: 'Time words exactly as the student said them ("tomorrow", "this week", "next week", "friday", "next 2 weeks", "rest of the term"), or YYYY-MM-DD / YYYY-MM-DD..YYYY-MM-DD' },
              kinds: { type: "array", items: { type: "string", enum: [...KINDS, "work", "classes"] }, description: '"work" = everything to hand in ("what\'s due"); "classes" = all timetable classes; empty = everything (except study blocks)' },
              courses: { type: "array", items: { type: "string" }, description: 'Course codes, e.g. "COMP 2406"' },
              text: { type: "string", description: "Words that must be in the title (e.g. \"Test 1\")" },
              next: { type: "integer", description: "For \"next / soonest / upcoming X\": show only the soonest N (usually 1); then `when` is ignored" },
            },
          },
        }, required: ["message"],
      },
    },
  },
  {
    type: "function", function: {
      name: "announcements",
      description: "For questions about what a professor/TA posted or said (course announcements). The app answers it from the real posts; call this instead of reply.",
      parameters: { type: "object", properties: {
        courses: { type: "array", items: { type: "string" }, description: 'Course codes, e.g. "STAT 2507"; empty = all' },
        topic: { type: "string", description: 'What about, in a few words ("midterm", "A1", "office hours"); empty = anything recent' },
      }, required: [] },
    },
  },
  {
    type: "function", function: {
      name: "get_item",
      description: "Full details of one item (description, where, source).",
      parameters: { type: "object", properties: { id: { type: "string", description: 'An id like "#3"' } }, required: ["id"] },
    },
  },
];

class Ids {
  private byKey = new Map<string, number>();
  occ: Occ[] = [];
  id(o: Occ): string {
    const k = `${o.it.uid}@${o.day}@${o.t}`;
    let n = this.byKey.get(k);
    if (!n) { this.occ.push(o); n = this.occ.length; this.byKey.set(k, n); }
    return `#${n}`;
  }
  get(id: string): Occ | undefined { return this.occ[Number(String(id).replace(/\D/g, "")) - 1]; }
}

function row(o: Occ, ids: Ids, tz: string): string {
  const it = o.it, k = kindOf(it);
  const when = o.allDay ? "all day" : strftime({ t: o.t, tz }, "%-I:%M %p");
  const tags = [it.role === "deadline" ? "due" : "", it.done ? "DONE (marked by the student)" : "", it.announced ? "from announcement" : ""].filter(Boolean).join(", ");
  return `${ids.id(o)} | ${strftimeDate(o.day, "%a %b %-d")} ${when} | ${it.course || "-"} | ${k} | ${it.title}${it.location && CLASSES.has(k) ? " | " + it.location : ""}${tags ? " | " + tags : ""}`;
}

function wantKinds(kinds: unknown): ((it: any) => boolean) {
  const ks = Array.isArray(kinds) ? kinds.map(String) : [];
  if (!ks.length) return (it) => kindOf(it) !== "study";          // study blocks only when asked
  return (it) => {
    const k = kindOf(it);
    return ks.includes(k) || (ks.includes("work") && it.role === "deadline" && k !== "study") || (ks.includes("classes") && CLASSES.has(k))
      || (ks.includes("test") && k === "test");
  };
}

/** "tomorrow" / "next week" / "2026-10-16" -> [from, to]. The rules' date logic (it's right about
 *  weekends and "next week"); the model never does date arithmetic. */
/** "next week and next month" / "today and tomorrow" / "friday, monday": each part on its own
 *  (2026-10-09: the month rule swallowed the whole phrase and dropped "next week"). A single phrase
 *  gives one window. Parts that aren't time words are ignored. */
export function resolveWindows(when: string, tz: string, now: number): [string, string][] {
  const w = String(when ?? "").trim().toLowerCase();
  const parts = w.split(/\s*(?:,|&|\band\b|\bplus\b|\bor\b)\s*/).map((x) => x.trim()).filter((x) => x.length > 1);
  // "this month or next" / "this week and next": the bare "next" borrows the unit
  for (let i = 1; i < parts.length; i++) {
    const unit = /\b(week|month)s?\b/.exec(parts[i - 1])?.[1];
    if (unit && /^(the )?(next|following)( one)?$/.test(parts[i])) parts[i] = `next ${unit}`;
  }
  // "next week and the week after (that)" / "… and the following week": the part after the one before
  const shifted: ([string, string] | null)[] = parts.map(() => null);
  for (let i = 1; i < parts.length; i++) {
    const m = /^(?:the )?(?:(week|month) after(?: that)?|following (week|month))$/.exec(parts[i]);
    if (!m) continue;
    const [a, b] = shifted[i - 1] ?? resolveWhen(parts[i - 1], tz, now);
    shifted[i] = (m[1] ?? m[2]) === "week" ? [addDays(a, 7), addDays(b, 7)]
      : (() => { const n = (x: string) => { const [y, mo] = x.split("-").map(Number); return `${y + Math.floor(mo / 12)}-${String((mo % 12) + 1).padStart(2, "0")}`; };
        const s0 = `${n(a)}-01`; return [s0, addDays(`${n(s0)}-01`, -1)] as [string, string]; })();
  }
  if (parts.length <= 1 || /\.\./.test(w) || /^(between|from)\b/.test(w)) return [resolveWhen(w, tz, now)];
  const d = localDate({ t: now, tz }, tz);
  const def: [string, string] = [d, addDays(d, 14)];
  const wins = parts.map((x, i) => shifted[i] ?? resolveWhen(x, tz, now)).filter((x) => x[0] !== def[0] || x[1] !== def[1] || /next 2 weeks|two weeks|14 days/.test(w));
  return wins.length ? wins : [resolveWhen(w, tz, now)];
}

export function resolveWhen(when: string, tz: string, now: number): [string, string] {
  const w = String(when ?? "").trim().toLowerCase();
  const d = localDate({ t: now, tz }, tz);
  // ranges, before any single-day / month rule (2026-10-09 sweep: "before november" meant November)
  const NOWISH = /^(now|today|tonight)$/;
  const startOf = (x: string) => (NOWISH.test(x.trim()) ? d : resolveWhen(x, tz, now)[0]);
  const endOf = (x: string) => (NOWISH.test(x.trim()) ? d : resolveWhen(x, tz, now)[1]);
  const clamp = (a: string, b: string): [string, string] => [a < d ? d : a, b < a ? a : b];
  let r: RegExpExecArray | null;
  if ((r = /^between\s+(.+?)\s+and\s+(.+)$/.exec(w)) || (r = /^from\s+(.+?)\s+(?:to|until|till|til|through|thru|-|–)\s+(.+)$/.exec(w))
    || (r = /^(.+?)\s+(?:to|until|till|through|thru|-|–)\s+(.+)$/.exec(w))) {
    if (!/^(up|due|add)$/.test(r[1])) return clamp(startOf(r[1]), endOf(r[2]));        // "up to x" is below
  }
  if ((r = /^(?:up to|(?:un)?till?|through|thru|by|no later than)\s+(.+)$/.exec(w))) return clamp(d, endOf(r[1]));
  if ((r = /^before\s+(.+)$/.exec(w))) return clamp(d, addDays(startOf(r[1]), -1));
  if ((r = /^(?:after|from|starting|beginning)\s+(.+?)(?:\s+on(?:wards?)?)?$/.exec(w))) {
    const a = /^after/.test(w) ? addDays(endOf(r[1]), 1) : startOf(r[1]);
    return clamp(a, addDays(a < d ? d : a, 180));
  }
  const iso = /^(\d{4}-\d{2}-\d{2})(?:\s*(?:\.\.|to|–|-)\s*(\d{4}-\d{2}-\d{2}))?$/.exec(w);
  if (iso) return [iso[1] < d ? d : iso[1], iso[2] ?? iso[1]];
  // weekdays: "friday" / "this friday" = the next one (today if today); "next friday" = not today's: the
  // following one; "next week friday" / "friday next week" = that day in next week (2026-10-09: "next
  // friday" asked on a Friday meant today)
  const WD = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const wdRe = "(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)";   // not "month"
  const wdIdx = (x: string) => WD.findIndex((n) => n.startsWith(x.slice(0, 3)));
  const dow = (x: string) => (new Date(x + "T12:00:00Z").getUTCDay() + 6) % 7;
  let wm: RegExpExecArray | null;
  if ((wm = new RegExp(`^(?:on )?(this |coming |upcoming |next |the following )?${wdRe}$`).exec(w))) {
    const target = wdIdx(wm[2]);
    let ahead = (target - dow(d) + 7) % 7;
    if (/next|following/.test(wm[1] ?? "") && ahead === 0) ahead = 7;
    return [addDays(d, ahead), addDays(d, ahead)];
  }
  if ((wm = new RegExp(`^(?:next week ${wdRe}|${wdRe} (?:of )?next week)$`).exec(w))) {
    const target = wdIdx(wm[1] ?? wm[2]);
    const [nextMon] = resolveWhen("next week", tz, now);
    const day = addDays(nextMon, target);
    return [day, day];
  }
  if (/rest of (the )?(term|semester)|this term|all|everything|upcoming|soon/.test(w)) return [d, addDays(d, 120)];
  // months: "this month", "next month", "this month and next month", "in november", "october and november"
  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const ym = (y: number, m: number) => `${y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
  const y0 = Number(d.slice(0, 4)), m0 = Number(d.slice(5, 7)) - 1;
  const months: number[] = [];                                // month offsets from now
  if (/\bthis month\b/.test(w)) months.push(0);
  if (/\bnext month\b/.test(w)) months.push(1);
  if (/\bnext (\d|two|three) months\b/.test(w)) { const k = Number(/\d/.exec(w)?.[0] ?? (/two/.test(w) ? 2 : 3)); for (let i = 0; i <= k; i++) months.push(i); }
  for (const [i, nm] of MONTH_NAMES.entries()) if (new RegExp(`\\b${nm.slice(0, 3)}(${nm.slice(3)})?\\b`).test(w) && !/\b\d{1,2}(st|nd|rd|th)?\b/.test(w)) months.push((i - m0 + 12) % 12);
  if (months.length) {
    const lo = Math.min(...months), hi = Math.max(...months);
    const start = lo === 0 ? d : `${ym(y0, m0 + lo)}-01`;
    const endMonth = ym(y0, m0 + hi + 1);
    return [start, addDays(`${endMonth}-01`, -1)];
  }
  if (/day after tomorrow|overmorrow/.test(w)) return [addDays(d, 2), addDays(d, 2)];
  const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const wd = DAYS.findIndex((x) => new RegExp(`\\b${x.slice(0, 3)}`).test(w));
  const until = /\b(before|by|until|till|til)\b/.exec(w);
  if (until && wd >= 0) {                                   // "before thursday" = up to Wed; "by thursday" = up to Thu
    let target = d;
    while (DAYS[(new Date(target + "T12:00:00Z").getUTCDay() + 6) % 7] !== DAYS[wd] || target === d) target = addDays(target, 1);
    return [d, until[1] === "before" ? addDays(target, -1) : target];
  }
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(w) ?? /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.exec(w);
  const nth = /\b(?:the\s+)?(\d{1,2})(st|nd|rd|th)\b/.exec(w);
  if (md || nth) {                                          // "oct 9", "9 october", "the 9th": the next such date
    const mon = md ? MONTHS.indexOf((isNaN(Number(md[1])) ? md[1] : md[2]).slice(0, 3)) : -1;
    const day = Number(md ? (isNaN(Number(md[1])) ? md[2] : md[1]) : nth![1]);
    for (let k = 0; k < 400; k++) {
      const c = addDays(d, k);
      if (Number(c.slice(8)) === day && (mon < 0 || Number(c.slice(5, 7)) === mon + 1)) return [c, c];
    }
  }
  const q = parseQuery(`what's due ${w}`, tz, now);
  if (q && !q.defaulted) return [q.from, q.to];
  return [d, addDays(d, 14)];
}

function filterCourse(courses: unknown): (it: any) => boolean {
  const cs = (Array.isArray(courses) ? courses : []).map((c) => String(c).toUpperCase().replace(/^([A-Z]{4})\s*-?(\d{4}).*$/, "$1 $2"));
  return cs.length ? (it) => cs.includes(String(it.course ?? "").toUpperCase()) || cs.some((c) => /^\d{4}$/.test(c) && String(it.course).endsWith(c)) : () => true;
}

/** The items a filter means (code decides kinds, dates and courses, never the model). `next` = only
 *  the soonest N upcoming (ties at the same time included). Done items only when asked for. */
export function select(args: any, items: any[], tz: string, now: number): { occ: Occ[]; from: string; to: string } {
  const txt = String(args?.text ?? "").toLowerCase().trim();
  const textOk = (it: any) => !txt || String(it.title).toLowerCase().includes(txt);
  // a title that IS the text ("Test 1") beats one that merely contains it ("Test 1 Review Session")
  const exact = txt && items.some((it) => String(it.title).toLowerCase().trim() === txt);
  const textOk2 = (it: any) => (exact ? String(it.title).toLowerCase().trim() === txt : textOk(it));
  const ok = (o: Occ) => wantKinds(args?.kinds)(o.it) && filterCourse(args?.courses)(o.it) && textOk2(o.it) && (!o.it.done || !!args?.include_done);
  const next = Math.min(10, Math.max(0, Number(args?.next) || 0));
  if (next) {
    const d = localDate({ t: now, tz }, tz);
    const all = occurrences(items, d, addDays(d, 180), tz, now).filter((o) => o.t > now && ok(o));
    const first = all.slice(0, next);
    for (const o of all.slice(next)) if (o.t === first[first.length - 1]?.t) first.push(o); else break;
    return { occ: first, from: d, to: addDays(d, 180) };
  }
  const wins = resolveWindows(args?.when, tz, now);
  const from = wins.map((x) => x[0]).sort()[0], to = wins.map((x) => x[1]).sort().at(-1)!;
  const inAny = (o: Occ) => wins.some(([a, b]) => o.day >= a && o.day <= b);
  return { occ: occurrences(items, from, to, tz, now).filter((o) => ok(o) && inAny(o)), from, to };
}

function runTool(name: string, args: any, items: any[], ids: Ids, tz: string, now: number): string {
  const txt = String(args?.text ?? "").toLowerCase().trim();
  const textOk = (it: any) => !txt || String(it.title).toLowerCase().includes(txt);
  if (name === "search_items") {
    const { occ, from, to } = select({ ...args, include_done: true }, items, tz, now);
    const head = `${occ.length} item(s) ${describeRange(from, to, tz, now)} (${strftimeDate(from, "%a %b %-d")} to ${strftimeDate(to, "%a %b %-d")}):`;
    return [head, ...occ.slice(0, 60).map((o) => row(o, ids, tz)), occ.length > 60 ? `…and ${occ.length - 60} more` : ""].filter(Boolean).join("\n");
  }
  if (name === "next_items") {
    const d = localDate({ t: now, tz }, tz);
    const n = Math.min(5, Math.max(1, Number(args?.count) || 1));
    const occ = occurrences(items, d, addDays(d, 180), tz, now)
      .filter((o) => o.t > now && !o.it.done && wantKinds(args?.kinds)(o.it) && filterCourse(args?.courses)(o.it) && textOk(o.it));
    const first = occ.slice(0, n);
    // things at the very same time as the last one shown are listed too (no arbitrary pick)
    for (const o of occ.slice(n)) if (o.t === first[first.length - 1]?.t) first.push(o); else break;
    return first.length ? first.map((o) => row(o, ids, tz)).join("\n") : "Nothing upcoming of that kind in the next 6 months.";
  }
  if (name === "get_item") {
    const o = ids.get(args?.id);
    if (!o) return `No item ${args?.id}.`;
    const it = o.it;
    return `${row(o, ids, tz)}\nsource: ${it.source ?? "brightspace"}${it.location ? "\nwhere: " + it.location : ""}\ndescription: ${String(it.description ?? "").replace(/https?:\/\/\S+/g, "").slice(0, 600) || "(none)"}`;
  }
  return `Unknown tool ${name}.`;
}

function perDayLine(occ: Occ[]): string {
  const n = new Map<string, number>();
  for (const o of occ) if (o.it.role === "deadline" && !o.it.done && kindOf(o.it) !== "study") n.set(o.day, (n.get(o.day) ?? 0) + 1);
  return [...n].map(([d, k]) => `${strftimeDate(d, "%a %b %-d")}: ${k}`).join(", ");
}

function systemPrompt(items: any[], ids: Ids, tz: string, now: number): string {
  const d = localDate({ t: now, tz }, tz);
  const glance = occurrences(items, d, addDays(d, GLANCE_DAYS - 1), tz, now);
  return `You are Duely, a university student's assistant in a Slack DM. It is ${strftime({ t: now, tz }, "%A %B %-d %Y, %-I:%M %p")} (${tz}).

YOUR WAY OF ANSWERING
- Every fact about their schedule comes from the CALENDAR below or from your tools. Never guess or invent items, dates, times or rooms.
- ALWAYS answer by calling the reply tool. When the answer is a set of calendar items, describe the set in reply.show (when + kinds + courses, or next) and the app lists exactly those items under your message: never choose items one by one, never write their dates, times or titles yourself.
- Copy the student's time words into show.when exactly as they said them ("tomorrow", "this week", "next week", "friday", "on the 9th", "before thursday", "the day after tomorrow"); the app works out the dates. No time said: "next 2 weeks" for things due, "rest of the term" for tests. "When is X?" = next: 1 (+ text with X's name if they named it). Never guess a window they didn't say.
- Kinds: "lectures" = [lecture]. "tutorials" = [tutorial] (timetable) unless they mean hand-ins = [tutorial_work]. "assignments" = [assignment] only. "what's due" / "deadlines" / "homework" / "work" = [work]. Tests/midterms/exams/finals = [test]. Quizzes = [quiz]. "Classes"/"schedule" = [classes]. "What do I have / what's on" = [] (everything). Study blocks = [study] only when they ask about studying/study blocks. "Next X" / "when is my next X" = next: 1.
- For questions about one specific item or advice, you may instead cite ids like [#3] in the message.
- Items marked DONE are finished: don't list them as to-do (you may mention they're done).
- "This week" on a weekday = today to Sunday; on Saturday/Sunday it means the coming week. "Next week" = the week after that. Tomorrow's 11:59 PM deadline is due tomorrow night, not tonight.
- If the CALENDAR doesn't cover the time asked (it shows ${GLANCE_DAYS} days), use search_items or next_items.
- Counting questions: put {n} in your first sentence and describe the set in show.
- If the question is truly ambiguous, reply with ONE short clarifying question (no show).
- Small talk and advice: answer kindly in 1-3 sentences, citing items where useful.
- Stress or feelings about a course ("im stressed about stats", "am i cooked"): be warm and practical, and show what's coming up for that course (or this week): tests first. Never answer feelings with a clarifying question.
- Judgement questions ("which day is busiest", "what should I start first"): answer in your own words using DEADLINES PER DAY and the calendar, e.g. "Friday is the busiest: 3 things due" (no {n}), and show only the items that back it up (e.g. that day's work).
- Questions about what a prof/TA said or posted (announcements, "what's on the test", "any news from …"): call the announcements tool.
- Plain Slack text: no headings, no bold markers, no tables.

CALENDAR (next ${GLANCE_DAYS} days; id | day time | course | kind | title | where/tags):
${glance.map((o) => row(o, ids, tz)).join("\n") || "(nothing)"}

DEADLINES PER DAY (things to hand in, not done): ${perDayLine(glance) || "none"}`;
}

/** The tools in the provider-neutral shape. */
const TOOL_DEFS: Tool[] = TOOLS.map((t) => t.function as Tool);

/** One model call, normalised. */
async function call(llm: LLM, messages: Msg[], tools: boolean): Promise<{ content: string; calls: { id: string; name: string; args: any }[] }> {
  const r = await llm.chat(messages, { ...(tools ? { tools: TOOL_DEFS } : {}), maxTokens: 500, temperature: 0 });
  return { content: r.content, calls: r.toolCalls.map((c) => ({ ...c, args: c.args ?? {} })) };
}

const GROUP = /[[(]\s*#?\d{1,3}(?:\s*(?:,|and|&)\s*#?\d{1,3})*\s*,?\s*[\])]|(?<![\w[])#\d{1,3}\b/g;

/** Words + cited ids -> the Slack reply: the model's sentences, then the cited items by day. */
export function render(answer: string, ids: Ids, tz: string, now: number, shown: Occ[] | null = null): { text: string; rows: Occ[]; refs: string[]; prose: string } {
  if (shown) answer = answer.replace(/\{\s*n\s*\}/g, String(shown.length));
  const cited: Occ[] = [...(shown ?? [])];
  for (const g of answer.match(GROUP) ?? []) {
    for (const n of g.match(/\d{1,3}/g) ?? []) {
      const o = ids.get(n);
      if (o && !cited.includes(o)) cited.push(o);
    }
  }
  const prose = answer
    .split("\n").filter((l) => !/\|.*\|/.test(l)).join("\n")        // calendar rows copied into the text
    .replace(GROUP, "").replace(/\*\*/g, "*").replace(/[ \t]+([,.;:!?])/g, "$1").replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/,(\s*,)+/g, ",").replace(/(:|,)\s*$/gm, (m0, p) => (p === ":" ? "." : "")).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const rows = cited.sort((a, b) => a.t - b.t);
  const out: string[] = [prose];
  const refs: string[] = [];
  let last = "";
  for (const o of rows) {
    if (o.day !== last) { out.push("\n" + dayHeader(o.day, tz, now)); last = o.day; }
    const numbered = o.it.role === "deadline" && o.it.source !== "study" && !o.it.done && !refs.includes(o.it.uid);   // hand-ins only, not tests
    if (numbered) refs.push(o.it.uid);
    out.push(line(o, tz, numbered ? refs.length : undefined));
  }
  if (refs.length) out.push(`\n_Finished one? Reply *done ${refs.length > 1 ? "2" : "1"}* (its number)._`);
  return { text: out.join("\n").trim(), rows, refs, prose };
}

const NOUNS: Record<string, string> = {
  lecture: "lectures", tutorial: "tutorials", lab: "labs", seminar: "seminars", class: "classes", classes: "classes",
  assignment: "assignments", tutorial_work: "tutorials due", lab_work: "labs due", module: "modules", quiz: "quizzes",
  test: "tests", other_work: "deliverables", event: "events", study: "study blocks", work: "deadlines",
};
function nounFor(kinds: unknown): string {
  const ks = (Array.isArray(kinds) ? kinds : []).map((k) => NOUNS[String(k)]).filter(Boolean);
  return ks.length ? ks.join(" or ") : "items";
}

/** A reply the model wrote as text instead of a tool call ('[{"name": "reply", "arguments": {...}}]',
 *  sometimes with holes like '"courses": ,'), or '{show.when: this week, kinds: [study]}'. */
export function replyFromText(content: string): { message: string; show: any } | null {
  const c = content.trim();
  if (/"name"\s*:\s*"reply"/.test(c)) {
    const fixed = c.replace(/:\s*,/g, ": [],").replace(/:\s*}/g, ": null}");
    try {
      const j = JSON.parse(fixed);
      const call = (Array.isArray(j) ? j : [j]).find((x: any) => x?.name === "reply");
      const a = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : call?.arguments ?? call?.parameters;
      if (a) return { message: String(a.message ?? ""), show: a.show ?? null };
    } catch { /* below */ }
    const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(c)?.[1] ?? "";
    const show: any = {};
    const when = /"when"\s*:\s*"([^"]*)"/.exec(c)?.[1];
    if (when) show.when = when;
    const kinds = /"kinds"\s*:\s*\[([^\]]*)\]/.exec(c)?.[1];
    if (kinds) show.kinds = [...kinds.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const courses = /"courses"\s*:\s*\[([^\]]*)\]/.exec(c)?.[1];
    if (courses) show.courses = [...courses.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const next = /"next"\s*:\s*(\d+)/.exec(c)?.[1];
    if (next) show.next = Number(next);
    return message ? { message, show: Object.keys(show).length ? show : null } : null;
  }
  const pseudo = /\{\s*show\.?([^}]*)\}/.exec(c);
  if (pseudo) {
    const body = pseudo[1];
    const show: any = {};
    const when = /when\s*:\s*([^,\]}]+)/.exec(body)?.[1]?.trim();
    if (when) show.when = when.replace(/["']/g, "");
    const kinds = /kinds\s*:\s*\[([^\]]*)\]/.exec(body)?.[1];
    if (kinds) show.kinds = kinds.split(",").map((k) => k.trim().replace(/["']/g, "")).filter(Boolean);
    return { message: c.replace(pseudo[0], "").trim(), show };
  }
  return null;
}

/** Facts in the model's own words that no real item backs: an unknown course code, a clock time no
 *  shown item has, a *bold* name that isn't one of their items. Empty = fine. */
export function unbacked(prose: string, shown: Occ[], items: any[], tz: string): string[] {
  const bad: string[] = [];
  const courses = new Set(items.map((i) => String(i.course ?? "").toUpperCase()).filter(Boolean));
  for (const m of prose.matchAll(/\b([A-Z]{3,4})\s?-?(\d{4})\b/gi)) {
    if (!courses.has(`${m[1].toUpperCase()} ${m[2]}`)) bad.push(`unknown course ${m[0]}`);
  }
  const times = new Set(shown.map((o) => strftime({ t: o.t, tz }, "%-I:%M %p").toLowerCase()));
  for (const m of prose.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\.?\b/gi)) {
    const t = `${Number(m[1])}:${m[2] ?? "00"} ${m[3].toLowerCase()}m`;
    if (!times.has(t)) bad.push(`time ${m[0]} isn't any shown item's`);
  }
  const names = items.map((i) => `${i.course ?? ""} ${i.title ?? ""}`.toLowerCase());
  for (const m of prose.matchAll(/\*([^*\n]{3,80})\*/g)) {
    const words = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
    if (words.length && !names.some((n) => words.filter((w) => n.includes(w)).length >= Math.ceil(words.length * 0.6))) bad.push(`unknown item *${m[1]}*`);
  }
  return bad;
}

/** "1 deadlines" -> "1 deadline", "1 upcoming tutorials" -> "1 upcoming tutorial". */
export function singular(message: string): string {
  return message.replace(/\b(\d+|no) (work|works) due\b/gi, (_, n) => `${n} thing${n === "1" ? "" : "s"} due`).replace(/\b(1|one)(\s+(?:[a-z]+\s+){0,2}?)(deadlines|tutorials|assignments|quizzes|tests|lectures|labs|things|items|classes|modules|events|exams|study blocks|deliverables)\b/gi,
    (_, n, mid, noun: string) => `${n}${mid}${/quizzes$/i.test(noun) ? noun.slice(0, -3) : /classes$/i.test(noun) ? noun.slice(0, -2) : noun.slice(0, -1)}`);
}

const NUM_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** The model's own count ("You have 3 assignments") replaced by the real one when code chose the items. */
export function fixCount(message: string, n: number): string {
  return message.replace(new RegExp(`\\b(\\d{1,2}|${NUM_WORDS.join("|")})(\\s+(?:[a-z]+\\s+){0,2}?(?:things|items|assignments?|deadlines?|quizz(?:es)?|quiz|tests?|exams?|lectures?|tutorials?|labs?|classes|class|modules?|study blocks?|events?|deliverables?))\\b`, "i"),
    (m, num, rest) => {
      const had = /^\d/.test(num) ? Number(num) : NUM_WORDS.indexOf(num.toLowerCase());
      return had === n ? m : `${n === 0 ? "no" : n}${rest}`;
    });
}

/** The student named one specific kind ("assignments", "quizzes", "tests") but the model picked a broader
 *  set: narrow it. On 2026-10-04 "assignments" listing tutorials and modules was a reported bug; the
 *  2026-10-10 live eval still saw it ~1 in 4 times with the model adding quizzes and tutorial hand-ins.
 *  Tutorial / lab *classes* (the timetable) are never their hand-ins (same eval). */
export function narrowKinds(question: string, show: any): any {
  if (!show) return show;
  const q = question.toLowerCase();
  // tutorial / lab / seminar *classes* are the timetable, never their hand-ins
  const cls = /\b(tutorial|lab|seminar)s? (?:class(?:es)?|sections?|sessions?|times?)\b|\b(tutorial|lab|seminar)s? (?:on|in) my (?:timetable|schedule)\b/.exec(q);
  if (cls) return { ...show, kinds: [cls[1] ?? cls[2]] };
  const NAMED: [string, RegExp][] = [["assignment", /\bassignments?\b|\bassigments?\b/], ["quiz", /\bquiz(zes)?\b/], ["test", /\b(tests?|midterms?|exams?|finals?)\b/],
    ["module", /\bmodules?\b/], ["lecture", /\blectures?\b/], ["tutorial", /\btutorials?\b/], ["lab", /\blabs?\b/], ["event", /\bevents?\b/]];
  const named = NAMED.filter(([, re]) => re.test(q)).map(([k]) => k);
  // one clear kind named ("tutorials" / "labs" / "events" can mean classes or hand-ins: the model decides those)
  if (named.length !== 1 || ["tutorial", "lab", "event"].includes(named[0]) || NOT_TEST_RE.test(q)) return show;   // "quiz review session" is an event
  const ks: string[] = Array.isArray(show.kinds) ? show.kinds : [];
  return ks.length === 1 && ks[0] === named[0] ? show : { ...show, kinds: [named[0]] };
}

const TIME_START = /^(next|this|today|tonight|tomorrow|the|before|after|between|from|until|till|by|up|on|in|during|over|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|rest|end|later|\d{1,2}(?:st|nd|rd|th)?)\b/;

/** The time phrase in the student's own words ("…due next week and the week after?" -> "next week and
 *  the week after"), or null. The model sometimes paraphrases it ("next 2 weeks", 2026-10-09 sweep), so
 *  when the question has a specific one, it wins. Longest trailing phrase that starts with a time word
 *  and means something specific. */
export function whenFromQuestion(question: string, tz: string, now: number): string | null {
  const q = question.toLowerCase().replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim();
  const words = q.split(" ");
  const d = localDate({ t: now, tz }, tz);
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i).join(" ").replace(/^(in|on|during|over) (?=(the )?(next|this|\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/, "");
    if (!TIME_START.test(tail) || /^(the|in|on|up|by)$/.test(tail)) continue;
    // "the" only starts a time phrase as "the next…", "the 9th", "the week after", "the weekend", "the rest…"
    if (/^the\b/.test(tail) && !/^the (next|following|\d+(?:st|nd|rd|th)?|day|week|weekend|end|rest|first|last)\b/.test(tail)) continue;
    const wins = resolveWindows(tail, tz, now);
    const isDefault = wins.length === 1 && wins[0][0] === d && wins[0][1] === addDays(d, 14) && !/2 weeks|two weeks|14 days|fortnight/.test(tail);
    if (!isDefault) return tail;
  }
  return null;
}

/** "when are my midterms" / "when are my tests" (plural, no "next"): all of them this term, not just the
 *  soonest (2026-10-09 sweep: only Test 1 of 2). */
export function pluralNext(question: string, show: any): any {
  if (!show?.next || Number(show.next) !== 1) return show;
  const q = question.toLowerCase();
  if (/\b(next|soonest|upcoming one|first)\b/.test(q)) return show;
  if (!/\b(tests|midterms|exams|finals|quizzes|assignments|labs|tutorials|lectures|deadlines)\b/.test(q)) return show;
  const { next, ...rest } = show;
  return { ...rest, when: "rest of the term" };
}

/** Stress about a course ("im stressed about stats", "worried about 2406"): show what's coming for it,
 *  tests first, whatever the model picked (2026-10-09 eval: it listed the course's lectures). */
export function feelingsShow(question: string, show: any): any {
  if (!/\b(stress(ed|ing)?|worried|worry|anxious|panick?(ing)?|overwhelm(ed)?|scared|nervous|cooked|freaking out)\b/i.test(question)) return show;
  if (!show) return show;
  const courses = Array.isArray(show.courses) ? show.courses : [];
  return { ...(courses.length ? { courses } : {}), kinds: ["test", "work"], when: courses.length ? "next 3 weeks" : show.when ?? "this week" };
}

export type AgentAI = { llm?: LLM; deadline?: number; budgetLeft?: () => boolean; spend?: () => void };

/** The agent's answer, or null when it can't give a checked one (the caller falls back to v1). */
export async function agentReply(text: string, items: any[], tz: string, now: number, turns: Turn[], ai: AgentAI): Promise<AgentResult | null> {
  if (!ai.llm) return null;
  if (ai.budgetLeft && !ai.budgetLeft()) return null;
  try {
    return await runAgent(text, items, tz, now, turns, ai, ai.llm);
  } catch {
    return null;                                                     // busy / over budget / bad output: the rules answer
  }
}

async function runAgent(text: string, items: any[], tz: string, now: number, turns: Turn[], ai: AgentAI, llm: LLM): Promise<AgentResult | null> {
  const ids = new Ids();
  const messages: Msg[] = [{ role: "system", content: systemPrompt(items, ids, tz, now) }];
  for (const t of turns.slice(-3)) messages.push({ role: "user", content: t.q }, { role: "assistant", content: t.said.slice(0, 600) });
  messages.push({ role: "user", content: text.slice(0, 800) });
  const left = () => (ai.deadline ?? Infinity) - Date.now();
  let repaired = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (left() < 2500) return null;
    const r = await Promise.race([
      call(llm, messages, step < MAX_STEPS - 1),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out")), Math.min(12000, left() - 1000))),
    ]);
    ai.spend?.();
    const ann = r.calls.find((c) => c.name === "announcements");
    if (ann) return { text: "", rows: [], refs: [], handoff: { courses: (Array.isArray(ann.args?.courses) ? ann.args.courses : []).map(String), topic: String(ann.args?.topic ?? "") } };
    let rep: { args: any } | undefined = r.calls.find((c) => c.name === "reply");
    if (!rep && !r.calls.length) { const t = replyFromText(r.content); if (t) rep = { args: t }; }
    // plain text is only an answer if it reads like one (not JSON scraps or a broken tool call)
    const prose = !rep && !r.calls.length && /^[^{[<]/.test(r.content.trim()) && /[a-z]{2,}\s+[a-z]{2,}/i.test(r.content);
    if (!rep && !r.calls.length && !prose) return null;
    if (rep || prose) {
      // the answer: message + (code-selected) items
      let message = String(rep ? rep.args?.message ?? "" : r.content).trim();
      const show0 = pluralNext(text, feelingsShow(text, narrowKinds(text, rep?.args?.show && typeof rep.args.show === "object" && Object.keys(rep.args.show).length ? rep.args.show : null)));
      const own = show0 && !show0.next ? whenFromQuestion(text.split("\n(cleaned up:")[0], tz, now) : null;
      const show = own && show0 ? { ...show0, when: own } : show0;     // the student's own time words win
      const codeDays: string[] = [];                               // dates written by code, not the model
      let shown = show ? select(show, items, tz, now).occ : null;
      if (show?.text && shown && !shown.length) {                  // their word isn't in any title ("midterm"): kinds decide
        const without = select({ ...show, text: undefined }, items, tz, now).occ;
        if (without.length && (show.kinds?.length || show.courses?.length)) shown = without;
      }
      if (shown) message = fixCount(message.replace(/\{\s*n\s*\}/g, String(shown.length)), shown.length);
      message = singular(message);
      if (show && shown && !shown.length) {
        // nothing in that window: code says so (the model's words can't be trusted on an empty set)
        // and shows the next ones of that kind, whatever window the model picked
        const wins = show.next ? [] : resolveWindows(show.when, tz, now);
        const [from, to] = show.next ? ["", ""] : [wins.map((x) => x[0]).sort()[0], wins.map((x) => x[1]).sort().at(-1)!];
        const range = show.next ? "coming up" : describeRange(from, to, tz, now);
        if (!show.next) codeDays.push(from, to);
        const after = show.next ? now : Date.parse(addDays(to, 1) + "T00:00:00Z") + 5 * 3600e3;   // the next ones after that window
        let later = select({ ...show, when: undefined, next: 3 }, items, tz, after).occ;
        if (!later.length && show.text) later = select({ ...show, text: undefined, when: undefined, next: 3 }, items, tz, after).occ;   // "midterm" vs "Test 1"
        const noun = nounFor(show.kinds);
        message = later.length ? `No ${noun} ${range}. Here's what's next.` : `No ${noun} ${range}. 🎉`;
        shown = later;
      }
      const out = render(message, ids, tz, now, shown?.slice(0, 25) ?? null);
      if (!out.prose && !out.rows.length) return null;
      const d = localDate({ t: now, tz }, tz);
      const g = guard(out.prose, out.rows.map((o): GuardItem => ({ title: o.it.title, course: o.it.course, day: o.day })), d,
        [...ids.occ.map((o) => o.day), ...(shown ?? []).map((o) => o.day), ...codeDays], { maxLines: 6, maxChars: 900 });
      const problems = [...g.unknownDates.map((x) => `date ${x}`), ...unbacked(out.prose, out.rows, items, tz)];
      if (problems.length) {
        if (repaired) return null;
        repaired = true;
        messages.push({ role: "assistant", content: message },
          { role: "user", content: `Your answer mentions things that aren't in the calendar (${problems.slice(0, 3).join("; ")}). Call reply again: only real items, described in show or cited as [#n]; no dates or times in your words.` });
        continue;
      }
      return { text: g.text === out.prose ? out.text : out.text.replace(out.prose, g.text), rows: out.rows, refs: out.refs };
    }
    if (r.calls.length) {
      messages.push({ role: "assistant", content: r.content || "", toolCalls: r.calls });
      for (const c of r.calls.slice(0, 4)) messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: runTool(c.name, c.args, items, ids, tz, now) });
      continue;
    }
    return null;
  }
  return null;
}
