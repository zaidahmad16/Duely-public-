// The project builds on Node's own test runner (same as the engine's tests).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("package metadata", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.productName, "Duely");
  assert.equal(pkg.license, "MIT");
});
