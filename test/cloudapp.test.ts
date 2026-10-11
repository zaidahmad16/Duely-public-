// The desktop in cloud mode (src/node/cloudapp.ts) against the real bundle in the Apps Script sandbox:
// Upcoming comes from the script, decisions show at once and land in the script, new alerts become
// desktop notifications exactly once, settings reach the script without the desktop's calendar id,
// offline the last state is shown.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { memStore } from "../src/core/util.ts";
import type { CloudLink } from "../src/node/cloud.ts";
import { cloudApp, engineConfig } from "../src/node/cloudapp.ts";
import { CONFIG, sandbox } from "./gas-sandbox.ts";

const KEY = "k".repeat(43);
const URL1 = "https://script.google.com/macros/s/AKfyc-test/exec";
const LINK: CloudLink = { scriptId: "s1", deploymentId: "d1", url: URL1, key: KEY, version: "v", scopes: "" };

async function setup() {
  const s = await sandbox();
  s.props.setProperty("secret:channel_key", KEY);
  s.run("duelySetup");
  let offline = false;
  const f = (async (input: any, init: any = {}) => {
    if (offline) throw new TypeError("fetch failed");
    const u = new URL(String(input));
    const text = init.method === "POST"
      ? vm.runInContext(`doPost(${JSON.stringify({ postData: { contents: init.body } })})`, s.ctx).text
      : vm.runInContext(`doGet(${JSON.stringify({ parameter: Object.fromEntries(u.searchParams) })})`, s.ctx).text;
    return new Response(text);
  }) as typeof fetch;
  const notes: string[] = [];
  const store = memStore();
  const app = cloudApp({ store, link: async () => LINK, saveLink: async () => {}, fetch: f, tz: () => "America/Toronto",
    notify: async (t) => { notes.push(t); } });
  return { s, app, store, notes, setOffline: (v: boolean) => { offline = v; } };
}

const NOW = Date.parse("2030-10-01T12:00:00-04:00");

test("Upcoming comes from the script; a tick shows at once and is done in the script after its run", async () => {
  const { s, app } = await setup();
  await s.run("duelySyncNow");
  await app.refresh();
  const before = await app.upcoming(NOW);
  const row = [...before.today, ...before.thisWeek, ...before.nextWeek].find((r) => r.title === "Assignment 3")!;
  assert.ok(row, "the script's items are shown");
  await app.decide({ kind: "done", uid: row.uid, name: row.title });
  const optimistic = await app.upcoming(NOW);
  assert.ok(![...optimistic.thisWeek, ...optimistic.nextWeek].some((r) => r.uid === row.uid), "gone from the list at once");
  await s.run("duelySyncNow");
  const st = await app.refresh();
  assert.ok(st.done[row.uid], "done in the script");
  assert.ok(![...(await app.upcoming(NOW)).thisWeek].some((r) => r.uid === row.uid), "still gone after the real state arrives");
});

test("new alerts from the script become desktop notifications once; old ones at first read don't", async () => {
  const { s, app, notes } = await setup();
  s.props.setProperty("v:outbox", JSON.stringify([{ at: 1, title: "old alert", body: "", click: "" }]));
  await app.refresh();
  assert.deepEqual(notes, [], "first read: old alerts aren't news");
  s.props.setProperty("v:outbox", JSON.stringify([{ at: 1, title: "old alert", body: "" }, { at: 2, title: "Quiz moved", body: "to Friday" }]));
  await app.refresh();
  await app.refresh();
  assert.deepEqual(notes, ["Quiz moved"]);
});

test("settings reach the script without the desktop's calendar id or keys", async () => {
  const { s, app } = await setup();
  await app.pushSettings({ ...CONFIG, calendar_id: "desktop-cal", onboarded: true, ai: { provider: "gemini", model: "m", apiKey: "leak" }, digest_time: "08:15" });
  const cfg = JSON.parse(s.props.m.get("v:config")!);
  assert.equal(cfg.digest_time, "08:15");
  assert.equal(cfg.calendar_id, undefined);
  assert.equal(cfg.onboarded, undefined);
  assert.ok(!JSON.stringify(cfg).includes("leak"));
  assert.equal(engineConfig({}, "America/Halifax").tz, "America/Halifax", "the student's zone is sent");
});

test("offline: the last state is shown; Sync now waits for the script's run", async () => {
  const { s, app, setOffline } = await setup();
  await s.run("duelySyncNow");
  await app.refresh();
  setOffline(true);
  const st = await app.current();
  assert.ok(st && st.state.items.length >= 4, "cached state");
  setOffline(false);
  let ran = false;
  const r = await app.sync({ everyMs: 0, sleep: async () => { if (!ran) { ran = true; await s.run("duelySyncNow"); } } });
  assert.equal(r.syncQueued, false);
});

test("an engine update with an expired Google sign-in waits for a reconnect instead of failing", async () => {
  const { NeedsAuth } = await import("../src/core/gcal.ts");
  const saved: CloudLink[] = [];
  const expired = async () => { throw new NeedsAuth("Google sign-in expired"); };
  const api = { upload: expired, version: expired, redeploy: expired } as any;
  const app = cloudApp({ store: memStore(), link: async () => LINK, saveLink: async (l) => { saved.push(l!); }, fetch: fetch,
    tz: () => "America/Toronto", notify: async () => {}, bundle: () => ({ code: "x", version: "v2" }), scriptApi: async () => api });
  assert.deepEqual(await app.updateEngine(), { changed: false, needsApproval: false, needsGoogle: true });
  assert.equal(saved.length, 0, "the link keeps the old version, so the update is tried again after reconnecting");
  const broken = { upload: async () => { throw new Error("500"); } } as any;
  const app2 = cloudApp({ store: memStore(), link: async () => LINK, saveLink: async () => {}, fetch: fetch,
    tz: () => "America/Toronto", notify: async () => {}, bundle: () => ({ code: "x", version: "v2" }), scriptApi: async () => broken });
  await assert.rejects(app2.updateEngine(), /500/, "other failures still surface");
});
