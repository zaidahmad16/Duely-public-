// P4: the chat kept across restarts (src/node/chatlog.ts) and rebuilt for the window (src/node/view.ts
// chatHistory): rows with today's ticks, questions live or settled; "yes" settles the card it answers;
// "what do you need from me?" is recognised; Clear forgets the engine's recent turns too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadActions } from "../src/core/actions.ts";
import { answer } from "../src/core/ask.ts";
import { memStore } from "../src/core/util.ts";
import { MAX_AGE_MS, MAX_MESSAGES, appendChat, asksForQuestions, clearChat, loadChat } from "../src/node/chatlog.ts";
import { chatHistory, resolvedBetween } from "../src/node/view.ts";
import { ITEMS } from "./fixture.ts";

const TZ = "America/Toronto";
const NOW = Date.parse("2026-10-06T12:00:00-04:00");

test("the log keeps the last 200 messages and 30 days; clear empties it and the engine's recent turns", async () => {
  const store = memStore();
  await appendChat(store, Array.from({ length: 250 }, (_, i) => ({ at: NOW - 1000 + i, who: "me" as const, text: `m${i}` })), NOW);
  const log = await loadChat(store, NOW);
  assert.equal(log.length, MAX_MESSAGES);
  assert.equal(log[0].text, "m50");
  assert.equal(new Set(log.map((e) => e.id)).size, MAX_MESSAGES, "ids are unique");
  assert.deepEqual(await loadChat(store, NOW + MAX_AGE_MS + 1000), [], "older than 30 days: gone");
  await store.put("chat-session", { date: "2026-10-06", requests: 3, fails: 0, lastList: ["a"], turns: [{ q: "x", intent: null, said: "y", at: NOW }] });
  await clearChat(store);
  assert.deepEqual(await loadChat(store, NOW), []);
  const s: any = await store.get("chat-session");
  assert.deepEqual([s.turns, s.lastList, s.requests], [[], [], 3], "follow-ups start fresh; today's usage count stays");
});

test("a proposal made in chat, answered by typing yes: settled, and the restored chat shows it done with the row ticked", async () => {
  const store = memStore();
  let q: any;
  await answer("done comp 3106 assignment 1", ITEMS, {}, store, TZ, fetch, NOW, { onProposal: (a) => { q = a; } });
  assert.ok(q, "chat asks before marking something found by name");
  await appendChat(store, [{ at: NOW, who: "duely", text: "Mark it done?", actionIds: [q.id], picks: [{ uid: "COMP 3106/Assignment 1", day: "2026-10-09" }] }], NOW);
  let hist = chatHistory(await loadChat(store, NOW), ITEMS, {}, await loadActions(store, NOW), TZ, NOW);
  assert.equal(hist[0].questions[0].id, q.id, "still waiting: a live card");
  assert.equal(hist[0].rows[0].done, false);
  const before = await loadActions(store, NOW);
  await answer("yes", ITEMS, {}, store, TZ, fetch, NOW + 5000);
  const after = await loadActions(store, NOW + 5000);
  assert.deepEqual(resolvedBetween(before, after), [{ id: q.id, word: "Done" }], "the reply settles the card above");
  const done = (await store.get<Record<string, number>>("done")) ?? {};
  hist = chatHistory(await loadChat(store, NOW + 5000), ITEMS, done, after, TZ, NOW + 5000);
  assert.deepEqual([hist[0].questions, hist[0].resolved], [[], [{ id: q.id, word: "Done" }]]);
  assert.equal(hist[0].rows[0].done, true, "the restored row shows today's tick");
});

test("'what do you need from me?' and friends are recognised; ordinary questions aren't", () => {
  for (const s of ["what do you need from me?", "Do you need anything?", "any questions for me", "what's waiting for me", "pending questions", "what should I approve"]) {
    assert.ok(asksForQuestions(s), s);
  }
  for (const s of ["what's due tomorrow", "any quizzes this week?", "when is my next test", "what do I need to do today"]) {
    assert.ok(!asksForQuestions(s), s);
  }
});
