// The Apps Script bundle, run in a sandbox that has only what Apps Script has: no fetch, Web Crypto,
// URL, timers or Intl; fake UrlFetchApp / Utilities / PropertiesService (with Apps Script's size limits)
// / ScriptApp / Session, and a fake Google Calendar REST API behind UrlFetchApp. It must put exactly
// the same events in the calendar as the desktop engine does for the same feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { buildGas } from "../scripts/build-gas.ts";
import { CONFIG, FEED_URL, desktopEvents, sandbox } from "./gas-sandbox.ts";

const key = (e: any) => `${e.extendedProperties.private.bsUid}|${e.extendedProperties.private.bsHash}|${e.summary}|${JSON.stringify(e.start)}`;

test("the bundle runs without Intl, fetch, URL, crypto or timers, and syncs the same events as the desktop", async () => {
  const s = await sandbox();
  const r = await s.run("duelyTick");
  assert.equal(r.synced, true);
  const got = s.api.events().map(key).sort();
  const want = (await desktopEvents()).map(key).sort();
  assert.ok(want.length >= 4, `desktop made ${want.length} events`);
  assert.deepEqual(got, want, "same events, same hashes, same times");
});

test("a second tick within 10 minutes doesn't sync again; the next one does, and changes nothing", async () => {
  const s = await sandbox();
  await s.run("duelyTick");
  const writes = () => s.api.writes;
  const before = writes();
  assert.equal((await s.run("duelyTick")).synced, false, "too soon");
  const sched = JSON.parse(s.props.m.get("v:sched")!);
  s.props.setProperty("v:sched", JSON.stringify({ ...sched, lastFull: sched.lastFull - 10 * 60e3 }));
  assert.equal((await s.run("duelyTick")).synced, true, "due again");
  assert.equal(s.api.events().length, (await desktopEvents()).length);
  assert.ok(writes() - before <= 2, "the unchanged feed isn't re-written");
});

test("setup makes one 10-minute trigger (again: still one); stop removes it", async () => {
  const s = await sandbox();
  s.run("duelySetup");
  s.run("duelySetup");
  assert.equal(s.triggers.length, 1);
  assert.equal(s.triggers[0].n, 10);
  s.run("duelyStop");
  assert.equal(s.triggers.length, 0);
});

test("big values are split into chunks under Apps Script's 9 KB limit and read back whole", async () => {
  const s = await sandbox();
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ uid: `u${i}`, title: "x".repeat(60) })) };
  await vm.runInContext(`Duely.propsStore().put("big", ${JSON.stringify(big)})`, s.ctx);
  assert.ok([...s.props.m.keys()].filter((k) => k.startsWith("c:big:")).length > 2, "chunked");
  const back = await vm.runInContext(`Duely.propsStore().get("big")`, s.ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), big);   // (objects from the sandbox have its own prototypes)
  await vm.runInContext(`Duely.propsStore().put("big", {"small": true})`, s.ctx);
  assert.equal([...s.props.m.keys()].filter((k) => k.startsWith("c:big:")).length, 0, "old chunks removed");
});

test("AI from inside Apps Script: each provider type gets a well-formed request through UrlFetchApp", async () => {
  for (const [provider, host, auth] of [["openai", "api.mistral.ai", "Authorization"], ["anthropic", "api.anthropic.com", "x-api-key"], ["gemini", "generativelanguage.googleapis.com", "x-goog-api-key"]] as const) {
    const calls: { url: string; o: any }[] = [];
    const s = await sandbox(undefined, (url, o) => { calls.push({ url, o }); return [500, JSON.stringify({ error: { message: "fake provider" } })]; });
    s.props.setProperty("v:config", JSON.stringify({ ...CONFIG, use_ai: true, ai: { provider, model: "m-1", baseUrl: provider === "openai" ? "https://api.mistral.ai/v1" : "" } }));
    s.props.setProperty("secret:llm_key", "k-123");
    const r = await s.run("duelyTick");
    assert.equal(r.synced, true, provider);
    const call = calls.find((c) => c.url.includes(host));
    assert.ok(call, `${provider}: the AI was called (${calls.map((c) => c.url).join(", ")})`);
    assert.equal(call!.o.method, "post");
    assert.match(call!.o.contentType ?? "", /json/, `${provider}: JSON body as UrlFetchApp's contentType`);
    const body = JSON.parse(call!.o.payload);
    assert.ok(JSON.stringify(body).includes("m-1") || call!.url.includes("m-1"), `${provider}: model sent`);
    const headers = Object.fromEntries(Object.entries(call!.o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const keySent = Object.values(headers).some((v) => v.includes("k-123")) || call!.url.includes("k-123");
    assert.ok(keySent, `${provider}: key sent (${auth})`);
    assert.ok(s.api.events().length >= 4, `${provider}: the AI failing falls back to the rules, and the calendar still fills`);
  }
});

test("the desktop's channel (web app): doGet/doPost answer synchronously; Sync now queues one run", async () => {
  const s = await sandbox();
  const KEY = "k".repeat(43);
  s.props.setProperty("secret:channel_key", KEY);
  const call = (src: string) => JSON.parse(vm.runInContext(src
    .replace("doGet()", `doGet({ parameter: { key: "${KEY}" } })`)
    .replace(/JSON\.stringify\(\{ op/g, `JSON.stringify({ key: "${KEY}", op`)
    .replace(/'\{"op"/g, `'{"key":"${KEY}","op"`), s.ctx).text);
  // without the key (or with a wrong one) nothing is shown or changed
  assert.equal(JSON.parse(vm.runInContext("doGet({ parameter: {} })", s.ctx).text).error, "not allowed");
  assert.equal(JSON.parse(vm.runInContext(`doGet({ parameter: { key: "${"x".repeat(43)}" } })`, s.ctx).text).error, "not allowed");
  assert.equal(JSON.parse(vm.runInContext(`doPost({ postData: { contents: '{"op":"sync"}' } })`, s.ctx).text).error, "not allowed");
  assert.equal(s.triggers.length, 0);
  const empty = call("doGet()");
  assert.equal(empty.ok, true);
  assert.equal(empty.state, null, "nothing synced yet");
  assert.deepEqual(call(`doPost({ postData: { contents: JSON.stringify({ op: "config", config: { digest_time: "08:15" } }) } })`), { ok: true });
  assert.equal(JSON.parse(s.props.m.get("v:config")!).digest_time, "08:15", "merged into the settings");
  assert.equal(JSON.parse(s.props.m.get("v:config")!).feed_url, FEED_URL, "the rest kept");
  call(`doPost({ postData: { contents: JSON.stringify({ op: "secret", name: "llm_key", value: "k-9" }) } })`);
  assert.equal(s.props.m.get("secret:llm_key"), "k-9");
  assert.equal(call(`doPost({ postData: { contents: '{"op":"sync"}' } })`).queued, true);
  call(`doPost({ postData: { contents: '{"op":"sync"}' } })`);
  assert.equal(s.triggers.filter((t) => t.fn === "duelySyncNow").length, 1, "two taps: one queued run");
  assert.equal(call("doGet()").syncQueued, true);
  const r = await s.run("duelySyncNow");
  assert.equal(r.synced, true);
  assert.equal(s.triggers.filter((t) => t.fn === "duelySyncNow").length, 0, "the one-off trigger removed itself");
  const after = call("doGet()");
  assert.equal(after.syncQueued, false);
  assert.ok(after.state.items.length >= 4, "the desktop can read the result");
  assert.equal(call(`doPost({ postData: { contents: "not json" } })`).ok, false);
});

test("a failing sync is recorded, not crashed, inside Apps Script (the error path runs there too)", async () => {
  const s = await sandbox(() => "<html>not a calendar</html>");
  const r = await s.run("duelyTick");
  assert.equal(r.synced, true);
  const state = JSON.parse(s.props.m.get("v:state")!);
  assert.match(state.error, /didn't return a calendar/);
  assert.equal(s.props.m.get("v:errors"), undefined, "nothing crashed");
  s.props.setProperty("secret:channel_key", "k".repeat(43));
  const call = JSON.parse(vm.runInContext(`doGet({ parameter: { key: "${"k".repeat(43)}" } })`, s.ctx).text);
  assert.match(call.state.error, /didn't return a calendar/, "the desktop sees the reason");
});

test("the bundle doesn't use Node's globals (process, Buffer, require)", async () => {
  const { code } = await buildGas();
  for (const g of ["process.", "Buffer.", "require("]) assert.ok(!code.includes(g), `bundle uses ${g}`);
});

const KEY = "k".repeat(43);
const post = (s: any, body: object) => JSON.parse(vm.runInContext(`doPost({ postData: { contents: ${JSON.stringify(JSON.stringify({ ...body, key: KEY }))} } })`, s.ctx).text);
const get = (s: any) => JSON.parse(vm.runInContext(`doGet({ parameter: { key: "${KEY}" } })`, s.ctx).text);

test("decisions go through the inbox: a tick-done becomes a ✓ on the calendar event; undo puts it back", async () => {
  const s = await sandbox();
  s.props.setProperty("secret:channel_key", KEY);
  await s.run("duelyTick");
  const uid = "6606_2000_1@brightspace.example.ca";
  const r = post(s, { op: "decision", id: "d1", decision: { kind: "done", uid, name: "COMP 2401 Assignment 3" } });
  assert.deepEqual([r.ok, r.queued], [true, true]);
  assert.deepEqual(get(s).inbox, ["d1"], "waiting");
  await s.run("duelySyncNow");
  const st = get(s);
  assert.deepEqual(st.inbox, []);
  assert.equal(st.inboxDone.find((x: any) => x.id === "d1").ok, true);
  assert.ok(st.done[uid], "the desktop sees it done");
  const ev = s.api.events().find((e: any) => e.extendedProperties.private.bsUid === uid);
  assert.match(ev.summary, /^✓ /, "the calendar event got its ✓");
  post(s, { op: "decision", id: "d2", decision: { kind: "undo", uid, name: "COMP 2401 Assignment 3" } });
  await s.run("duelySyncNow");
  assert.ok(!get(s).done[uid]);
  assert.doesNotMatch(s.api.events().find((e: any) => e.extendedProperties.private.bsUid === uid).summary, /^✓/);
  assert.equal(post(s, { op: "decision", decision: { kind: "nonsense" } }).ok, false, "bad decisions are refused at the door");
});

test("an accepted study suggestion becomes study blocks in the calendar", async () => {
  const s = await sandbox();
  s.props.setProperty("secret:channel_key", KEY);
  const due = Date.parse("2030-10-09T23:59:00-04:00");
  s.props.setProperty("v:actions", JSON.stringify({ a1: { id: "a1", type: "add_study_blocks", key: "study:x", status: "proposed", created: Date.now(), summary: "",
    args: { name: "Assignment 3", plan: { uid: "6606_2000_1@brightspace.example.ca", course: "COMP 2401", title: "Assignment 3", kind: "assignment", due,
      blocks: [{ s: due - 30 * 3600e3, e: due - 28 * 3600e3 }] } } } }));
  s.props.setProperty("v:config", JSON.stringify({ ...CONFIG, study_blocks: true }));
  assert.ok(get(s).actions.some((a: any) => a.id === "a1" && a.status === "proposed"), "the desktop sees the question");
  post(s, { op: "decision", id: "d1", decision: { kind: "decide", id: "a1", button: "add" } });
  await s.run("duelySyncNow");
  assert.equal(get(s).inboxDone.find((x: any) => x.id === "d1").ok, true);
  assert.ok(s.api.events().some((e: any) => /^study:/.test(e.extendedProperties.private.bsUid)), "study block in the calendar");
});

test("stop / start / forget / email, and the engine version", async () => {
  const s = await sandbox();
  s.props.setProperty("secret:channel_key", KEY);
  s.props.setProperty("secret:llm_key", "k-1");
  s.run("duelySetup");
  assert.match(get(s).version, /^[0-9a-f]{12}$/);
  assert.equal(get(s).aiKeySet, true);
  post(s, { op: "email", on: true });
  assert.equal(get(s).emailAlerts, true);
  post(s, { op: "stop" });
  assert.deepEqual(get(s).triggers, []);
  post(s, { op: "start" });
  assert.deepEqual(get(s).triggers, ["duelyTick"]);
  post(s, { op: "forget" });
  const st = get(s);
  assert.deepEqual([st.triggers, st.aiKeySet, st.emailAlerts], [[], false, false]);
  assert.equal(JSON.parse(s.props.m.get("v:config")!).feed_url, "", "the Brightspace link is gone");
});

test("the storage guard trims when script properties grow past 350 KB", async () => {
  const s = await sandbox();
  const big = Object.fromEntries(Array.from({ length: 2600 }, (_, i) => [`fp${i}`, { keep: true, type: "assignment", title: "x".repeat(120), reason: "" }]));
  await vm.runInContext(`Duely.propsStore().put("ai-cache", ${JSON.stringify(big)})`, s.ctx);
  assert.ok(vm.runInContext("Duely.propsStore().bytes()", s.ctx) > 350 * 1024);
  await vm.runInContext("Duely.keepStorageSmall(Duely.propsStore())", s.ctx);
  assert.ok(vm.runInContext("Duely.propsStore().bytes()", s.ctx) < 100 * 1024);
});
