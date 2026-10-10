// The app's services, built once after Electron is ready: the data store, the keychain-backed
// secrets, the student's AI, Google Calendar, desktop notifications. They become the runner's Deps.
import { execFile } from "node:child_process";
import { BrowserWindow, Notification, safeStorage, shell } from "electron";
import { NeedsAuth, googleCal } from "../core/gcal.ts";
import { type Client, parseClient, tokenSource } from "../google/oauth.ts";
import { makeLLM } from "../llm/adapters.ts";
import type { LLM, Provider } from "../llm/types.ts";
import { dataDir } from "../node/paths.ts";
import type { Deps } from "../node/runner.ts";
import { type Cipher, type Secrets, secretStore } from "../node/secrets.ts";
import { fileStore } from "../node/store.ts";

export type Services = { deps: Deps; secrets: Secrets; store: ReturnType<typeof fileStore>; weakKeychain: boolean };

const cipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};

/** Links from notifications open in the browser only if they're web links. */
export function openSafe(url: string): void {
  try { if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* not a URL */ }
}

export function services(showWindow: () => void): Services {
  const store = fileStore(dataDir());
  const secrets = secretStore(store, cipher);
  // Linux without a keyring: Electron falls back to a fixed key ("basic_text"); the UI warns about it
  const weakKeychain = process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text";

  let tokens: { key: string; get: () => Promise<string> } | null = null;
  const deps: Deps = {
    store,
    fetch: (i, init) => fetch(i, init),
    async llm(): Promise<LLM | undefined> {
      const ai = ((await store.get<any>("config")) ?? {}).ai ?? {};
      if (!ai.provider || !ai.model) return undefined;
      const apiKey = (await secrets.get("llm_key").catch(() => null)) ?? "";
      return makeLLM({ provider: ai.provider as Provider, model: ai.model, apiKey, baseUrl: ai.baseUrl });
    },
    async calendar() {
      const [clientText, refresh] = await Promise.all([secrets.get("google_client"), secrets.get("google_refresh")]);
      if (!clientText || !refresh) throw new NeedsAuth("Google isn't connected yet. Connect it in Duely's settings.");
      const client: Client = parseClient(clientText);
      const key = `${client.client_id}\u0000${refresh}`;
      if (tokens?.key !== key) tokens = { key, get: tokenSource(client, refresh) };
      return googleCal(await tokens.get());
    },
    async notify(title, body, click) {
      if (process.env.DUELY_DEBUG) console.log("notify:", title, "|", body.slice(0, 80));
      if (!(await notificationsWork()) || !Notification.isSupported()) throw new Error("no notification service on this desktop");   // retried later
      const n = new Notification({ title, body: body.length > 600 ? body.slice(0, 597) + "…" : body, silent: false });
      n.on("click", () => (click ? openSafe(click) : showWindow()));
      n.show();
    },
  };
  return { deps, secrets, store, weakKeychain };
}

/** Linux: is there a notification service that answers? Without one, libnotify blocks the whole
 *  app for ~25 s per notification. Asked over D-Bus off the main thread (gdbus, which also starts an
 *  activatable service), at most every 10 minutes. */
let notifyCheck: { at: number; ok: Promise<boolean> } | null = null;
function notificationsWork(): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(true);
  if (notifyCheck && Date.now() - notifyCheck.at < 10 * 60e3) return notifyCheck.ok;
  const ok = !process.env.DBUS_SESSION_BUS_ADDRESS ? Promise.resolve(false) : new Promise<boolean>((resolve) => {
    execFile("gdbus", ["call", "--session", "--timeout", "5", "--dest", "org.freedesktop.Notifications",
      "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.GetServerInformation"],
    { timeout: 7000 }, (err) => resolve(!err || (err as NodeJS.ErrnoException).code === "ENOENT"));   // no gdbus: can't tell, so try
  });
  notifyCheck = { at: Date.now(), ok };
  return ok;
}

export const anyWindow = () => BrowserWindow.getAllWindows()[0];
