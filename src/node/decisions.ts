// The student's decisions (tick done, undo, answer a question, change study times), applied to a store
// with the engine's own action rules. Used by the desktop app in local mode, and by the script in the
// student's Google account (cloud mode) for the inbox the desktop fills. Plain, host-neutral code.
import { decide, loadActions, record, recordDone } from "../core/actions.ts";
import { studyTimes } from "../core/studychange.ts";
import type { Store } from "../core/util.ts";
import type { Button } from "../shared/types.ts";

export type Decision =
  | { kind: "done"; uid: string; name: string }
  | { kind: "undo"; uid: string; name: string }
  | { kind: "decide"; id: string; button: Button; times?: { day: string; time: string }[] };

/** Applies one decision. Throws a message for the student when it can't be done. */
export async function applyDecision(store: Store, d: Decision, tz: string, now = Date.now()): Promise<void> {
  if (d.kind === "done") { await recordDone(store, [{ uid: d.uid, name: d.name }], now); return; }
  if (d.kind === "undo") {
    await record(store, { type: "undo_done", key: `undo_done:${d.uid}`, args: { uid: d.uid, name: d.name }, summary: `Put *${d.name}* back on the list` }, now);
    return;
  }
  const yes = ["keep", "add", "yes"].includes(d.button) || (d.button === "change" && !!d.times);
  let override: Record<string, unknown> | undefined;
  if (d.button === "change") {
    const a = (await loadActions(store, now))[d.id];
    if (!a || a.type !== "add_study_blocks") throw new Error("That suggestion isn't open any more.");
    const values: any = {};
    (d.times ?? []).forEach((t, i) => { values[`day${i}`] = { v: { selected_date: t.day } }; values[`time${i}`] = { v: { selected_time: t.time } }; });
    const r = studyTimes(a.args.plan, values, tz, now);
    if ("errors" in r) throw new Error(Object.values(r.errors)[0]);
    override = { plan: { ...a.args.plan, blocks: r.blocks } };
  }
  const res = await decide(store, d.id, yes, "button", now, override);
  if (!res.action) throw new Error(res.text);
}

/** A decision as sent over the channel, checked (it comes from the network). */
export function parseDecision(x: any): Decision | null {
  if (!x || typeof x !== "object") return null;
  const str = (v: unknown, max = 300) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  if ((x.kind === "done" || x.kind === "undo") && str(x.uid, 900) && typeof x.name === "string") return { kind: x.kind, uid: x.uid, name: x.name.slice(0, 300) };
  const buttons: Button[] = ["keep", "remove", "add", "notnow", "change", "yes", "no"];
  if (x.kind === "decide" && str(x.id, 64) && buttons.includes(x.button)) {
    const times = Array.isArray(x.times) ? x.times.slice(0, 10).filter((t: any) => /^\d{4}-\d{2}-\d{2}$/.test(t?.day) && /^\d{1,2}:\d{2}$/.test(t?.time)) : undefined;
    return { kind: "decide", id: x.id, button: x.button, ...(times ? { times } : {}) };
  }
  return null;
}
