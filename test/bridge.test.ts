// The UI, the preload bridge and the main process must agree on every call: a call the UI makes that
// the bridge doesn't expose fails only at runtime ("window.duely[name] is not a function").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const names = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1]));

test("every UI call is exposed by the preload and handled by the main process", () => {
  const ui = names(read("src/renderer/ui/api.ts"), /call<[^>]*>\("(\w+)"/g);
  const preload = names(read("src/preload/index.ts"), /call\("(\w+)"\)/g);
  const main = names(read("src/main/api.ts"), /handle\("(\w+)"/g);
  assert.ok(ui.size > 10);
  for (const n of ui) {
    assert.ok(preload.has(n), `preload doesn't expose ${n}`);
    assert.ok(main.has(n), `main process doesn't handle ${n}`);
  }
});
