// Duely's engine in the student's Google account, seen from the desktop app (P3.5): install it, wait
// for the one-time approval, talk to it (read its state, send settings and decisions), keep it up to
// date. Plain Node with injected fetch and Apps Script API, so it's tested without Google.
import { randomBytes } from "node:crypto";
import type { Store } from "../core/util.ts";
import { type ScriptApi, type ScriptFile } from "../google/script.ts";
import { SCRIPT_SCOPES, START_FILE, configFile, manifest } from "../gas/manifest.ts";

/** Where the installed engine is, and the key to talk to it. Kept as a secret (it's a credential). */
export type CloudLink = { scriptId: string; deploymentId: string; url: string; key: string; version: string; scopes: string;
  /** the Google account it's in (links open in that account) */ account?: string };

export type Bundle = { code: string; version: string };

export type CloudState = {
  ok: boolean; error?: string; version: string; state: any; health: any; sched: any; outbox: any[]; bytes: number;
  syncQueued: boolean; done: Record<string, number>; actions: any[]; study: any; inbox: string[];
  inboxDone: { id: string; at: number; ok: boolean; error?: string }[]; emailAlerts: boolean; aiKeySet: boolean; triggers: string[];
};

const scopesSig = () => [...SCRIPT_SCOPES].sort().join(" ");

function files(bundle: Bundle, tz: string, config: object, key: string): ScriptFile[] {
  return [
    { name: "Start", type: "SERVER_JS", source: START_FILE },        // first: the editor opens on it
    { name: "appsscript", type: "JSON", source: manifest(tz) },
    { name: "Code", type: "SERVER_JS", source: bundle.code },
    { name: "Config", type: "SERVER_JS", source: configFile(config, key) },
  ];
}

/** Makes the project, uploads the engine and publishes its web app. The student then approves it once
 *  (runs duelySetup); `waitForApproval` notices. */
export async function install(api: ScriptApi, bundle: Bundle, tz: string, firstConfig: object, account = ""): Promise<CloudLink> {
  const key = randomBytes(32).toString("base64url");
  const scriptId = await api.create("Duely");
  await api.upload(scriptId, files(bundle, tz, firstConfig, key));
  const v = await api.version(scriptId, `Duely ${bundle.version}`);
  const { deploymentId, url } = await api.deploy(scriptId, v);
  return { scriptId, deploymentId, url, key, version: bundle.version, scopes: scopesSig(), ...(account ? { account } : {}) };
}

/** Updates an installed engine when the app carries a newer one. The web-app URL stays the same.
 *  `needsApproval`: the new version asks for different permissions, so the student must run setup again. */
export async function update(api: ScriptApi, link: CloudLink, bundle: Bundle, tz: string): Promise<{ link: CloudLink; changed: boolean; needsApproval: boolean }> {
  if (link.version === bundle.version) return { link, changed: false, needsApproval: false };
  await api.upload(link.scriptId, files(bundle, tz, {}, link.key));
  const v = await api.version(link.scriptId, `Duely ${bundle.version}`);
  const url = await api.redeploy(link.scriptId, link.deploymentId, v);
  const needsApproval = link.scopes !== scopesSig();
  return { link: { ...link, url, version: bundle.version, scopes: scopesSig() }, changed: true, needsApproval };
}

/** The script in Google's editor, in the right account (a browser signed in to several Google accounts
 *  would otherwise open it in the default one, which can't see it). */
export const editorUrl = (link: Pick<CloudLink, "scriptId" | "account">) =>
  `https://script.google.com/home/projects/${link.scriptId}/edit${link.account ? `?authuser=${encodeURIComponent(link.account)}` : ""}`;

/** Talking to the installed engine. Every call carries the channel key. */
export function channel(link: CloudLink, f: typeof fetch = fetch) {
  const parse = async (r: Response) => {
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error(r.status >= 400 ? `Duely's script answered ${r.status}` : "Duely's script isn't answering yet."); }
  };
  return {
    async read(): Promise<CloudState> {
      const d = await parse(await f(`${link.url}?key=${encodeURIComponent(link.key)}`, { redirect: "follow" }));
      if (!d.ok) throw new Error(d.error === "not allowed" ? "Duely's script hasn't been approved yet." : d.error ?? "Duely's script didn't answer.");
      return d as CloudState;
    },
    async post(body: Record<string, unknown>): Promise<any> {
      const d = await parse(await f(link.url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "follow",
        body: JSON.stringify({ ...body, key: link.key }) }));
      if (!d.ok) throw new Error(d.error ?? "Duely's script didn't accept that.");
      return d;
    },
  };
}

/** After install: waits until the student has run duelySetup (the channel key is accepted). */
export async function waitForApproval(ch: ReturnType<typeof channel>, o: { timeoutMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<CloudState> {
  const until = Date.now() + (o.timeoutMs ?? 15 * 60e3);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    try { return await ch.read(); } catch (e) {
      if (Date.now() >= until) throw new Error("Duely's script wasn't approved in time. Open it again and click Run.");
    }
    await sleep(o.everyMs ?? 3000);
  }
}

/** The last state read, kept for offline use. */
export async function cached(store: Store): Promise<CloudState | null> { return store.get<CloudState>("cloud-state"); }
export async function keep(store: Store, s: CloudState): Promise<void> { await store.put("cloud-state", { ...s, readAt: Date.now() }); }
