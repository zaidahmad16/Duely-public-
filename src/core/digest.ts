// Morning digest + Sunday week preview, sent as a Slack DM (or whichever alert channel is set),
// with heads-ups when deadlines bunch up. Items come from state.json (serialised, with `done`).
import { type Occ, dayHeader, execute, line, occurrences } from "./ask.ts";
import { category, isWork } from "./kinds.ts";
import { addDays, localDate, strftime, strftimeDate, weekday } from "./time.ts";

export type DigestState = { submitted?: string; daily?: string; weekly?: string; heavy?: string[] };

const open = (o: Occ) => !o.it.done;

function section(title: string, occ: Occ[], tz: string, now: number, byDay = false): string[] {
  if (!occ.length) return [];
  const out = [`*${title}*`];
  let last = "";
  for (const o of occ) {
    if (byDay && o.day !== last) { out.push(dayHeader(o.day, tz, now)); last = o.day; }
    out.push(line(o, tz));
  }
  return out;
}

export type Heavy = { key: string; from: string; to: string; occ: Occ[] };

/** 2-day windows 2–6 days ahead with lots due (or a test plus 2+ deliverables). Non-overlapping. */
export function heavyClusters(items: any[], tz: string, now: number, threshold = 4): Heavy[] {
  const d = localDate({ t: now, tz }, tz);
  const work = occurrences(items, addDays(d, 2), addDays(d, 7), tz, now).filter((o) => isWork(o.it) && open(o));
  const out: Heavy[] = [];
  for (let s = 2; s <= 5; s++) {
    const from = addDays(d, s), to = addDays(from, 1);
    if (out.some((h) => from <= h.to)) continue;
    const occ = work.filter((o) => o.day >= from && o.day <= to);
    const tests = occ.filter((o) => category(o.it) === "test").length;
    if (occ.length >= threshold || (tests >= 1 && occ.length - tests >= 2)) {
      out.push({ key: `${from}:${occ.length}`, from, to, occ });
    }
  }
  return out;
}

function heavyText(h: Heavy, tz: string): string {
  const days = `${strftimeDate(h.from, "%a")}–${strftimeDate(h.to, "%a")}`;
  const names = h.occ.slice(0, 4).map((o) => `${o.it.course ? o.it.course + " " : ""}${o.it.title}`).join(", ");
  return `⚠️ *Heads-up: ${days} (${strftimeDate(h.from, "%b %-d")}–${strftimeDate(h.to, "%-d")}) has ${h.occ.length} things due*: `
    + `${names}${h.occ.length > 4 ? ", …" : ""}. Start early.`;
}

/** The morning DM. Returns the text and the heads-up keys it used. */
export function dailyDigest(items: any[], tz: string, now: number, cfg: any = {}, warned: string[] = []): { text: string; heavy: string[] } {
  const d = localDate({ t: now, tz }, tz);
  const todayOcc = occurrences(items, d, d, tz, now - 12 * 3600e3);   // include this morning's earlier classes
  const classes = todayOcc.filter((o) => category(o.it) === "class");
  const dueToday = todayOcc.filter((o) => isWork(o.it) && open(o) && category(o.it) !== "test");
  const testsToday = todayOcc.filter((o) => category(o.it) === "test" && open(o));
  const soon = occurrences(items, addDays(d, 1), addDays(d, 2), tz, now).filter((o) => isWork(o.it) && open(o) && category(o.it) !== "test");
  const tests = occurrences(items, addDays(d, 1), addDays(d, 7), tz, now).filter((o) => category(o.it) === "test" && open(o));
  const heavy = heavyClusters(items, tz, now, Number(cfg.heavy_threshold ?? 4)).filter((h) => !warned.includes(h.key));

  const parts: string[] = [`☀️ *Good morning! ${strftimeDate(d, "%a %b %-d")}*`];
  const push = (lines: string[]) => { if (lines.length) parts.push(lines.join("\n")); };
  push(section("Test today", testsToday, tz, now));
  push(section("Classes today", classes, tz, now));
  push(dueToday.length ? section("Due today", dueToday, tz, now) : ["Nothing due today 🎉"]);
  push(section("Due in the next 2 days", soon, tz, now, true));
  push(section("Tests this week", tests, tz, now, true));
  for (const h of heavy) parts.push(heavyText(h, tz));
  return { text: parts.join("\n\n"), heavy: heavy.map((h) => h.key) };
}

/** The Sunday-evening preview of the coming Monday–Sunday. */
export function weeklyDigest(items: any[], tz: string, now: number): string {
  const d = localDate({ t: now, tz }, tz);
  const mon = addDays(d, 7 - weekday(d)), sun = addDays(mon, 6);
  const work = occurrences(items, mon, sun, tz, now).filter((o) => isWork(o.it) && open(o));
  const tests = work.filter((o) => category(o.it) === "test").length;
  const perDay = new Map<string, number>();
  for (const o of work) perDay.set(o.day, (perDay.get(o.day) ?? 0) + 1);
  const busiest = [...perDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const head = `🗓️ *Your week ahead (${strftimeDate(mon, "%b %-d")}–${strftimeDate(sun, "%b %-d")})*: `
    + `${work.length - tests} thing${work.length - tests === 1 ? "" : "s"} due${tests ? `, ${tests} test${tests === 1 ? "" : "s"}` : ""}.`
    + (busiest && busiest[1] >= 2 ? ` Busiest: *${strftimeDate(busiest[0], "%a")}* (${busiest[1]}).` : "");
  if (!work.length) return head.replace(/: .*$/, ": nothing due. Enjoy it 🎉");
  const list = execute({ mode: "list", from: mon, to: sun, courses: [], categories: [], due_only: false, include_classes: false, limit: null },
    items.filter((i) => !i.done), tz, now);
  return `${head}\n\n${list.split("\n").slice(2).join("\n").trim()}`;   // drop execute's own count line
}

const minutes = (hm: string) => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + (m || 0); };

/** Is it time (within 30 min after `hm`, local) and not sent yet today? */
export function due(now: number, tz: string, hm: string, lastSent: string | undefined): boolean {
  const day = localDate({ t: now, tz }, tz);
  if (lastSent === day) return false;
  const nowMin = minutes(strftime({ t: now, tz }, "%H:%M"));
  const at = minutes(hm);
  return nowMin >= at && nowMin < at + 30;
}
