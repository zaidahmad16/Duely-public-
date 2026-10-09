// Done tracking. Brightspace's feed doesn't know what you've handed in, so "done …" in the Slack DM
// marks an item finished: it drops out of lists, digests and study blocks, and its calendar event
// gets a ✓ and loses its reminders. Stored in KV "done" ({uid: when}), written only by actions.ts
// (a mark by list number is done at once; one found by name is confirmed first).
import { isWork } from "./kinds.ts";
import type { Store } from "./util.ts";

export type Done = Record<string, number>;

const KEEP_MS = 120 * 86400e3;   // forget marks after ~a term

export async function loadDone(store: Store): Promise<Done> {
  return (await store.get<Done>("done")) ?? {};
}

export async function saveDone(store: Store, done: Done, now = Date.now()): Promise<void> {
  const kept: Done = {};
  for (const [uid, at] of Object.entries(done)) if (now - at < KEEP_MS) kept[uid] = at;
  await store.put("done", kept);
}

/** Mark items in place (Worker-only flag; the desktop app's engine never sees it). */
export function applyDone<T extends { uid: string }>(items: T[], done: Done): T[] {
  for (const it of items) if (done[it.uid]) (it as any).done = true;
  return items;
}

const when = (it: any) => Date.parse(String(it.role === "deadline" ? it.end ?? it.start : it.start ?? ""))
  || Date.parse(String(it.start ?? "") + "T00:00:00Z");

const WORDS: [RegExp, string][] = [
  [/\ba(\d+)\b/g, "assignment $1"], [/\basg\s?(\d+)\b/g, "assignment $1"], [/\bassgn\s?(\d+)\b/g, "assignment $1"],
  [/\btut\s?(\d+)\b/g, "tutorial $1"], [/\bhw\b/g, "homework"], [/\bq(\d+)\b/g, "quiz $1"],
];
const STOP = new Set(["done", "finished", "submitted", "handed", "in", "the", "my", "i", "did", "with", "for", "mark", "as", "undo", "not", "undone", "is", "a", "an"]);

function tokens(s: string): string[] {
  let t = s.toLowerCase().replace(/[’']/g, "");
  for (const [re, rep] of WORDS) t = t.replace(re, rep);
  return t.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
}

/** `exact`: picked by number from the last list ("done 2", "that one"), so no need to double-check. */
export type Resolved = { match?: any; choices?: any[]; exact?: boolean };

/** Which item does "done comp 2406 a1" / "done 2" mean? `lastList` = uids from the last numbered reply. */
export function resolveTarget(target: string, items: any[], lastList: string[], now = Date.now(), wantDone?: boolean): Resolved {
  const byUid = new Map(items.map((i) => [i.uid, i]));
  // "the first one", "number 2", "#2", "that one" / "it" (when the last list had one item)
  let t = target.trim().toLowerCase().replace(/^(the|my|number|no\.?|item)\s+/, "").replace(/\s+(one|item)$/, "").trim();
  const ORD: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };
  if (ORD[t]) t = String(ORD[t]);
  else if (t === "last" && lastList.length) t = String(lastList.length);
  else if (/^(it|that|this|that one|this one|them|those|all of them)?$/.test(t) && lastList.length === 1) t = "1";
  else if (/^(it|that|this|that one|this one)?$/.test(t) && lastList.length > 1) {
    return { choices: lastList.map((u) => byUid.get(u)).filter(Boolean).slice(0, 8) };
  }
  const num = /^#?(\d{1,2})$/.exec(t);
  if (num) {
    const it = byUid.get(lastList[Number(num[1]) - 1]);
    return it ? { match: it, exact: true } : {};
  }
  const course = /\b([a-z]{4})\s?-?\s?(\d{4})\b/i.exec(t);
  const code = course ? `${course[1].toUpperCase()} ${course[2]}` : null;
  const want = tokens(course ? t.replace(course[0], " ") : t);
  if (!want.length && !code) return {};
  const pool = items.filter((it) => isWork(it) && it.keep !== false
    && (wantDone === undefined || !!it.done === wantDone)
    && when(it) >= now - 7 * 86400e3 && when(it) <= now + 60 * 86400e3
    && (!code || it.course === code));
  let best = 0;
  const scored = pool.map((it) => {
    const have = new Set(tokens(`${it.title} ${it.course ?? ""}`));
    const hit = want.filter((w) => have.has(w)).length;
    const score = want.length ? hit / want.length : 1;
    best = Math.max(best, score);
    return { it, score };
  });
  if (best < 0.6) return {};
  const top = scored.filter((s) => s.score === best).map((s) => s.it).sort((a, b) => when(a) - when(b));
  return top.length === 1 ? { match: top[0] } : { choices: top.slice(0, 8) };
}
