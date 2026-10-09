// Study blocks: plan work sessions in the days before assignments, labs and tests, as ordinary
// calendar items (type "study"), so the normal diff adds, moves and removes them.
//
// Since 2026-10-08 (ask before acting) a plan only reaches the calendar once the user says yes to
// it in Slack: `studyPlans()` suggests, actions.ts saves accepted plans in KV "study" (times frozen
// at that moment), and `renderPlans()` turns accepted plans into calendar items.
//
// Placement works back from the due date (latest free slot first) and doesn't depend on "now",
// so blocks don't drift as time passes; only future blocks are emitted (past ones stay in the
// calendar as a record). Duely only sees its own calendar, so blocks avoid classes and other
// Duely events, not personal ones.
import type { Item } from "./classify.ts";
import { occurrences } from "./ask.ts";
import { category } from "./kinds.ts";
import { addDays, localDate, strftime, zoned } from "./time.ts";
import type { Store } from "./util.ts";

export const STUDY_DEFAULTS = {
  study_blocks: false,
  study_hours: { assignment: 4, lab: 3, test: 6 } as Record<string, number>,
  study_block_hours: 2,
  study_window_days: 7,
  study_day: ["09:00", "21:00"],
};
const PREFERRED = ["18:00", "15:00", "10:00", "13:00", "19:30"];
const HORIZON_DAYS = 21;

const iso = (s: any) => (typeof s === "string" && s.includes("T") ? Date.parse(s) : NaN);
const dueOf = (it: any) => iso(it.role === "deadline" ? it.end ?? it.start : it.start);

export type StudyPlan = {
  uid: string;                       // the assignment / lab / test it's for
  course: string; title: string; kind: "assignment" | "lab" | "test"; url?: string;
  due: number;
  blocks: { s: number; e: number }[];
};
export type StudyState = { approved: Record<string, StudyPlan> };

export async function loadStudy(store: Store): Promise<StudyState> {
  const st = (await store.get<StudyState>("study")) ?? { approved: {} };
  return { approved: st.approved ?? {} };
}

/** Written only by actions.ts, after the user said yes. */
export async function saveStudy(store: Store, st: StudyState): Promise<void> {
  await store.put("study", st);
}

/** Suggested plans for work due in the next 3 weeks (`items` serialised, carrying `done`).
 *  Each plan has all its blocks, past ones included, so it doesn't change as time passes. */
export function studyPlans(items: any[], cfg: any, tz: string, now = Date.now()): StudyPlan[] {
  if (!cfg.study_blocks) return [];
  const o = { ...STUDY_DEFAULTS, ...cfg, study_hours: { ...STUDY_DEFAULTS.study_hours, ...(cfg.study_hours ?? {}) } };
  const blockMs = Math.max(0.5, Number(o.study_block_hours) || 2) * 3600e3;
  const [dayStart, dayEnd] = (o.study_day as string[]).map((s) => s.split(":").map(Number));
  const today = localDate({ t: now, tz }, tz);

  // busy time: every non-deadline occurrence (classes, events, tests) over the planning horizon
  const busy: [number, number][] = [];
  const back = Number(o.study_window_days) + 1;
  for (const occ of occurrences(items.filter((i) => i.source !== "study"), addDays(today, -back), addDays(today, HORIZON_DAYS + 1), tz, now - back * 86400e3)) {
    if (occ.allDay || occ.it.role === "deadline") continue;
    const dur = (iso(occ.it.end) - iso(occ.it.start)) || 3600e3;
    busy.push([occ.t, occ.t + Math.max(dur, 15 * 60e3)]);
  }
  const free = (s: number, e: number) => !busy.some(([a, b]) => s < b && a < e);

  const targets = items
    .filter((it) => it.keep !== false && !it.done && it.source !== "study"
      && ["assignment", "lab", "test"].includes(category(it)) && o.study_hours[category(it)] > 0)
    .map((it) => ({ it, due: dueOf(it) }))
    .filter(({ due }) => due > now && due <= now + HORIZON_DAYS * 86400e3)
    .sort((a, b) => a.due - b.due || String(a.it.uid).localeCompare(String(b.it.uid)));

  const out: StudyPlan[] = [];
  for (const { it, due } of targets) {
    const want = Math.ceil(o.study_hours[category(it)] / (blockMs / 3600e3));
    const dueDay = localDate({ t: due, tz }, tz);
    const blocks: { s: number; e: number }[] = [];
    // pass 1: at most one block a day (spread out); pass 2: fill up if there weren't enough free days
    for (const perDay of [1, Infinity]) {
      for (let off = 0; off <= Number(o.study_window_days) && blocks.length < want; off++) {
        const day = addDays(dueDay, -off);
        const [y, mo, d] = day.split("-").map(Number);
        let today_ = 0;
        for (const hm of PREFERRED) {
          if (blocks.length >= want || today_ >= perDay) break;
          const [h, mi] = hm.split(":").map(Number);
          if (h * 60 + mi < dayStart[0] * 60 + dayStart[1]) continue;
          const s = zoned(y, mo, d, h, mi, 0, tz).t;
          const e = s + blockMs;
          const endLocal = zoned(y, mo, d, dayEnd[0], dayEnd[1], 0, tz).t;
          if (e > endLocal || e > due - 3600e3 || !free(s, e)) continue;   // finish an hour before it's due
          busy.push([s, e]);
          blocks.push({ s, e });
          today_++;
        }
      }
    }
    if (blocks.length) {
      out.push({ uid: String(it.uid), course: it.course ?? "", title: it.title, kind: category(it) as StudyPlan["kind"], url: it.url ?? "", due, blocks });
    }
  }
  return out;
}

/** Calendar items for accepted plans: future blocks only (past ones stay in the calendar as a record),
 *  none for work marked done. Uids keep the old `study:<uid>:<n>` form, so existing events are kept. */
export function renderPlans(plans: StudyPlan[], items: any[], tz: string, now = Date.now()): Item[] {
  const done = new Set(items.filter((i) => i.done).map((i) => String(i.uid)));
  const out: Item[] = [];
  for (const p of plans) {
    if (done.has(p.uid)) continue;
    // you study for a test, but work on an assignment or lab
    const [icon, verb] = p.kind === "test" ? ["📖", "Study for: "] : ["📝", "Work on: "];
    p.blocks.forEach(({ s, e }, i) => {
      if (s < now) return;                                             // planned earlier, already past
      out.push({
        uid: `study:${p.uid}:${i + 1}`, raw_title: `${verb}${p.title}`, title: `${icon} ${verb}${p.title}`, course: p.course,
        role: "event", type: "study", start: { t: s, tz }, end: { t: e, tz }, all_day: false, opens: null,
        description: `Planned by Duely for ${p.course ? p.course + " " : ""}${p.title}. Mark it done in Slack ("done …") to remove these.`,
        location: "", url: p.url ?? "", rrule: "", keep: true, reason: "", source: "study",
      } as Item);
    });
  }
  return out;
}

/** Every suggested block as calendar items (the planner on its own; the sync renders accepted plans only). */
export function studyItems(items: any[], cfg: any, tz: string, now = Date.now()): Item[] {
  return renderPlans(studyPlans(items, cfg, tz, now), items, tz, now);
}

/** "Wed Oct 7 6–8 PM" lines for a proposal. */
export function describeBlocks(p: StudyPlan, tz: string, now = Date.now()): string {
  return p.blocks.filter((b) => b.s >= now)
    .map((b) => `${strftime({ t: b.s, tz }, "%a %b %-d, %-I:%M")}–${strftime({ t: b.e, tz }, "%-I:%M %p")}`).join(" · ");
}
