// Development only (P3.5 Phase 0, live half): install and exercise Duely's Apps Script engine in a test
// Google account, the way the desktop app will. The sign-in is kept in DUELY_LIVE_DIR (never the repo).
//   node --experimental-strip-types scripts/gas-live.ts login --client client.json
//   ... install            create the project, upload Code.js + manifest + a test config
//   ... deploy             make the private web app (the desktop's channel)
//   ... state              GET the web app (what the desktop would show)
//   ... post '{"op":"sync"}'
//   ... runs               recent executions and how long they took
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, parseClient, tokenSource } from "../src/google/oauth.ts";
import { buildGas } from "./build-gas.ts";

const DIR = process.env.DUELY_LIVE_DIR ?? "";
if (!DIR) { console.log("set DUELY_LIVE_DIR to a private folder for the test sign-in"); process.exit(1); }
mkdirSync(DIR, { recursive: true });
const SAVED = join(DIR, "live.json");
const API = "https://script.googleapis.com/v1";
const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",     // create and update Duely's script
  "https://www.googleapis.com/auth/script.deployments",  // its private web app
  "https://www.googleapis.com/auth/script.processes",    // how long its runs take
  ...(process.env.DUELY_LIVE_DRIVE ? ["https://www.googleapis.com/auth/drive.readonly"] : []),
];
const TEST_FEED = "https://raw.githubusercontent.com/zaidahmad16/Duely-public-/p3-ui/test/fixture.ics";

type Saved = { client: string; refresh: string; scriptId?: string; webApp?: string; key?: string; scopes: string[] };
const load = (): Saved => JSON.parse(readFileSync(SAVED, "utf8"));
const save = (s: Saved) => writeFileSync(SAVED, JSON.stringify(s, null, 2), { mode: 0o600 });

async function token(): Promise<string> {
  const s = load();
  return tokenSource(parseClient(s.client), s.refresh)();
}

async function call(method: string, url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${await token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: "follow" });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status >= 400) throw new Error(`${method} ${url.replace(/\?.*/, "")} → ${r.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 500)}`);
  return data;
}

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const cmd = process.argv[2];
  if (cmd === "login") {
    const file = arg("client");
    if (!file || !existsSync(file)) throw new Error("--client <the Desktop client JSON>");
    const text = readFileSync(file, "utf8");
    const refresh = await connect(parseClient(text), { scopes: SCOPES, open: (url) => { console.log("Approve in the browser:\n" + url); spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref(); } });
    save({ client: text, refresh, scopes: SCOPES });
    console.log("signed in; scopes:", SCOPES.map((s) => s.split("/").pop()).join(", "));
    return;
  }
  const s = load();
  if (cmd === "install") {
    const { code, manifest } = await buildGas(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!s.scriptId) {
      const p = await call("POST", `${API}/projects`, { title: "Duely" });
      s.scriptId = p.scriptId; save(s);
      console.log("created project", s.scriptId);
    }
    const config = { feed_url: TEST_FEED, use_ai: false, digest_daily: false, digest_weekly: false };
    if (!s.key) { s.key = randomBytes(32).toString("base64url"); save(s); }       // the channel key
    await call("PUT", `${API}/projects/${s.scriptId}/content`, { files: [
      { name: "appsscript", type: "JSON", source: manifest },
      { name: "Code", type: "SERVER_JS", source: code },
      { name: "Config", type: "SERVER_JS", source: `// written by the Duely app\nvar DUELY_CONFIG = ${JSON.stringify(config)};\nvar DUELY_CHANNEL_KEY = ${JSON.stringify(s.key)};\n` },
    ] });
    console.log(`uploaded (${(code.length / 1024).toFixed(0)} KB). Open it and run duelySetup once:\nhttps://script.google.com/home/projects/${s.scriptId}/edit`);
    return;
  }
  if (!s.scriptId) throw new Error("run install first");
  if (cmd === "deploy") {
    const v = await call("POST", `${API}/projects/${s.scriptId}/versions`, { description: "Duely" });
    const d = await call("POST", `${API}/projects/${s.scriptId}/deployments`, { versionNumber: v.versionNumber, manifestFileName: "appsscript", description: "Duely channel" });
    const web = (d.entryPoints ?? []).find((e: any) => e.entryPointType === "WEB_APP");
    s.webApp = web?.webApp?.url; save(s);
    console.log("web app:", s.webApp ?? JSON.stringify(d).slice(0, 400));
    return;
  }
  if (cmd === "state" || cmd === "post") {
    if (!s.webApp) throw new Error("run deploy first");
    // the web app is reached by link + channel key (no Google sign-in on these calls)
    const r = cmd === "state"
      ? await fetch(`${s.webApp}?key=${encodeURIComponent(s.key ?? "")}`, { redirect: "follow" })
      : await fetch(s.webApp, { method: "POST", headers: { "content-type": "application/json" }, redirect: "follow",
        body: JSON.stringify({ ...JSON.parse(process.argv[3] ?? "{}"), key: s.key }) });
    const text = await r.text();
    let out: any = text;
    try { out = JSON.parse(text); } catch { out = `${r.status}: ${text.slice(0, 300)}`; }
    const brief = typeof out === "object" ? { ...out, state: out.state ? { time: out.state.time, error: out.state.error, items: out.state.items?.length, added: out.state.added, updated: out.state.updated } : null } : out;
    console.log(JSON.stringify(brief, null, 2).slice(0, 2500));
    return;
  }
  if (cmd === "ai") {
    // the test Gemini key from a private file; the model is picked from what this key can actually use
    const key = readFileSync(join(DIR, "gemini.key"), "utf8").trim();
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    if (!r.ok) throw new Error(`Gemini didn't accept the key (${r.status})`);
    const models: any[] = (await r.json()).models ?? [];
    const usable = models.filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent")).map((m) => String(m.name).replace(/^models\//, ""));
    const pick = arg("model") ?? usable.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort().pop() ?? usable.find((n) => /flash/.test(n));
    console.log("flash models:", usable.filter((n) => /flash/.test(n)).join(", "));
    if (!pick) throw new Error("no flash model available");
    const post = async (body: unknown) => {
      const res = await fetch(s.webApp!, { method: "POST", headers: { "content-type": "application/json" }, redirect: "follow", body: JSON.stringify({ ...(body as object), key: s.key }) });
      return res.json();
    };
    console.log("secret:", JSON.stringify(await post({ op: "secret", name: "llm_key", value: key })));
    console.log("config:", JSON.stringify(await post({ op: "config", config: { use_ai: true, ai: { provider: "gemini", model: pick },
      announcement_feeds: ["https://raw.githubusercontent.com/zaidahmad16/Duely-public-/p3-ui/test/fixture-announcements.xml"] } })));
    console.log("using", pick);
    return;
  }
  if (cmd === "runs") {
    const r = await call("GET", `${API}/processes:listScriptProcesses?scriptId=${s.scriptId}&pageSize=20`);
    for (const p of r.processes ?? []) console.log(`${p.startTime}  ${p.functionName.padEnd(14)} ${p.processType.padEnd(12)} ${p.processStatus.padEnd(10)} ${p.duration ?? ""}`);
    return;
  }
  console.log("usage: login --client FILE | install | deploy | state | post JSON | runs");
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
