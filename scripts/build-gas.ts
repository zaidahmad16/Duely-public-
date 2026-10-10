// Builds Duely's Apps Script project: out/gas/Code.js (the engine + src/gas, one file) and
// out/gas/appsscript.json (the manifest). Apps Script calls top-level functions by name, so the bundle
// is wrapped in one global (Duely) and small named functions call into it.
//   node --experimental-strip-types scripts/build-gas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export async function buildGas(timeZone = "America/Toronto"): Promise<{ code: string; manifest: string }> {
  const r = await build({
    entryPoints: [join(root, "src/gas/main.ts")], bundle: true, write: false, format: "iife", globalName: "Duely",
    platform: "neutral", target: "es2020", minify: false, legalComments: "none",
  });
  const code = `${r.outputFiles[0].text}
// Apps Script entry points (run by name)
function duelyTick() { return Duely.duelyTick(); }
function duelySetup() { return Duely.duelySetup(); }
function duelyStop() { return Duely.duelyStop(); }
`;
  const manifest = JSON.stringify({ timeZone, runtimeVersion: "V8", exceptionLogging: "STACKDRIVER", oauthScopes: SCOPES }, null, 2);
  return { code, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, manifest } = await buildGas();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "Code.js"), code);
  writeFileSync(join(OUT, "appsscript.json"), manifest);
  console.log(`out/gas/Code.js ${(code.length / 1024).toFixed(0)} KB`);
}
