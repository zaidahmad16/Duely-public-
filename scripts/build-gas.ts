// Builds Duely's Apps Script project: out/gas/Code.js (the engine + src/gas, one file) and
// out/gas/appsscript.json (the manifest). Apps Script calls top-level functions by name, so the bundle
// is wrapped in one global (Duely) and small named functions call into it.
//   node --experimental-strip-types scripts/build-gas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { manifest as makeManifest } from "../src/gas/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(root, "out", "gas");

export { SCRIPT_SCOPES as SCOPES } from "../src/gas/manifest.ts";

export async function buildGas(timeZone = "America/Toronto"): Promise<{ code: string; manifest: string; version: string }> {
  const r = await build({
    entryPoints: [join(root, "src/gas/main.ts")], bundle: true, write: false, format: "iife", globalName: "Duely",
    platform: "neutral", target: "es2020", minify: false, legalComments: "none",
  });
  const body = r.outputFiles[0].text;
  // the engine's version: a hash of its code, so the app can tell when the installed script is older
  const version = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const code = `${body}
var DUELY_ENGINE_VERSION = ${JSON.stringify(version)};
// Apps Script entry points (run by name)
function duelyTick() { return Duely.duelyTick(); }
function duelyStop() { return Duely.duelyStop(); }
function duelySyncNow() { return Duely.duelySyncNow(); }
// The desktop app's channel, deployed as a private web app. Both answer synchronously: a web app's reply
// is read as soon as the function returns (Sync now queues a run instead of waiting for it).
// Every call must carry the channel key (doGet: ?key=…, doPost: {"key": …}).
function doGet(e) {
  if (!Duely.keyOk(e && e.parameter && e.parameter.key)) return Duely.json({ ok: false, error: "not allowed" });
  return Duely.json(Duely.readState());
}
function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (x) { return Duely.json({ ok: false, error: "bad JSON" }); }
  if (!Duely.keyOk(body.key)) return Duely.json({ ok: false, error: "not allowed" });
  return Duely.json(Duely.command(body));
}
`;
  const manifest = makeManifest(timeZone);
  return { code, manifest, version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, manifest, version } = await buildGas();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "Code.js"), code);
  writeFileSync(join(OUT, "appsscript.json"), manifest);
  writeFileSync(join(OUT, "version.txt"), version);
  console.log(`out/gas/Code.js ${(code.length / 1024).toFixed(0)} KB`);
}
