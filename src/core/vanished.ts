// Tests and deadlines that vanish from the sources without a reason (2026-10-09: STAT 2507 Test 1
// silently left the calendar when its announcement scrolled out of the RSS feed). They're kept and
// the user is asked: [Keep it] [Remove it]; no answer = it stays (the user's choice, 2026-10-09).
//   vanished = in the last sync, upcoming, a test or something to hand in, not done, not hidden,
//              not Duely's own (study blocks, email dates), and not simply moved (same course + title
//              still there with another date).
//   more than 5 at once = the feed broke: one question for all of them, all kept meanwhile.
import type { Action, Draft } from "./actions.ts";
import type { Item } from "./classify.ts";
import { isWork } from "./kinds.ts";
import { strftime } from "./time.ts";

const MANY = 5;

const when = (it: any): number => {
  const v = it.role === "deadline" ? it.end ?? it.start : it.start;
  return typeof v === "string" ? Date.parse(v.includes("T") ? v : v + "T23:59:00") : Number(v?.t ?? NaN);
};
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Serialised items from the last sync that are missing now, for no reason we know of. */
export function vanishedItems(prev: any[], now: any[], cfg: any, at = Date.now()): any[] {
  const have = new Set(now.map((i) => String(i.uid)));
  const names = new Set(now.map((i) => `${i.course}|${norm(i.title)}`));
  const hidden = cfg.overrides ?? {};
  return prev.filter((it) => !have.has(String(it.uid))
    && isWork(it) && !it.done && it.keep !== false && hidden[it.uid] !== "hide"
    && !["study", "email"].includes(it.source) && !it.kept
    && when(it) > at
    && !names.has(`${it.course}|${norm(it.title)}`));                  // moved, not gone
}

const describe = (it: any, tz: string) => {
  const t = when(it);
  const day = Number.isNaN(t) ? "" : strftime({ t, tz }, typeof it.start === "string" && !it.start.includes("T") ? "%a %b %-d" : "%a %b %-d, %-I:%M %p");
  return `${it.course ? it.course + " " : ""}${it.title}${day ? ` (${day})` : ""}`;
};

/** One question per vanished item, or one for all when there are many (a broken feed). */
export function vanishedDrafts(items: any[], tz: string, at = Date.now()): Draft[] {
  if (!items.length) return [];
  const key = (its: any[]) => `vanished:${its.map((i) => i.uid).sort().join(",")}`.slice(0, 400);
  if (items.length > MANY) {
    return [{
      type: "keep_vanished", key: key(items) + `@${Math.floor(at / 864e5)}`, args: { items },
      summary: `⚠️ ${items.length} tests and deadlines disappeared from Brightspace at once (${items.slice(0, 3).map((i) => describe(i, tz)).join(", ")}…). `
        + "That usually means the feed broke, so I'm keeping them all. Keep them?",
    }];
  }
  return items.map((it) => ({
    type: "keep_vanished" as const, key: key([it]), args: { items: [it] },
    summary: `📅 *${describe(it, tz)}* disappeared from Brightspace. Cancelled, or did Brightspace just stop showing it? I'm keeping it until you say.`,
  }));
}

/** Items to keep in the calendar: asked about (no answer yet, or none ever) or kept, still upcoming,
 *  and not back in the sources by themselves. "Remove it" = declined = let go. */
export function keptItems(actions: Action[], current: Set<string>, tz: string, at = Date.now()): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.type !== "keep_vanished" || !["proposed", "expired", "executed"].includes(a.status)) continue;
    for (const it of a.args.items ?? []) {
      if (current.has(it.uid) || seen.has(it.uid) || !(when(it) > at)) continue;
      seen.add(it.uid);
      const w = (v: any) => (typeof v === "string" && v.includes("T") ? { t: Date.parse(v), tz } : v);
      out.push({ ...it, start: w(it.start), end: w(it.end), done: undefined, kept: true } as Item);
    }
  }
  return out;
}

/** Latest time any of an action's items happens (for pruning: keep the record until then). */
export const lastWhen = (a: Action) => Math.max(0, ...((a.args?.items ?? []) as any[]).map(when).filter((t) => !Number.isNaN(t)));
