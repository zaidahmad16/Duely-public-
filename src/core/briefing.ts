// Test-eve briefing (19:00 local, the evening before a test): when and where, what the prof said it
// covers (the course's recent posts, real links), and the study blocks for it. Once per test.
// KV "briefed" {"uid@day": sentAt}, 120 days.
import { type AI, type Occ, announcementAnswer, occurrences } from "./ask.ts";
import { category } from "./kinds.ts";
import type { StudyState } from "./study.ts";
import { addDays, localDate, strftime } from "./time.ts";

const COURSE_ROOM = /^[A-Z]{3,4}\s?\d{4}/;

/** Tests tomorrow (not done). */
export function testsOn(items: any[], day: string, tz: string, now: number): Occ[] {
  return occurrences(items, day, day, tz, now).filter((o) => category(o.it) === "test" && !o.it.done && o.it.source !== "study");
}

export async function briefingText(o: Occ, items: any[], cfg: any, ai: AI, f: typeof fetch, now: number, tz: string, study: StudyState): Promise<string> {
  const it = o.it;
  const name = `${it.course ? it.course + " " : ""}${it.title}`;
  const end = typeof it.end === "string" && it.end.includes("T") ? Date.parse(it.end) : NaN;
  const time = o.allDay ? "all day" : strftime({ t: o.t, tz }, "%-I:%M") + (end > o.t ? `–${strftime({ t: end, tz }, "%-I:%M %p")}` : strftime({ t: o.t, tz }, " %p"));
  const room = String(it.location ?? "").trim();
  const lines = [`📝 *Tomorrow: ${name}*`, `🕙 ${strftime({ t: o.t, tz }, "%a %b %-d")}, ${time}`,
    room && !COURSE_ROOM.test(room) ? `📍 ${room}` : "📍 Room not announced yet (I'll message you if it's posted)"];
  try {
    const said = await announcementAnswer(it.course ? [it.course] : [], it.title, `What does ${it.title} cover, and what should I bring or know for it?`, items, cfg, ai, f, now, tz);
    const clean = said.replace(/^\*Recent announcements[^\n]*\n/, "").replace(/\s*\[(missing information|not specified|unknown)\]/gi, "");
    if (said && !/^No announcements/.test(said)) lines.push("", "*What the prof said:*", clean);
  } catch { /* the briefing still goes out */ }
  const blocks = (study.approved?.[it.uid]?.blocks ?? []).filter((b) => b.s < o.t).sort((a, b) => a.s - b.s);
  const left = blocks.filter((b) => b.e > now);
  if (blocks.length) lines.push("", left.length ? `📖 Study block${left.length === 1 ? "" : "s"} left: ${left.map((b) => strftime({ t: b.s, tz }, "%a %-I:%M %p")).join(", ")}` : `📖 You had ${blocks.length} study block${blocks.length === 1 ? "" : "s"} for it.`);
  lines.push("", "Good luck! 🍀");
  return lines.join("\n");
}

/** From the minute tick: 19:00 to `until` local, one briefing per test tomorrow, once. */
export async function maybeBriefing(store: { get<T>(k: string): Promise<T | null>; put(k: string, v: unknown): Promise<void> },
  cfg: any, tz: string, now: number, ai: AI, post: (text: string) => Promise<void>, f: typeof fetch = fetch, until = "19:30"): Promise<number> {
  const hm = strftime({ t: now, tz }, "%H:%M");
  if (hm < "19:00" || hm >= until) return 0;
  const tomorrow = addDays(localDate({ t: now, tz }, tz), 1);
  const items: any[] = ((await store.get<any>("state")) ?? {}).items ?? [];
  const done = (await store.get<Record<string, number>>("done")) ?? {};
  const marked = items.map((it) => (done[it.uid] ? { ...it, done: true } : it));
  const due = testsOn(marked, tomorrow, tz, now);
  if (!due.length) return 0;
  const briefed = (await store.get<Record<string, number>>("briefed")) ?? {};
  const todo = due.filter((o) => !briefed[`${o.it.uid}@${o.day}`]);
  if (!todo.length) return 0;
  const study = (await store.get<StudyState>("study")) ?? { approved: {} };
  for (const o of todo) { briefed[`${o.it.uid}@${o.day}`] = now; }
  const kept: Record<string, number> = {};
  for (const [k, v] of Object.entries(briefed)) if (now - v < 120 * 864e5) kept[k] = v;
  await store.put("briefed", kept);                                // claim first: never twice
  for (const o of todo) await post(await briefingText(o, marked, cfg, ai, f, now, tz, study));
  return todo.length;
}
