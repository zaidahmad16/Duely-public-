// What a feed item is: a review session or prep isn't an exam, a "Final Project" hand-in isn't either.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildItems } from "../src/core/classify.ts";
import { category } from "../src/core/kinds.ts";
import { parse } from "../src/core/ical.ts";

const feed = (events: [string, string][]) => `BEGIN:VCALENDAR\nVERSION:2.0\n${events.map(([s, d], i) =>
  `BEGIN:VEVENT\nUID:t${i}@x\nDTSTART:20301015T150000Z\nDTEND:20301015T160000Z\nSUMMARY:${s}\nLOCATION:STAT 2507A Stats\nDESCRIPTION:${d}\nEND:VEVENT`).join("\n")}\nEND:VCALENDAR`;

test("exams vs. things that only mention one", () => {
  const items = buildItems(parse(feed([
    ["Midterm Exam", ""], ["Midterm Review Session", ""], ["Final Exam Prep Workshop", ""], ["Final Project - Due", ""],
    ["Quiz 3 - Availability Ends", "Review chapters 1-3 before the midterm"], ["Test 2", ""],
  ]), "America/Toronto", "20200101"), "America/Toronto");
  const by = Object.fromEntries(items.map((i) => [i.title, [i.type, category(i)]]));
  assert.deepEqual(by["Midterm Exam"], ["exam", "test"]);
  assert.deepEqual(by["Midterm Review Session"], ["event", "event"]);
  assert.deepEqual(by["Final Exam Prep Workshop"], ["event", "event"]);
  assert.equal(by["Final Project"][0], "assignment");
  assert.equal(by["Quiz 3"][0], "quiz", "a description mentioning a review doesn't change a quiz");
  assert.equal(by["Test 2"][1], "test");
});
