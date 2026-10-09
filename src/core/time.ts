// Zoned date-times without a library. Workers run in UTC, so every local-time
// question goes through Intl with an explicit zone. Mirrors Python's aware datetimes:
// a DT is an instant plus the zone it was written in (used for isoformat offsets).

export type DT = { t: number; tz: string };     // tz "Z" = fixed UTC (Python timezone.utc)
export type When = DT | string;                 // string = all-day date "YYYY-MM-DD"

export const isDate = (w: When | null | undefined): w is string => typeof w === "string";

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz === "Z" ? "UTC" : tz, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmts.set(tz, f);
  }
  return f;
}

export type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number };

/** Slow path: ask Intl (used only to build the per-year transition tables). */
function intlOffset(t: number, tz: string): number {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) p[x.type] = x.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000) / 60000);
}

// Per zone and year: offset at Jan 1 plus each DST transition, found once by bisection.
// Afterwards every offset lookup is arithmetic, which keeps a run inside Workers Free's 10 ms CPU.
const tables = new Map<string, { at: number[]; off: number[] }>();
function table(tz: string, year: number) {
  const key = `${tz}|${year}`;
  let tb = tables.get(key);
  if (tb) return tb;
  const at: number[] = [Date.UTC(year, 0, 1)], off: number[] = [intlOffset(at[0], tz)];
  let prevT = at[0], prevOff = off[0];
  for (let m = 1; m <= 12; m++) {
    const t = Date.UTC(year, m, 1);
    const o = intlOffset(t, tz);
    if (o !== prevOff) {
      let lo = prevT, hi = t;   // offset changes somewhere in (lo, hi]
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (intlOffset(mid, tz) === prevOff) lo = mid; else hi = mid;
      }
      at.push(hi); off.push(o);
    }
    prevT = t; prevOff = o;
  }
  tb = { at, off };
  tables.set(key, tb);
  return tb;
}

function offsetMin(t: number, tz: string): number {
  if (tz === "Z" || tz === "UTC") return 0;
  const tb = table(tz, new Date(t).getUTCFullYear());
  let o = tb.off[0];
  for (let i = 1; i < tb.at.length; i++) if (t >= tb.at[i]) o = tb.off[i];
  return o;
}

export function parts(t: number, tz: string): Parts {
  const d = new Date(t + offsetMin(t, tz) * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(),
    mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: (d.getUTCDay() + 6) % 7 };
}

export function validZone(tz: string): boolean {
  if (tz === "UTC" || tz === "Z" || knownZones.has(tz)) return true;
  try { fmt(tz); return true; } catch { return false; }
}

/** Transition tables are saved in KV between runs so a run never pays for Intl setup. */
const knownZones = new Set<string>();
export function exportTables(): Record<string, { at: number[]; off: number[] }> {
  return Object.fromEntries(tables);
}
export function importTables(saved: Record<string, { at: number[]; off: number[] }> | null): void {
  for (const [k, v] of Object.entries(saved ?? {})) {
    tables.set(k, v);
    knownZones.add(k.split("|")[0]);
  }
}
export const tablesSize = () => tables.size;

/** Wall-clock time in `tz` -> instant (first offset wins on DST overlaps, like Python fold=0). */
export function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): DT {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === "Z" || tz === "UTC") return { t: guess, tz };
  const off1 = offsetMin(guess - 12 * 3600e3, tz);
  const off2 = offsetMin(guess + 12 * 3600e3, tz);
  // try the earlier offset first (fold=0), then the later one
  for (const off of off1 >= off2 ? [off1, off2] : [off2, off1]) {
    const t = guess - off * 60000;
    if (offsetMin(t, tz) === off) return { t, tz };
  }
  return { t: guess - off2 * 60000, tz };   // nonexistent (spring-forward gap)
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Python datetime.isoformat(): 2026-10-09T23:59:00-04:00 */
export function iso(dt: DT): string {
  const p = parts(dt.t, dt.tz);
  const off = offsetMin(dt.t, dt.tz);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const dateStr = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;

export function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function weekday(day: string): number {   // Monday = 0, like Python
  const [y, mo, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

export function daysBetween(a: string, b: string): number {
  const f = (s: string) => { const [y, mo, d] = s.split("-").map(Number); return Date.UTC(y, mo - 1, d); };
  return Math.round((f(b) - f(a)) / 86400e3);
}

/** Dates become local midnight so everything can be compared (Python ical.as_datetime). */
export function asDT(w: When, localTz: string): DT {
  if (!isDate(w)) return w;
  const [y, mo, d] = w.split("-").map(Number);
  return zoned(y, mo, d, 0, 0, 0, localTz);
}

/** Calendar date of an instant in a zone. */
export function localDate(dt: DT, tz: string): string {
  const p = parts(dt.t, tz);
  return dateStr(p.y, p.mo, p.d);
}

export const today = (tz: string) => localDate({ t: Date.now(), tz }, tz);

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** strftime subset used in descriptions: %a %A %b %B %-d %-I %M %p %Y %m %H %S */
export function strftime(dt: DT, f: string): string {
  const p = parts(dt.t, dt.tz);
  const num = (n: number, raw: boolean) => (raw ? String(n) : pad(n));
  return f.replace(/%(-?)([aAbBdIMpYmHS])/g, (_, dash: string, c: string) => {
    const raw = dash === "-";
    switch (c) {
      case "a": return DAY[p.wd];
      case "A": return DAY_FULL[p.wd];
      case "b": return MON[p.mo - 1];
      case "B": return MON_FULL[p.mo - 1];
      case "d": return num(p.d, raw);
      case "I": return num(p.h % 12 || 12, raw);
      case "M": return num(p.mi, raw);
      case "p": return p.h < 12 ? "AM" : "PM";
      case "Y": return String(p.y);
      case "m": return num(p.mo, raw);
      case "H": return num(p.h, raw);
      default: return num(p.s, raw);
    }
  });
}

export function strftimeDate(day: string, f: string): string {
  const [y, mo, d] = day.split("-").map(Number);
  return strftime({ t: Date.UTC(y, mo - 1, d), tz: "UTC" }, f);
}
