// Anonymous usage counts (src/node/analytics.ts): once a day, only when allowed and a key is built in,
// and the event carries nothing but the random id, version, OS and mode.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memStore } from "../src/core/util.ts";
import { event, forget, pingDaily } from "../src/node/analytics.ts";

const USAGE = { version: "0.2.0", os: "linux", arch: "x64", mode: "cloud" as const, packaged: true };
const DAY = Date.parse("2026-10-11T15:00:00");

function setup(ok = true) {
  const sent: any[] = [];
  const f = (async (url: any, init: any) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status: ok ? 200 : 503 }); }) as typeof fetch;
  return { store: memStore(), sent, f };
}

test("no key built in, or turned off: nothing is sent", async () => {
  const { store, sent, f } = setup();
  assert.equal(await pingDaily({ store, enabled: async () => true, usage: async () => USAGE, fetch: f, now: DAY, key: "" }), false);
  assert.equal(await pingDaily({ store, enabled: async () => false, usage: async () => USAGE, fetch: f, now: DAY, key: "phc_test" }), false);
  assert.equal(sent.length, 0);
});

test("once a day: a second ping the same day sends nothing, the next day sends again with the same id", async () => {
  const { store, sent, f } = setup();
  const ping = (now: number) => pingDaily({ store, enabled: async () => true, usage: async () => USAGE, fetch: f, now, key: "phc_test" });
  assert.equal(await ping(DAY), true);
  assert.equal(await ping(DAY + 3 * 3600e3), false);
  assert.equal(await ping(DAY + 24 * 3600e3), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.distinct_id, sent[1].body.distinct_id);
  assert.match(sent[0].url, /\/i\/v0\/e\/$/);
});

test("a failed send is tried again later the same day", async () => {
  const bad = setup(false);
  assert.equal(await pingDaily({ store: bad.store, enabled: async () => true, usage: async () => USAGE, fetch: bad.f, now: DAY, key: "phc_test" }), false);
  assert.equal(await bad.store.get("usage-counts"), null, "not marked as sent");
});

test("the event carries only the anonymous fields, with person profiles and IP location off", () => {
  const e = event("phc_test", "id-1", USAGE, DAY);
  assert.deepEqual(Object.keys(e).sort(), ["api_key", "distinct_id", "event", "properties", "timestamp"]);
  assert.deepEqual(Object.keys(e.properties).sort(), ["$geoip_disable", "$lib", "$process_person_profile", "app_version", "arch", "mode", "os", "packaged"]);
  assert.equal(e.properties.$process_person_profile, false);
  assert.equal(e.properties.$geoip_disable, true);
});

test("turning it off forgets the id, so a later opt-in starts a new, unlinked one", async () => {
  const { store, sent, f } = setup();
  await pingDaily({ store, enabled: async () => true, usage: async () => USAGE, fetch: f, now: DAY, key: "phc_test" });
  await forget(store);
  await pingDaily({ store, enabled: async () => true, usage: async () => USAGE, fetch: f, now: DAY, key: "phc_test" });
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].body.distinct_id, sent[1].body.distinct_id);
});
