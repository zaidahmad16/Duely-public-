// Runs oracle / regression cases through the real chat (`answer()`) and grades them. Shared by
// test/oracle.test.ts (offline, rules only) and test/eval_models.ts (live models).
import { type AI, answer } from "../src/core/ask.ts";
import { memStore } from "../src/core/util.ts";
import { ITEMS as SAMPLE } from "./fixture.ts";
import { type Graded, type OracleCase, type Row, grade, localDay, oracleCases, weekMoments } from "../src/core/oracle.ts";
import { regressionCases } from "./regression_cases.ts";

export const TZ = "America/Toronto";

export type Fixture = { label: string; items: any[]; at: number };

/** The sample calendar (the public repo carries no one's real calendar). */
export async function fixtures(): Promise<Fixture[]> {
  return [{ label: "sample", items: SAMPLE, at: Date.parse("2026-10-04T20:00:00-04:00") }];
}

/** Oracle cases: each fixture's week, starting the day after its snapshot (the sample's Mon Oct 5). */
export function casesFor(fx: Fixture): OracleCase[] {
  const first = localDay(fx.at + 864e5);
  return oracleCases(fx.items, weekMoments(first), fx.label);
}

export function regressionFor(fx: Fixture): OracleCase[] {
  return regressionCases(fx.items, fx.at, fx.label);
}

export type Result = OracleCase & Graded & { reply: string; ms: number };

/** One case through the chat. A fresh session each time; done marks seeded from the items. */
export async function runCase(c: OracleCase, items: any[], cfg: any, ai: AI, f: typeof fetch = fetch): Promise<Result> {
  const store = memStore();
  const done = Object.fromEntries(items.filter((i) => i.done).map((i) => [i.uid, c.now - 864e5]));
  if (Object.keys(done).length) await store.put("done", done);
  let rows: Row[] | null = null;
  const t0 = Date.now();
  let reply: string;
  try {
    reply = await answer(c.q, items, cfg, store, TZ, f, c.now, { ...ai, onList: (r) => { rows = r; } });
  } catch (e) {
    reply = `THREW ${e}`;
  }
  const ms = Date.now() - t0;
  const g = reply.startsWith("THREW") ? { ok: false, why: [reply] } : grade(c, reply, rows, items);
  return { ...c, ...g, reply, ms };
}

/** Pass/fail by template name (the part of the id before "|"). */
export function byTemplate(results: Result[]): Map<string, { pass: number; total: number }> {
  const m = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const k = r.id.split("|")[0];
    const e = m.get(k) ?? { pass: 0, total: 0 };
    e.total++; if (r.ok) e.pass++;
    m.set(k, e);
  }
  return m;
}
