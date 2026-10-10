// Duely's main process: owns the window, the engine (sync, AI, notifications) and the user's data.
// The renderer only talks to it through the preload bridge (window.duely). Closing the window keeps
// Duely running in the tray; Quit is in the tray menu.
import { join } from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import { connect, parseClient } from "../google/oauth.ts";
import { type Jobs, startJobs } from "./jobs.ts";
import { type Services, openSafe, services } from "./services.ts";
import { canStartAtLogin, makeTray, setStartAtLogin, startsAtLogin } from "./tray.ts";

const SMOKE = process.argv.includes("--smoke");   // CI: open the window, then quit with exit code 0
const HIDDEN = process.argv.includes("--hidden"); // started at login: tray only
const RES = app.isPackaged ? process.resourcesPath : join(import.meta.dirname, "../../resources");

let win: BrowserWindow | null = null;
let quitting = false;
let svc: Services;
let jobs: Jobs | null = null;

function createWindow(show: boolean): BrowserWindow {
  const w = new BrowserWindow({
    width: 980, height: 760, minWidth: 720, minHeight: 520, show: false, title: "Duely", icon: join(RES, "icon.png"),
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true },
  });
  w.once("ready-to-show", () => {
    if (SMOKE) {
      // the UI must reach the main process through the bridge, not just open
      w.webContents.executeJavaScript("window.duely.status().then((s) => typeof s.feedSet)")
        .then((t) => { console.log(t === "boolean" ? "smoke: window ready, bridge works" : `smoke: bridge returned ${t}`); app.exit(t === "boolean" ? 0 : 1); })
        .catch((e) => { console.log("smoke: bridge failed:", e?.message ?? e); app.exit(1); });
      return;
    }
    if (show) w.show();
  });
  w.on("close", (e) => { if (!quitting) { e.preventDefault(); w.hide(); } });
  w.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else w.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return w;
}

function showWindow() {
  if (!win || win.isDestroyed()) win = createWindow(true);
  else { win.show(); win.focus(); }
}

/** What the UI shows. Secrets never leave the main process; only whether they're set. */
async function status() {
  const cfg = (await svc.store.get<any>("config")) ?? {};
  const st = (await svc.store.get<any>("state")) ?? {};
  return {
    feedSet: !!cfg.feed_url,
    google: await svc.secrets.has("google_refresh"),
    ai: cfg.ai?.provider ? { provider: cfg.ai.provider, model: cfg.ai.model, keySet: await svc.secrets.has("llm_key") } : null,
    weakKeychain: svc.weakKeychain,
    startAtLogin: { can: canStartAtLogin(), on: startsAtLogin() },
    sync: { time: st.time ?? 0, error: st.error ?? "", needsGoogle: !!st.needs_google, items: (st.items ?? []).filter((i: any) => i.keep !== false).length,
      added: st.added ?? 0, updated: st.updated ?? 0, removed: st.removed ?? 0, ai: st.ai ?? "" },
  };
}

const changed = () => { if (win && !win.isDestroyed()) win.webContents.send("duely:changed"); };
const ok = async () => ({ ok: true, status: await status() });
const fail = (e: unknown) => ({ ok: false, error: (e as Error)?.message ?? String(e) });

function ipc() {
  ipcMain.handle("duely:status", () => status());
  ipcMain.handle("duely:set-feed", async (_e, url: unknown) => {
    try {
      const u = new URL(String(url).trim().replace(/^webcal:\/\//, "https://"));
      if (u.protocol !== "https:") throw new Error("The calendar link should start with https:// or webcal://");
      const cfg = (await svc.store.get<any>("config")) ?? {};
      await svc.store.put("config", { ...cfg, feed_url: u.toString() });
      void jobs?.syncNow().then(changed);
      return ok();
    } catch (e) { return fail(e instanceof TypeError ? new Error("That isn't a link.") : e); }
  });
  ipcMain.handle("duely:google-connect", async (_e, clientText: unknown) => {
    try {
      const text = String(clientText ?? "") || (await svc.secrets.get("google_client")) || "";
      const client = parseClient(text);
      const refresh = await connect(client, { open: (url) => openSafe(url) });
      await svc.secrets.set("google_client", text);
      await svc.secrets.set("google_refresh", refresh);
      showWindow();
      void jobs?.syncNow().then(changed);
      return ok();
    } catch (e) { return fail(e); }
  });
  ipcMain.handle("duely:google-disconnect", async () => {
    try {
      const refresh = await svc.secrets.get("google_refresh").catch(() => null);
      if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
      await svc.secrets.delete("google_refresh");
      return ok();
    } catch (e) { return fail(e); }
  });
  ipcMain.handle("duely:sync-now", async () => {
    try { await jobs?.syncNow(); changed(); return ok(); } catch (e) { return fail(e); }
  });
  ipcMain.handle("duely:start-at-login", async (_e, on: unknown) => {
    try { setStartAtLogin(!!on); return ok(); } catch (e) { return fail(e); }
  });
}

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    svc = services(showWindow);
    ipc();
    win = createWindow(!HIDDEN);
    if (SMOKE) return;
    makeTray(join(RES, "tray.png"), {
      open: showWindow,
      syncNow: () => { void jobs?.syncNow().then(changed); },
      quit: () => { quitting = true; app.quit(); },
    });
    jobs = startJobs(svc.deps, changed);
    app.on("activate", showWindow);
  });
  app.on("before-quit", () => { quitting = true; jobs?.stop(); });
  app.on("window-all-closed", () => { /* keep running in the tray */ });
}
