// What the sync proposes and puts in the calendar for study blocks (ask before acting, §5.3).
// Accepted plans are rendered; new work gets a Slack proposal (at most a few per run, once each);
// the blocks added before Duely asked stay until the user answers a one-time "keep them?".
import { type Action, type Draft, knownKeys } from "./actions.ts";
import { type StudyPlan, describeBlocks, loadStudy, studyPlans } from "./study.ts";
import { strftime } from "./time.ts";
import type { Store } from "./util.ts";

const MAX_NEW_PER_RUN = 3;
export const ROLLOUT_KEY = "study-rollout";

export type StudySync = { render: StudyPlan[]; fresh: Draft[]; sig: string };

/** `items` serialised with done marks; `hadBlocks` = the last sync put study blocks in the calendar. */
export async function studyForSync(store: Store, items: any[], cfg: any, tz: string, hadBlocks: boolean, now = Date.now()): Promise<StudySync> {
  if (!cfg.study_blocks) return { render: [], fresh: [], sig: "off" };
  const st = await loadStudy(store);
  const known = await knownKeys(store, now);
  const suggested = studyPlans(items, cfg, tz, now);
  const fresh: Draft[] = [];
  let roll = known.get(ROLLOUT_KEY);
  if (!roll && hadBlocks && !Object.keys(st.approved).length) {
    // the blocks added before asking: same planner, same data, so the same blocks as in the calendar
    const plans = suggested.filter((p) => p.blocks.some((b) => b.s >= now));
    const n = plans.reduce((k, p) => k + p.blocks.filter((b) => b.s >= now).length, 0);
    if (plans.length) {
      fresh.push({
        type: "keep_study_blocks", key: ROLLOUT_KEY, args: { plans },
        summary: `I added ${n} study block${n === 1 ? "" : "s"} to your calendar before I started asking first (for ${plans.map((p) => `${p.course} ${p.title}`).join(", ")}). Keep them?`,
      });
      roll = { status: "proposed", args: { plans } } as Action;
    }
  }
  const waiting = roll?.status === "proposed" ? (roll.args.plans as StudyPlan[]) : [];
  const render = [...Object.values(st.approved), ...waiting];
  const covered = new Set(render.map((p) => p.uid));
  if (roll?.status !== "proposed") {
    for (const p of suggested) {
      if (fresh.length >= MAX_NEW_PER_RUN) break;
      if (covered.has(p.uid) || known.has(`study:${p.uid}`) || !p.blocks.some((b) => b.s >= now)) continue;
      const dueWord = p.kind === "test" ? "is on" : "is due";
      fresh.push({
        type: "add_study_blocks", key: `study:${p.uid}`, args: { plan: p, name: `${p.course ? p.course + ": " : ""}${p.title}` },
        summary: `*${p.course ? p.course + " " : ""}${p.title}* ${dueWord} ${strftime({ t: p.due, tz }, "%a %b %-d, %-I:%M %p")}. `
          + `Add ${p.kind === "test" ? "study" : "work"} blocks to your calendar? ${describeBlocks(p, tz, now)}`,
      });
    }
  }
  const sig = [...covered].sort().join(",") + "|" + (roll?.status ?? "");
  return { render, fresh, sig };
}

/** Fingerprint of every decision that changes what's in the calendar (study blocks, email dates),
 *  for the sync's change detection: a yes, a no or an undo shows up within a minute. */
export async function decisionsKey(store: Store): Promise<string> {
  const st = await loadStudy(store);
  const ev = (await store.get<Record<string, unknown>>("email-events")) ?? {};
  const acts = (await store.get<Record<string, Action>>("actions")) ?? {};
  const decided = Object.values(acts).filter((a) => ["add_study_blocks", "keep_study_blocks", "add_email_event", "keep_vanished"].includes(a.type))
    .map((a) => `${a.key}:${a.status}`).sort();
  return [...Object.keys(st.approved).sort(), ...Object.keys(ev).sort(), ...decided].join(",");
}
