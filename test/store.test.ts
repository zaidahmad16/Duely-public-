// The on-disk store: round trips, atomic writes, a damaged file falls back to the last good copy,
// unsafe keys and values are refused; and a full headless sync through it with an AI provider.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, build } from "../src/core/sync.ts";
import { fileStore } from "../src/node/store.ts";
import { llmFrom } from "../src/cli.ts";
import { llmFromRun } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "duely-store-"));

test("round trip; previous copy kept as .bak; a damaged file falls back to it", async () => {
  const d = dir(), s = fileStore(d);
  assert.equal(await s.get("done"), null);
  await s.put("done", { a: 1 });
  await s.put("done", { a: 1, b: 2 });
  assert.deepEqual(await s.get("done"), { a: 1, b: 2 });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "done.json.bak"), "utf8")), { a: 1 });
  writeFileSync(join(d, "done.json"), "✘ ERROR Failed to fetch …");            // what corrupted the personal KV once
  assert.deepEqual(await s.get("done"), { a: 1 }, "the last good copy");
  await s.put("done", { c: 3 });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "done.json.bak"), "utf8")), { a: 1 }, "a damaged file never becomes the backup");
});

test("refused: path tricks, undefined, values that don't survive JSON", async () => {
  const s = fileStore(dir());
  await assert.rejects(s.put("../config", {}), /bad store key/);
  await assert.rejects(s.put("a/b", {}), /bad store key/);
  await assert.rejects(s.put("x", undefined), /undefined/);
  await assert.rejects(s.put("x", { n: NaN }), /round trip/);
});

test("writes to one key land in order (no lost updates from overlapping saves)", async () => {
  const d = dir(), s = fileStore(d);
  await Promise.all([1, 2, 3, 4, 5].map((n) => s.put("actions", { n })));
  assert.deepEqual(await s.get("actions"), { n: 5 });
  assert.ok(!existsSync(join(d, `actions.json.tmp-${process.pid}`)));
});

test("headless sync with an AI provider: the feed filter asks the provider, verdicts cached in the store", async () => {
  const s = fileStore(dir());
  let calls = 0;
  const llm = llmFromRun(async (_m, body) => {
    calls++;
    const ids = [...String(body.messages[0].content).matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    return { response: { verdicts: ids.map((id) => ({ id, keep: true, type: "", title: "", reason: "" })) } };
  });
  const feed = readFileSync(new URL("./fixture.ics", import.meta.url), "utf8").replace(/2030/g, "2999");
  const cfg = { ...DEFAULTS, lookback_days: 100000, use_ai: true };
  const [items, status] = await build({ store: s, cfg, tz: "America/Toronto", fetch, llm }, feed);
  assert.ok(calls >= 1, "the provider was asked");
  assert.ok(items.length >= 5);
  assert.doesNotMatch(status, /No AI/);
  assert.ok(await s.get("ai-cache"), "verdicts cached");
  assert.ok(((await s.get("ai-usage")) as any).requests >= 1, "counted against the daily cap");
});

test("llmFrom: config or environment picks the provider; nothing set = no AI", () => {
  assert.equal(llmFrom({}, {}), undefined);
  assert.match(llmFrom({ ai: { provider: "gemini", model: "gemini-x", apiKey: "k" } }, {})!.label, /^Gemini · gemini-x$/);
  assert.match(llmFrom({}, { DUELY_PROVIDER: "anthropic", DUELY_MODEL: "claude-x", DUELY_API_KEY: "k" } as any)!.label, /^Anthropic · claude-x$/);
});
