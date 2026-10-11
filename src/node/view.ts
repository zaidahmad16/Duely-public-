// What the UI shows, computed from the engine's data: Upcoming's groups, the open questions, and a
// chat answer split into prose + rows. Plain Node (tested in test/view.test.ts).
import type { Action } from "../core/actions.ts";
import { type Occ, occurrences } from "../core/ask.ts";
import { category } from "../core/kinds.ts";
import { addDays, localDate, weekday } from "../core/time.ts";
import type { Category, ChatMessage, Question, Row, Upcoming } from "../shared/types.ts";
import type { LogEntry } from "./chatlog.ts";

const LABEL: Record<Category, string> = {
  assignment: "Assignment", tutorial: "Tutorial", lab: "Lab", module: "Module", quiz: "Quiz", test: "Test",
  other: "Assignment", event: "Event", class: "Class", study: "Study",
};

export function toRow(o: Occ, done: Record<string, number>): Row {
  const it = o.it;
  const cat = category(it) as Category;
  const deadline = it.role === "deadline";
  const endT = !deadline && typeof it.end === "string" && it.end.includes("T") ? Date.parse(it.end) : NaN;
  // a repeating event's end is on its first day: carry the length over to this occurrence
  const startT = typeof it.start === "string" && it.start.includes("T") ? Date.parse(it.start) : NaN;
  const end = Number.isFinite(endT) && Number.isFinite(startT) && endT > startT ? o.t + (endT - startT) : undefined;
  return {
    key: `${it.uid}@${o.day}`, uid: String(it.uid), course: String(it.course ?? ""), title: String(it.title ?? ""),
    category: cat, label: LABEL[cat], t: o.t, end, allDay: o.allDay, day: o.day, deadline,
    done: !!done[it.uid], location: it.location || undefined, url: it.url || undefined,
    announced: !!it.announced,
  };
}

/** Today / the rest of this week (to Sunday) / next week. Classes only today (they'd swamp the
 *  week views); finished work is left out (it's ticked off). */
export function upcoming(items: any[], done: Record<string, number>, actions: Action[], tz: string, now = Date.now()): Upcoming {
  const today = localDate({ t: now, tz }, tz);
  const sunday = addDays(today, 6 - weekday(today));                // weekday(): Monday = 0
  const nextSunday = addDays(sunday, 7);
  const rows = occurrences(items, today, nextSunday, tz, now)
    .map((o) => toRow(o, done))
    .filter((r) => !r.done && (r.category !== "class" || r.day === today))
    .filter((r) => (r.deadline || r.allDay ? true : (r.end ?? r.t) >= now))   // a class that's over is gone
    .sort((a, b) => a.t - b.t || a.title.localeCompare(b.title));
  return {
    tz, now,
    today: rows.filter((r) => r.day === today),
    thisWeek: rows.filter((r) => r.day > today && r.day <= sunday),
    nextWeek: rows.filter((r) => r.day > sunday),
    filtered: items.filter((it) => it.keep === false && when(it) >= now)
      .map((it) => ({ uid: String(it.uid), course: String(it.course ?? ""), title: String(it.title ?? ""), reason: String(it.reason ?? "") })),
    questions: actions.filter((a) => a.status === "proposed").sort((a, b) => a.created - b.created).map(question),
  };
}

const when = (it: any) => {
  const s = String(it.end ?? it.start ?? "");
  return s.includes("T") ? Date.parse(s) : Date.parse(s + "T23:59:59Z") || 0;
};

/** Slack-style summary -> a plain sentence (the UI does its own emphasis). */
export const plain = (s: string) => s.replace(/^[^\p{L}\p{N}*]+/u, "").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").trim();

const nameOf = (it: any) => `${it.title ?? ""}`.trim() || "An item";

export function question(a: Action): Question {
  if (a.type === "keep_vanished") {
    const its: any[] = a.args?.items ?? [];
    const one = its.length === 1;
    return {
      id: a.id, kind: "vanished",
      title: one ? `${its[0].course ? its[0].course + " " : ""}${nameOf(its[0])} disappeared from Brightspace` : `${its.length} items disappeared from Brightspace at once`,
      body: one ? "Would you like Duely to keep it on your calendar?" : "That usually means the feed broke, so Duely is keeping them for now. Keep them on your calendar?",
      buttons: ["keep", "remove"],
    };
  }
  if (a.type === "add_study_blocks") {
    const p = a.args?.plan ?? {};
    const hours = (p.blocks ?? []).reduce((h: number, b: any) => h + (b.e - b.s) / 3600e3, 0);
    return {
      id: a.id, kind: "study", title: `Study for ${p.course ? p.course + " " : ""}${p.title ?? a.args?.name ?? "this"}`,
      body: `Duely found ${hours === 1 ? "an hour" : `${+hours.toFixed(1)} hours`} you could use before it's due.`,
      buttons: ["add", "notnow", "change"], blocks: p.blocks ?? [], due: p.due,
    };
  }
  if (a.type === "keep_study_blocks") {
    return { id: a.id, kind: "keep_study", title: "Keep the study blocks already in your calendar?", body: "From now on Duely asks before adding any.", buttons: ["keep", "remove"] };
  }
  return { id: a.id, kind: "done", title: plain(a.summary), body: "", buttons: ["yes", "no"] };
}

/** A chat answer as the UI shows it: when rows came with it, the numbered list, its day headers and
 *  the "reply done 2" hint are dropped from the text (the rows are shown as real rows instead). */
export function chatText(text: string, hasRows: boolean): string {
  if (!hasRows) return text.trim();
  const lines = text.split("\n").filter((l) => {
    const s = l.trim();
    if (/^(\d+\.|•)\s/.test(s)) return false;                                      // list items
    if (/^\*(Today|Tonight|Tomorrow|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^*]*\*$/.test(s)) return false;   // day headers
    if (/^_?Finished one\?/.test(s)) return false;
    return true;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The rows a chat answer listed ({uid, day} from the engine's onList), as UI rows. */
export function rowsFor(items: any[], picks: { uid: string; day: string }[], done: Record<string, number>, tz: string, now = Date.now()): Row[] {
  const out: Row[] = [];
  for (const p of picks) {
    const its = items.filter((it) => it.uid === p.uid);
    const o = occurrences(its, p.day, p.day, tz, now - 7 * 864e5)[0];   // a past-due row still shows
    if (o) out.push(toRow(o, done));
  }
  return out;
}

const OUTCOME: Record<string, string> = { executed: "Done", declined: "Skipped", expired: "Expired", reverted: "Undone" };

/** Questions a message answered: proposed before, something else after ("yes" → Done, "no" → Skipped). */
export function resolvedBetween(before: Record<string, Action>, after: Record<string, Action>): { id: string; word: string }[] {
  return Object.values(before).filter((a) => after[a.id] && after[a.id].status !== a.status && OUTCOME[after[a.id].status])
    .map((a) => ({ id: a.id, word: OUTCOME[after[a.id].status] }));
}

/** The saved chat as the window shows it: rows from today's items and done marks, each question live or settled. */
export function chatHistory(log: LogEntry[], items: any[], done: Record<string, number>, actions: Record<string, Action>, tz: string, now = Date.now()): ChatMessage[] {
  return log.map((e) => {
    const ids = e.actionIds ?? [];
    return {
      id: e.id, at: e.at, who: e.who, text: e.text,
      rows: e.picks?.length ? rowsFor(items, e.picks, done, tz, now) : [],
      questions: ids.filter((id) => actions[id]?.status === "proposed").map((id) => question(actions[id])),
      resolved: ids.filter((id) => actions[id] && actions[id].status !== "proposed").map((id) => ({ id, word: OUTCOME[actions[id].status] ?? "Done" })),
    };
  });
}
