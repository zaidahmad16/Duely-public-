// The oracle + regression set, offline (rules only, no AI), on the sample calendar and the real
// snapshot when present. Gate: no case that passed in test/oracle_baseline.json may fail now.
// After an intended improvement (or a new real snapshot):
//   UPDATE_BASELINE=1 npm test
// The live models are scored by test/eval_models.ts; the 99.5% / 100% targets apply there.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { type Result, byTemplate, casesFor, fixtures, regressionFor, runCase } from "./harness.ts";

const BASELINE = new URL("./oracle_baseline.json", import.meta.url).pathname;
type Base = Record<string, { at: number; failing: string[]; score: string }>;
const base: Base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const next: Base = { ...base };

for (const fx of await fixtures()) {
  test(`oracle + regression, rules only: ${fx.label} calendar`, async (t) => {
    const results: Result[] = [];
    for (const c of [...casesFor(fx), ...regressionFor(fx)]) results.push(await runCase(c, fx.items, {}, {}));
    const failing = results.filter((r) => !r.ok).map((r) => r.id);
    const score = `${results.length - failing.length}/${results.length}`;
    const weak = [...byTemplate(results)].filter(([, v]) => v.pass < v.total).map(([k, v]) => `${k} ${v.pass}/${v.total}`);
    t.diagnostic(`${fx.label}: ${score} (${weak.join(", ") || "all templates pass"})`);
    next[fx.label] = { at: fx.at, failing, score };
    if (process.env.UPDATE_BASELINE) return;
    const was = base[fx.label];
    if (!was) return t.skip(`no baseline for ${fx.label} yet: UPDATE_BASELINE=1 npm test`);
    if (was.at !== fx.at) return t.skip(`${fx.label} snapshot changed since the baseline: UPDATE_BASELINE=1 npm test`);
    const known = new Set(was.failing);
    const broke = results.filter((r) => !r.ok && !known.has(r.id));
    assert.equal(broke.length, 0, `newly failing:\n${broke.slice(0, 10).map((r) => `✗ ${r.id} "${r.q}": ${r.why.join("; ")}\n${r.reply.replace(/^/gm, "  | ")}`).join("\n")}`);
  });
}

test.after(() => {
  if (process.env.UPDATE_BASELINE) writeFileSync(BASELINE, JSON.stringify(next, null, 1) + "\n");
});
