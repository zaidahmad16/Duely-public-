// Builds Duely's Apps Script project: out/gas/Code.js (the engine + src/gas, one file) and
// out/gas/appsscript.json (the manifest). Apps Script calls top-level functions by name, so the bundle
// is wrapped in one global (Duely) and small named functions call into it.
//   node --experimental-strip-types scripts/build-gas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(root, "out", "gas");

/** Permissions the script itself asks for (shown on Google's approval screen). */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",   // only the calendar Duely makes
  "https://www.googleapis.com/auth/script.external_request", // Brightspace, the AI provider
  "https://www.googleapis.com/auth/script.scriptapp",       // its own 10-minute timer
  "https://www.googleapis.com/auth/script.send_mail",       // alerts by email, only if turned on
  "https://www.googleapis.com/auth/userinfo.email",         // whose inbox those emails go to
];

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
function duelySetup() { return Duely.duelySetup(); }
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
  const manifest = JSON.stringify({ timeZone, runtimeVersion: "V8", exceptionLogging: "STACKDRIVER", oauthScopes: SCOPES,
    webapp: { executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS" },   // guarded by the channel key
    // the Calendar advanced service: switched on for the script by this line alone
    dependencies: { enabledAdvancedServices: [{ userSymbol: "Calendar", serviceId: "calendar", version: "v3" }] } }, null, 2);
  return { code, manifest, version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, manifest } = await buildGas();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "Code.js"), code);
  writeFileSync(join(OUT, "appsscript.json"), manifest);
  console.log(`out/gas/Code.js ${(code.length / 1024).toFixed(0)} KB`);
}
