// "Change times" for a suggested study plan: the form's day + time per block -> new block times, or
// errors shown in the form (a block can't start in the past or end after the deadline).
import { zoned } from "./time.ts";

export function studyTimes(plan: { due: number; blocks: { s: number; e: number }[] }, values: any, tz: string, now: number)
  : { blocks: { s: number; e: number }[] } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const blocks: { s: number; e: number }[] = [];
  plan.blocks.forEach((b, i) => {
    const day = String(values?.[`day${i}`]?.v?.selected_date ?? ""), time = String(values?.[`time${i}`]?.v?.selected_time ?? "");
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day), tm = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!dm) { errors[`day${i}`] = "Pick a day."; return; }
    if (!tm) { errors[`time${i}`] = "Pick a time."; return; }
    const s = zoned(Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2]), 0, tz).t;
    const e = s + (b.e - b.s);
    if (s < now) errors[`day${i}`] = "That's in the past.";
    else if (e > plan.due) errors[`time${i}`] = "It would end after the deadline.";
    else blocks.push({ s, e });
  });
  return Object.keys(errors).length ? { errors } : { blocks: blocks.sort((x, y) => x.s - y.s) };
}
