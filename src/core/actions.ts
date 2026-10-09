// Ask before acting (design §5.3). Anything that changes the user's data (done marks, study
// blocks) is an action: proposed -> (yes) executed -> (undo within 10 min) reverted, or
// proposed -> (no) declined, or proposed -> (24 h) expired. Only `decide` / `record` execute, and the
// action record is saved BEFORE the data it changes, so every user-data write has a yes behind it
// (R3; checked at runtime by test/actions.test.ts and statically by test/write_safety.test.ts).
// KV "actions" ({id: Action}); one write per decision (KV allows one write per key per second).
import { loadDone, saveDone } from "./done.ts";
import { type StudyPlan, loadStudy, saveStudy } from "./study.ts";
import { lastWhen } from "./vanished.ts";
import type { Store } from "./util.ts";

export type ActionType = "mark_done" | "undo_done" | "add_study_blocks" | "keep_study_blocks" | "keep_vanished";
export type Status = "proposed" | "executed" | "declined" | "expired" | "reverted";
export type Action = {
  id: string;
  type: ActionType;
  /** never propose the same thing twice: one action per key, whatever became of it */
  key: string;
  args: any;
  summary: string;
  status: Status;
  created: number;
  decided?: number;
  /** how the yes/no came: a Slack button, a typed reply, or the user's own command ("done 2") */
  by?: "button" | "text" | "command";
  /** several done in one go (checkboxes): undo takes back the whole batch */
  batch?: string;
};
type Actions = Record<string, Action>;

const EXPIRE_MS = 24 * 3600e3;
export const UNDO_MS = 10 * 60e3;
const KEEP_MS = 30 * 86400e3;

export async function loadActions(store: Store, now = Date.now()): Promise<Actions> {
  const all = (await store.get<Actions>("actions")) ?? {};
  for (const a of Object.values(all)) if (a.status === "proposed" && now - a.created > EXPIRE_MS) { a.status = "expired"; a.decided = a.created + EXPIRE_MS; }
  return all;
}

async function saveActions(store: Store, all: Actions, now: number): Promise<void> {
  const kept: Actions = {};
  for (const [id, a] of Object.entries(all)) {
    // a kept vanished item lives in its action record: keep that until the item's date has passed
    if (a.status === "proposed" || now - (a.decided ?? a.created) < KEEP_MS || (a.type === "keep_vanished" && lastWhen(a) > now)) kept[id] = a;
  }
  await store.put("actions", kept);
}

const newId = (now: number) => now.toString(36) + Math.random().toString(36).slice(2, 6);

export type Draft = { type: ActionType; key: string; args: any; summary: string };

/** New proposals (one KV write for all). Keys that were ever proposed are skipped: a "no", or no
 *  answer in 24 h, is final (no nagging). */
export async function propose(store: Store, drafts: Draft[], now = Date.now()): Promise<Action[]> {
  const all = await loadActions(store, now);
  const seen = new Set(Object.values(all).map((a) => a.key));
  const made: Action[] = [];
  for (const d of drafts) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    const a: Action = { ...d, id: newId(now) + made.length, status: "proposed", created: now };
    all[a.id] = a;
    made.push(a);
  }
  if (made.length) await saveActions(store, all, now);
  return made;
}

/** Every key ever proposed (whatever became of it), so callers don't ask again. */
export async function knownKeys(store: Store, now = Date.now()): Promise<Map<string, Action>> {
  const all = await loadActions(store, now);
  return new Map(Object.values(all).map((a) => [a.key, a]));
}

/** The newest proposal still waiting for an answer. */
export async function pendingAction(store: Store, now = Date.now()): Promise<Action | null> {
  const open = Object.values(await loadActions(store, now)).filter((a) => a.status === "proposed");
  return open.sort((a, b) => b.created - a.created)[0] ?? null;
}

export type Decision = { action: Action | null; text: string };

/** Yes or no to a proposal (by id; null = the newest open one). */
export async function decide(store: Store, id: string | null, yes: boolean, by: "button" | "text", now = Date.now(),
  /** a yes with changes ("Change times"): replaces these args in the same single write */
  override?: Record<string, unknown>): Promise<Decision> {
  const all = await loadActions(store, now);
  const a = id ? all[id] : Object.values(all).filter((x) => x.status === "proposed").sort((x, y) => y.created - x.created)[0];
  if (!a) return { action: null, text: "There's nothing waiting for a yes or no." };
  if (a.status !== "proposed") return { action: a, text: `Already ${STATUS_WORD[a.status]}: ${a.summary}` };
  a.decided = now; a.by = by;
  if (override && yes) a.args = { ...a.args, ...override };
  if (!yes) {
    a.status = "declined";
    await saveActions(store, all, now);
    return { action: a, text: DECLINED[a.type](a) };
  }
  a.status = "executed";
  await saveActions(store, all, now);          // the yes is on record before anything changes
  await execute(store, a, now);
  return { action: a, text: DONE_TEXT[a.type](a) };
}

/** The user's own explicit command ("done 2"): recorded as a yes and carried out at once. */
export async function record(store: Store, d: Draft, now = Date.now()): Promise<Decision> {
  const all = await loadActions(store, now);
  const a: Action = { ...d, key: `${d.key}#${now}`, id: newId(now), status: "executed", created: now, decided: now, by: "command" };
  all[a.id] = a;
  await saveActions(store, all, now);
  await execute(store, a, now);
  return { action: a, text: DONE_TEXT[a.type](a) };
}

/** Several items ticked done at once (Slack checkboxes): the user's own explicit action, so recorded
 *  and carried out at once, as one batch. One write to "actions", one to "done" (KV: 1 write/key/s). */
export async function recordDone(store: Store, picks: { uid: string; name: string }[], now = Date.now()): Promise<Decision> {
  if (!picks.length) return { action: null, text: "Nothing was ticked." };
  const all = await loadActions(store, now);
  const batch = newId(now);
  const made: Action[] = picks.map((p, i) => ({ id: `${batch}${i}`, type: "mark_done", key: `mark_done:${p.uid}#${now}`, args: { uid: p.uid, name: p.name },
    summary: `Mark *${p.name}* done`, status: "executed", created: now, decided: now, by: "button", batch }));
  for (const a of made) all[a.id] = a;
  await saveActions(store, all, now);
  const done = await loadDone(store);
  for (const p of picks) done[p.uid] = now;
  await saveDone(store, done, now);
  return { action: made[0], text: `✅ Marked done: ${picks.map((p) => `*${p.name}*`).join(", ")}. They're off your lists and get a ✓ in the calendar within a minute. Say *undo* to take ${picks.length === 1 ? "it" : "them"} back.` };
}

/** Undo the last thing done in the past 10 minutes (a whole checkbox batch at once). */
export async function undoLast(store: Store, now = Date.now()): Promise<Decision> {
  const all = await loadActions(store, now);
  const a = Object.values(all).filter((x) => x.status === "executed" && now - (x.decided ?? 0) < UNDO_MS)
    .sort((x, y) => (y.decided ?? 0) - (x.decided ?? 0))[0];
  if (!a) return { action: null, text: "" };
  if (a.batch) {
    const group = Object.values(all).filter((x) => x.batch === a.batch && x.status === "executed");
    for (const x of group) x.status = "reverted";
    await saveActions(store, all, now);
    const done = await loadDone(store);
    for (const x of group) delete done[x.args.uid];
    await saveDone(store, done, now);
    return { action: a, text: `↩️ Back on your list: ${group.map((x) => `*${x.args.name}*`).join(", ")}.` };
  }
  a.status = "reverted";
  await saveActions(store, all, now);
  await revert(store, a, now);
  return { action: a, text: `↩️ Undone: ${a.summary}` };
}

const STATUS_WORD: Record<Status, string> = { proposed: "waiting", executed: "done", declined: "skipped", expired: "expired", reverted: "undone" };

const DONE_TEXT: Record<ActionType, (a: Action) => string> = {
  mark_done: (a) => `✅ Marked *${a.args.name}* done. It's off your lists and digests, and its calendar event gets a ✓ within a minute.`,
  undo_done: (a) => `↩️ *${a.args.name}* is back on your list.`,
  add_study_blocks: (a) => `✅ Added ${a.args.plan.blocks.length} study block${a.args.plan.blocks.length === 1 ? "" : "s"} for *${a.args.name}*. They'll be in your calendar within a minute. Say *undo* in the next 10 minutes to take them out.`,
  keep_study_blocks: () => "👍 Keeping them. From now on I'll ask before adding any.",
  keep_vanished: (a) => `👍 Keeping ${a.args.items.length === 1 ? "it" : "them"} on your calendar.`,
};
const DECLINED: Record<ActionType, (a: Action) => string> = {
  mark_done: (a) => `OK, *${a.args.name}* stays on your list.`,
  undo_done: (a) => `OK, *${a.args.name}* stays done.`,
  add_study_blocks: (a) => `OK, no study blocks for *${a.args.name}*. I won't ask about it again.`,
  keep_study_blocks: () => "OK, removing them from your calendar within a minute. From now on I'll ask before adding any.",
  keep_vanished: (a) => `OK, removing ${a.args.items.length === 1 ? "it" : "them"} from your calendar within a minute.`,
};

// ------------------------------------------------------------------ executors (the only writers)

async function execute(store: Store, a: Action, now: number): Promise<void> {
  if (a.type === "keep_vanished") return;                       // the record itself keeps the item
  if (a.type === "mark_done" || a.type === "undo_done") {
    const done = await loadDone(store);
    if (a.type === "mark_done") done[a.args.uid] = now; else delete done[a.args.uid];
    await saveDone(store, done, now);
  } else if (a.type === "add_study_blocks" || a.type === "keep_study_blocks") {
    const st = await loadStudy(store);
    const plans: StudyPlan[] = a.type === "add_study_blocks" ? [a.args.plan] : a.args.plans;
    for (const p of plans) st.approved[p.uid] = p;
    await saveStudy(store, st);
  }
}

async function revert(store: Store, a: Action, now: number): Promise<void> {
  if (a.type === "keep_vanished") return;
  if (a.type === "mark_done" || a.type === "undo_done") {
    const done = await loadDone(store);
    if (a.type === "mark_done") delete done[a.args.uid]; else done[a.args.uid] = now;
    await saveDone(store, done, now);
  } else {
    const st = await loadStudy(store);
    const plans: StudyPlan[] = a.type === "add_study_blocks" ? [a.args.plan] : a.args.plans;
    for (const p of plans) delete st.approved[p.uid];
    await saveStudy(store, st);
  }
}
