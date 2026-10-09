// Minimal RFC 5545 reader, a port of syllabus/core/ical.py.
import { type DT, type When, addDays, asDT, dateStr, daysBetween, isDate, localDate, parts, validZone, weekday, zoned } from "./time.ts";

const WINDOWS_TZ: Record<string, string> = {
  "Eastern Standard Time": "America/Toronto",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Edmonton",
  "Pacific Standard Time": "America/Vancouver",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "GMT Standard Time": "Europe/London",
  "UTC": "UTC",
};

export type RawEvent = {
  uid: string; summary: string; description: string; location: string; url: string;
  categories: string; start: When; end: When; all_day: boolean; rrule: string;
};

function zone(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  const z = WINDOWS_TZ[tzid.replace(/^"|"$/g, "")] ?? tzid.replace(/^"|"$/g, "");
  return validZone(z) ? z : fallback;
}

export function unescape(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseDt(value: string, params: Record<string, string>, defaultTz: string): [When, boolean] {
  value = value.trim();
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    return [dateStr(+value.slice(0, 4), +value.slice(4, 6), +value.slice(6, 8)), true];
  }
  const v = value.replace(/Z+$/, "").slice(0, 15);
  const [y, mo, d, h, mi, s] = [v.slice(0, 4), v.slice(4, 6), v.slice(6, 8), v.slice(9, 11), v.slice(11, 13), v.slice(13, 15)].map(Number);
  if (value.endsWith("Z")) return [{ t: Date.UTC(y, mo - 1, d, h, mi, s), tz: "Z" }, false];
  return [zoned(y, mo, d, h, mi, s, zone(params.TZID, defaultTz)), false];
}

function lines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if ((raw[0] === " " || raw[0] === "\t") && out.length) out[out.length - 1] += raw.slice(1);
    else if (raw) out.push(raw);
  }
  return out;
}

function split(line: string): [string, Record<string, string>, string] {
  const colon = line.indexOf(":");
  const semi = line.indexOf(";");
  if (colon >= 0 && (semi < 0 || semi > colon)) return [line.slice(0, colon).toUpperCase(), {}, line.slice(colon + 1)];
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      const head = line.slice(0, i).split(";");
      const params: Record<string, string> = {};
      for (const p of head.slice(1)) {
        const eq = p.indexOf("=");
        const k = eq < 0 ? p : p.slice(0, eq);
        const v = eq < 0 ? "" : p.slice(eq + 1);
        params[k.toUpperCase()] = v.replace(/^"+|"+$/g, "");
      }
      return [head[0].toUpperCase(), params, line.slice(i + 1)];
    }
  }
  return [line.toUpperCase(), {}, ""];
}

function duration(value: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return 0;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const KEEP = new Set(["UID", "SUMMARY", "DESCRIPTION", "LOCATION", "URL", "CATEGORIES", "RRULE"]);
// An "opens" event can be old while its matching close/due event is recent, so those are always parsed.
const OPENER = /^SUMMARY:.*[-–:]\s*(availability starts|start date|opens?|unlocks?|available)\s*\r?$/im;
const baseOf = (summary: string) =>
  summary.replace(/\s*[-–:]\s*(due(?: date)?|availability (?:starts|ends)|start date|end date|opens?|closes?|unlocks?|locks?|available|end)\s*\r?$/i, "").trim().toLowerCase();

/** Parse VEVENTs. With `minDay` (YYYYMMDD), events that ended before it are skipped cheaply:
 *  a Brightspace feed carries every past term, and full parsing costs CPU the Worker doesn't have. */
export function parse(text: string, defaultTz: string, minDay?: string): RawEvent[] {
  let calTz = defaultTz;
  const firstEv = text.indexOf("BEGIN:VEVENT");
  const headerTz = /^X-WR-TIMEZONE:(.*)$/m.exec(firstEv >= 0 ? text.slice(0, firstEv) : text);
  if (headerTz) calTz = zone(headerTz[1].trim(), defaultTz);
  const events: Record<string, any>[] = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1).map((b) => b.slice(0, b.indexOf("END:VEVENT") >>> 0));
  let skip: boolean[] = [];
  if (minDay) {
    // pass 1: which events are recent, and which titles (minus the suffix) they belong to
    const recentBases = new Set<string>();
    const info = blocks.map((body) => {
      const m = /^DTEND[^:\r\n]*:(\d{8})/m.exec(body) ?? /^DTSTART[^:\r\n]*:(\d{8})/m.exec(body);
      const old = !!m && m[1] < minDay && !/^RRULE[;:]/m.test(body);
      const opener = OPENER.exec(body);
      if (!old) {
        const sm = /^SUMMARY:(.*)$/m.exec(body);
        if (sm) recentBases.add(baseOf(sm[1]));
      }
      return { old, opener };
    });
    // an old "opens" event only matters if its close/due partner is recent
    skip = info.map(({ old, opener }) => old && !(opener && recentBases.has(baseOf(opener[0].slice(8)))));
  }
  for (let bi = 0; bi < blocks.length; bi++) {
    if (skip[bi]) continue;
    const body = blocks[bi];
    const cur: Record<string, any> = {};
    for (const line of lines(body)) {
      const [name, params, value] = split(line);
      if (name === "DTSTART" || name === "DTEND") cur[name] = [value, params];
      else if (name === "DURATION") cur.DURATION = value;
      else if (KEEP.has(name) && !(name in cur)) cur[name] = unescape(value);
    }
    events.push(cur);
  }
  const out: RawEvent[] = [];
  for (const ev of events) {
    if (!ev.DTSTART) continue;
    const [start, allDay] = parseDt(ev.DTSTART[0], ev.DTSTART[1], calTz);
    let end: When;
    if (ev.DTEND) end = parseDt(ev.DTEND[0], ev.DTEND[1], calTz)[0];
    else if (ev.DURATION) {
      const ms = duration(ev.DURATION);
      end = isDate(start) ? addDays(start, Math.round(ms / 86400e3)) : { t: start.t + ms, tz: start.tz };
    } else end = allDay && isDate(start) ? addDays(start, 1) : start;
    if (allDay && isDate(start) && isDate(end) && end <= start) end = addDays(start, 1);
    out.push({
      uid: ev.UID || `${ev.SUMMARY ?? ""}@${ev.DTSTART[0]}`,
      summary: (ev.SUMMARY ?? "").trim(),
      description: (ev.DESCRIPTION ?? "").trim(),
      location: (ev.LOCATION ?? "").trim(),
      url: (ev.URL ?? "").trim(),
      categories: (ev.CATEGORIES ?? "").trim(),
      start, end, all_day: allDay,
      rrule: (ev.RRULE ?? "").trim(),
    });
  }
  return out;
}

function rruleParts(rrule: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const p of rrule.split(";")) {
    const i = p.indexOf("=");
    if (i >= 0) o[p.slice(0, i)] = p.slice(i + 1);
  }
  return o;
}

/** Last moment a recurring event can happen, or null if it repeats forever / by COUNT. */
export function rruleUntil(rrule: string, tz: string): DT | null {
  const until = rruleParts(rrule).UNTIL;
  if (!until) return null;
  return asDT(parseDt(until, {}, tz)[0], tz);
}

export const DAYS: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

/** Next start >= after for simple DAILY/WEEKLY rules; null once over. */
export function nextOccurrence(start: When, rrule: string, after: number, localTz: string): DT | null {
  const p = rruleParts(rrule);
  const first = asDT(start, localTz);
  const tz = first.tz === "Z" ? "UTC" : first.tz;
  const until = rruleUntil(rrule, tz);
  const interval = parseInt(p.INTERVAL || "1") || 1;
  if (p.FREQ !== "DAILY" && p.FREQ !== "WEEKLY") return first.t >= after ? first : null;
  const days = new Set((p.BYDAY ?? "").split(",").map((d) => d.slice(-2)).filter((d) => d in DAYS).map((d) => DAYS[d]));
  const firstDay = localDate(first, tz);
  if (!days.size) days.add(weekday(firstDay));
  const week0 = addDays(firstDay, -weekday(firstDay));
  const fp = parts(first.t, tz);
  const afterDay = addDays(localDate({ t: after, tz }, tz), -1);
  let day = afterDay > firstDay ? afterDay : firstDay;
  for (let i = 0; i < 800; i++) {
    const [y, mo, d] = day.split("-").map(Number);
    const cand = zoned(y, mo, d, fp.h, fp.mi, fp.s, tz);
    if (until && cand.t > until.t) return null;
    const ok = p.FREQ === "DAILY"
      ? daysBetween(firstDay, day) % interval === 0
      : days.has(weekday(day)) && Math.floor(daysBetween(week0, day) / 7) % interval === 0;
    if (ok && cand.t >= after) return { t: cand.t, tz: first.tz };
    day = addDays(day, 1);
  }
  return null;
}
