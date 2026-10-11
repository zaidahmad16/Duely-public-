// The chat with a real AI (the P4 gate): the oracle + regression cases through answer() with a live
// provider, scored per template. Not part of `npm test` (it costs requests). Usage:
//   node --experimental-strip-types test/eval_models.ts [--limit 150] [--provider gemini] [--model M]
//        [--delay 4500] [--key-file PATH] [--only template,template] [--out results.json]
// --limit picks an even spread across templates (every template, then round-robin). The key is read
// from --key-file (default: the dev Gemini key) and never printed. Targets: 99.5% overall, 100% regression.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { makeLLM } from "../src/llm/adapters.ts";
import { pickModel } from "../src/llm/models.ts";
import type { Provider } from "../src/llm/types.ts";
import { type Result, byTemplate, casesFor, fixtures, regressionFor, runCase } from "./harness.ts";

const arg = (name: string, def = "") => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const provider = arg("provider", "gemini") as Provider;
const limit = Number(arg("limit", "0")) || Infinity;
const delay = Number(arg("delay", "4500"));
const only = arg("only") ? new Set(arg("only").split(",")) : null;
const out = arg("out", "eval-results.json");
const apiKey = readFileSync(arg("key-file", `${homedir()}/.local/share/duely-dev/live/gemini.key`), "utf8").trim();

let model = arg("model");
if (!model) {
  const p = await pickModel({ provider, apiKey });
  if (!p.model) throw new Error(`no working model: ${p.caps.error}`);
  model = p.model;
}
const llm = makeLLM({ provider, apiKey, model });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpl = (id: string) => id.split("|")[0];

for (const fx of await fixtures()) {
  const oracle = casesFor(fx), regression = regressionFor(fx);
  const regIds = new Set(regression.map((c) => c.id));
  let all = [...regression, ...oracle].filter((c) => !only || only.has(tmpl(c.id)));
  if (Number.isFinite(limit) && all.length > limit) {
    // an even spread: regression first (they're the known-hard ones), then round-robin over templates
    const groups = new Map<string, typeof all>();
    for (const c of all) groups.set(tmpl(c.id), [...(groups.get(tmpl(c.id)) ?? []), c]);
    const picked: typeof all = [];
    for (let i = 0; picked.length < limit; i++) {
      let any = false;
      for (const g of groups.values()) if (g[i] && picked.length < limit) { picked.push(g[i]); any = true; }
      if (!any) break;
    }
    all = picked;
  }
  console.log(`${fx.label}: ${all.length} cases on ${provider} · ${model} (${delay} ms apart)`);
  const results: Result[] = [];
  for (const [n, c] of all.entries()) {
    const r = await runCase(c, fx.items, { use_ai: true }, { llm });
    results.push(r);
    if (!r.ok) console.log(`✗ ${n + 1}/${all.length} ${r.id}\n   Q: ${r.q}\n   why: ${(r as any).why?.join("; ")}\n   A: ${r.reply.replace(/\n/g, " / ").slice(0, 240)}`);
    else if ((n + 1) % 25 === 0) console.log(`… ${n + 1}/${all.length}`);
    await sleep(delay);
  }
  const fail = results.filter((r) => !r.ok);
  const reg = results.filter((r) => regIds.has(r.id));
  console.log(`\n${fx.label}: ${results.length - fail.length}/${results.length} (${(100 * (results.length - fail.length) / results.length).toFixed(1)}%)`
    + `, regression ${reg.filter((r) => r.ok).length}/${reg.length}, median ${results.map((r) => r.ms).sort((a, b) => a - b)[results.length >> 1]} ms`);
  for (const [k, v] of byTemplate(results)) if (v.pass < v.total) console.log(`  ${k}: ${v.pass}/${v.total}`);
  writeFileSync(out, JSON.stringify(results.map((r) => ({ id: r.id, ok: r.ok, q: r.q, why: (r as any).why, reply: r.reply, ms: r.ms })), null, 1));
}
