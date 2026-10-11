// Pasting several announcements links at once (Settings → Sources, onboarding step 4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitLinks } from "../src/renderer/ui/links.ts";

test("one per line, spaces or commas; duplicates and links already added are skipped; the rest is kept to fix", () => {
  const a = "https://b.example.ca/d2l/le/news/rss/1/course?token=x", b = "https://b.example.ca/d2l/le/news/rss/2/course?token=y";
  const r = splitLinks(`${a}\n\n${b}, ${a}  webcal://b.example.ca/feed.ics\nnot-a-link http://insecure.example`, [b]);
  assert.deepEqual(r.links, [a, "webcal://b.example.ca/feed.ics"]);
  assert.deepEqual(r.rest, ["not-a-link", "http://insecure.example"]);
  assert.deepEqual(splitLinks("   "), { links: [], rest: [] });
});
