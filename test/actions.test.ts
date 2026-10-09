// Ask before acting (M1): the action state machine, the R3 runtime check (no user-data write
// without a recorded yes), study blocks as proposals (+ the one-time question about the old ones),
// and Slack's Yes / No buttons.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { decide, loadActions, pendingAction, propose, record, undoLast } from "../src/core/actions.ts";
import { answer } from "../src/core/ask.ts";
import worker from "../src/core/index.ts";
import { ROLLOUT_KEY, studyForSync } from "../src/core/proposals.ts";
import { loadStudy, renderPlans } from "../src/core/study.ts";
import { type Store, memStore } from "../src/core/util.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-04T12:00:00-04:00");
const ON = { study_blocks: true };

/** A store that fails the test if user data is written while no executed action is on record
 *  (R3: the yes is saved before the change). */
function guarded(): Store & { writes: string[] } {
  const inner = memStore();
  const writes: string[] = [];
  return {
    writes,
    get: inner.get,
    put: async (k, v) => {
      if (["done", "study", "profile", "email-events"].includes(k)) {
        // the write right before this one must be a fresh action record saying it was done (or undone)
        const prevKey = writes.at(-1);
        const acts: any[] = Object.values((await inner.get("actions")) ?? {});
        const newest = acts.sort((a, b) => (b.decided ?? 0) - (a.decided ?? 0))[0];
        assert.ok(prevKey === "actions" && newest && ["executed", "reverted"].includes(newest.status),
          `R3: "${k}" written without a fresh executed action on record (previous write: ${prevKey})`);
      }
      writes.push(k);
      await inner.put(k, v);
    },
  };
}

const DRAFT = { type: "mark_done" as const, key: "mark_done:x", args: { uid: "x", name: "COMP 2406: A1" }, summary: "Mark *COMP 2406: A1* done?" };

test("state machine: propose (once per key) -> yes executes / no declines / 24 h expires; undo within 10 min", async () => {
  const store = guarded();
  const [a] = await propose(store, [DRAFT], NOW);
  assert.equal(a.status, "proposed");
  assert.deepEqual(await propose(store, [DRAFT], NOW + 1), [], "same key: never asked twice");
  assert.equal(await store.get("done"), null, "a proposal changes nothing");
  assert.equal((await pendingAction(store, NOW))?.id, a.id);
  const d = await decide(store, a.id, true, "button", NOW + 5e3);
  assert.match(d.text, /Marked \*COMP 2406: A1\* done/);
  assert.ok(((await store.get("done")) as any).x);
  assert.match((await decide(store, a.id, false, "button", NOW + 6e3)).text, /^Already done/, "a second press does nothing");
  assert.match((await undoLast(store, NOW + 60e3)).text, /^↩️ Undone/);
  assert.deepEqual(await store.get("done"), {});

  const [b] = await propose(store, [{ ...DRAFT, key: "k2" }], NOW);
  assert.match((await decide(store, b.id, false, "text", NOW + 1)).text, /stays on your list/);
  assert.deepEqual(await store.get("done"), {});

  const [c] = await propose(store, [{ ...DRAFT, key: "k3" }], NOW);
  assert.equal((await loadActions(store, NOW + 25 * 3600e3))[c.id].status, "expired");
  assert.equal(await pendingAction(store, NOW + 25 * 3600e3), null);
  assert.deepEqual(await propose(store, [{ ...DRAFT, key: "k3" }], NOW + 26 * 3600e3), [], "no answer = no nagging");
  assert.equal((await undoLast(store, NOW + 20 * 60e3)).action, null, "nothing to undo after 10 min");
});

test("R3: the chat's done flow and explicit commands write only after a recorded yes", async () => {
  const store = guarded();
  const say = (t: string) => answer(t, ITEMS, {}, store, TZ, fetch, NOW);
  await say("done comp 2406 a1");
  assert.ok(!store.writes.includes("done"));
  await say("yes");
  await say("whats due friday");
  await say("done 1");
  await record(store, { ...DRAFT, key: "cmd" }, NOW);
  assert.ok(store.writes.filter((k) => k === "done").length >= 3);
});

test("study: new work is proposed (nothing in the calendar until yes), at most 3 a run, never twice", async () => {
  const store = memStore();
  const s1 = await studyForSync(store, ITEMS, ON, TZ, false, NOW);
  assert.deepEqual(s1.render, [], "no blocks before a yes");
  assert.ok(s1.fresh.length >= 1 && s1.fresh.length <= 3);
  assert.ok(s1.fresh.every((d) => d.type === "add_study_blocks"));
  assert.match(s1.fresh[0].summary, /^\*COMP 2406 Assignment 1 - Client-side Programming\* is due Thu Oct 8, 11:59 PM\. Add work blocks to your calendar\? .*PM/);
  const made = await propose(store, s1.fresh, NOW);
  const s2 = await studyForSync(store, ITEMS, ON, TZ, false, NOW + 60e3);
  assert.ok(!s2.fresh.some((d) => made.some((m) => m.key === d.key)), "not asked again");

  await decide(store, made[0].id, true, "button", NOW + 120e3);
  const s3 = await studyForSync(store, ITEMS, ON, TZ, false, NOW + 180e3);
  assert.deepEqual(s3.render.map((p) => p.uid), [made[0].args.plan.uid]);
  const blocks = renderPlans(s3.render, ITEMS, TZ, NOW);
  assert.equal(blocks.length, made[0].args.plan.blocks.length);
  assert.ok(blocks.every((b: any) => b.uid.startsWith(`study:${made[0].args.plan.uid}:`) && b.source === "study"));
  assert.notEqual(s3.sig, s1.sig, "a yes changes the sync's fingerprint");

  await decide(store, made[1].id, false, "text", NOW + 200e3);
  const s4 = await studyForSync(store, ITEMS, ON, TZ, false, NOW + 300e3);
  assert.ok(!s4.render.some((p) => p.uid === made[1].args.plan.uid), "no = no blocks");
  assert.deepEqual(await studyForSync(store, ITEMS, {}, TZ, false, NOW), { render: [], fresh: [], sig: "off" }, "setting off: nothing");
});

test("study: blocks added before asking stay until the one-time question is answered", async () => {
  for (const yes of [true, false]) {
    const store = memStore();
    const s1 = await studyForSync(store, ITEMS, ON, TZ, true, NOW);
    assert.equal(s1.fresh.length, 1, "only the question, no new proposals at the same time");
    assert.equal(s1.fresh[0].key, ROLLOUT_KEY);
    assert.match(s1.fresh[0].summary, /^I added \d+ study blocks to your calendar before I started asking first .*Keep them\?$/);
    assert.ok(s1.render.length > 0, "still in the calendar while waiting");
    const [q] = await propose(store, s1.fresh, NOW);
    const waiting = await studyForSync(store, ITEMS, ON, TZ, true, NOW + 60e3);
    assert.equal(waiting.render.length, s1.render.length);
    assert.deepEqual(waiting.fresh, []);
    assert.match((await decide(store, q.id, yes, "button", NOW + 120e3)).text, yes ? /Keeping them/ : /removing them/);
    const after = await studyForSync(store, ITEMS, ON, TZ, true, NOW + 180e3);
    if (yes) assert.equal(Object.keys((await loadStudy(store)).approved).length, s1.render.length, "kept = accepted");
    else assert.deepEqual(after.render, [], "removed");
  }
});

// ---------------------------------------------------------------- Slack buttons

function sign(body: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  return { "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex") };
}

test("POST /slack/interact: owner's Yes executes and the message shows the outcome; others and forgeries can't", async () => {
  const m = new Map<string, string>();
  const STATE = { get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k: string, v: string) => { m.set(k, v); } };
  m.set("config", JSON.stringify({ slack_user_id: "UOWNER" }));
  const env: any = { STATE, SLACK_SIGNING_SECRET: "shh", SLACK_BOT_TOKEN: "xoxb-t" };
  const store = { get: async (k: string) => STATE.get(k), put: async (k: string, v: unknown) => STATE.put(k, JSON.stringify(v)) };
  const [a] = await propose(store, [DRAFT], Date.now());
  const posted: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { posted.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("ok"); }) as typeof fetch;
  try {
    const press = async (user: string, action = "act_yes", secret = "shh") => {
      const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", user: { id: user }, response_url: "https://hooks.slack.com/actions/x",
        actions: [{ action_id: action, value: a.id }] }));
      const waits: Promise<unknown>[] = [];
      const r = await worker.fetch(new Request("https://w/slack/interact", { method: "POST", headers: { ...sign(body, secret), "content-type": "application/x-www-form-urlencoded" }, body }),
        env, { waitUntil: (p) => { waits.push(p); } });
      await Promise.all(waits);
      return r.status;
    };
    assert.equal(await press("UOWNER", "act_yes", "wrong-secret"), 401);
    assert.equal(await store.get("done"), null);
    assert.equal(await press("USOMEONE"), 200);
    assert.equal(await store.get("done"), null, "someone else can't answer");
    assert.match(posted.at(-1).body.text, /Only the person/);
    assert.equal(await press("UOWNER"), 200);
    assert.ok(((await store.get("done")) as any).x, "the owner's Yes executed");
    const last = posted.at(-1);
    assert.equal(last.url, "https://hooks.slack.com/actions/x");
    assert.equal(last.body.replace_original, true);
    assert.match(JSON.stringify(last.body.blocks), /Marked/);
    assert.ok(!JSON.stringify(last.body.blocks).includes("act_yes"), "buttons gone after answering");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Change times: the form opens pre-filled; saving accepts the plan with the new times; bad times stay in the form", async () => {
  const { studyTimes } = await import("../src/core/studychange.ts");
  const { studyChangeModal } = await import("../src/core/slackui.ts");
  const due = Date.parse("2026-10-20T23:59:00-04:00");
  const plan = { uid: "lab1", course: "PHYS 1905", title: "Lab Report 1", kind: "lab", due,
    blocks: [{ s: Date.parse("2026-10-19T18:00:00-04:00"), e: Date.parse("2026-10-19T20:00:00-04:00") }, { s: Date.parse("2026-10-20T15:00:00-04:00"), e: Date.parse("2026-10-20T17:00:00-04:00") }] };
  const a: any = { id: "x1", type: "add_study_blocks", args: { plan, name: "PHYS 1905: Lab Report 1" }, status: "proposed" };
  const modal = studyChangeModal(a, TZ, "{}");
  assert.deepEqual(modal.blocks.filter((b: any) => b.type === "input").map((b: any) => b.element.initial_date ?? b.element.initial_time), ["2026-10-19", "18:00", "2026-10-20", "15:00"]);
  const vals = (d0: string, t0: string, d1: string, t1: string) => ({ day0: { v: { selected_date: d0 } }, time0: { v: { selected_time: t0 } }, day1: { v: { selected_date: d1 } }, time1: { v: { selected_time: t1 } } });
  const ok: any = studyTimes(plan, vals("2026-10-17", "13:00", "2026-10-18", "10:30"), TZ, NOW);
  assert.deepEqual(ok.blocks.map((b: any) => [new Date(b.s).toISOString(), (b.e - b.s) / 36e5]), [["2026-10-17T17:00:00.000Z", 2], ["2026-10-18T14:30:00.000Z", 2]]);
  assert.deepEqual((studyTimes(plan, vals("2026-10-20", "23:00", "2026-10-18", "10:00"), TZ, NOW) as any).errors, { time0: "It would end after the deadline." });
  assert.deepEqual((studyTimes(plan, vals("2026-10-01", "10:00", "2026-10-18", "10:00"), TZ, NOW) as any).errors, { day0: "That's in the past." });
  // saving = a yes with the new times, in one write, then rendered
  const store = guarded();
  const [p] = await propose(store, [{ type: "add_study_blocks", key: "study:lab1", args: { plan, name: "PHYS 1905: Lab Report 1" }, summary: "?" }], NOW);
  await decide(store, p.id, true, "button", NOW + 1000, { plan: { ...plan, blocks: ok.blocks } });
  const st: any = await store.get("study");
  assert.equal(st.approved.lab1.blocks[0].s, Date.parse("2026-10-17T13:00:00-04:00"));
});
