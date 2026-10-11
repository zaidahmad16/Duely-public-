// Duely's main process: owns the window, the engine (sync, AI, notifications) and the user's data.
// The renderer only talks to it through the preload bridge (window.duely). Closing the window keeps
// Duely running in the tray; Quit is in the tray menu.
import { join } from "node:path";
import { BrowserWindow, app, nativeTheme } from "electron";
import { registerApi } from "./api.ts";
import { type Jobs, startJobs } from "./jobs.ts";
import { type Services, openSafe, services } from "./services.ts";
import { makeTray } from "./tray.ts";
import { type Updates, updates } from "./updates.ts";

import { noKeyring } from "./keyring.ts";

// Linux without a keyring service: Electron can't encrypt at all, so a student could never save their
// AI key (and Duely needs one). Fall back to Electron's basic store; the UI warns that keys are then
// only lightly protected (services.ts weakKeychain). Must be decided before the app is ready.
if (noKeyring()) app.commandLine.appendSwitch("password-store", "basic");

// A separate data folder (tests, a second copy) gets its own Electron profile too, so it doesn't
// collide with a running Duely (single-instance lock, cookies, cache).
if (process.env.DUELY_HOME) app.setPath("userData", join(process.env.DUELY_HOME, "electron"));

const SMOKE = process.argv.includes("--smoke");   // CI: open the window, then quit with exit code 0
const HIDDEN = process.argv.includes("--hidden"); // started at login: tray only
const RES = app.isPackaged ? process.resourcesPath : join(import.meta.dirname, "../../resources");

let win: BrowserWindow | null = null;
let quitting = false;
let svc: Services;
let onboarded = false;
let jobs: Jobs | null = null;
let upd: Updates | null = null;

function createWindow(show: boolean): BrowserWindow {
  const w: BrowserWindow = new BrowserWindow({
    ...FULL, minWidth: 640, minHeight: 560, show: false, title: "Duely", icon: join(RES, "icon.png"),
    autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1a19" : "#f7f6f3",
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true },
  });
  w.once("ready-to-show", () => {
    if (SMOKE) {
      // the UI must reach the main process through the bridge, not just open
      w.webContents.executeJavaScript("window.duely.status().then((r) => r.ok && typeof r.value.feedSet)")
        .then((t) => {
          // an installed copy must carry the cloud engine (resources/gas) and know its version
          const engine = !app.isPackaged || !!svc.bundle();
          console.log(t === "boolean" ? `smoke: window ready, bridge works · Duely ${app.getVersion()}${app.isPackaged ? ` · engine ${engine ? "found" : "MISSING"}` : ""}` : `smoke: bridge returned ${t}`);
          app.exit(t === "boolean" && engine ? 0 : 1);
        })
        .catch((e) => { console.log("smoke: bridge failed:", e?.message ?? e); app.exit(1); });
      return;
    }
    if (process.env.DUELY_SHOT) { void screenshot(w); return; }
    if (show) w.show();
  });
  sizeFor(onboarded, w);
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

/** Development only (scripts/shots.sh): run DUELY_SHOT_JS in the page, capture DUELY_SHOT (a PNG
 *  path, or several separated by "|" with "@@" between their scripts), then quit. Never set in use. */
async function screenshot(w: BrowserWindow) {
  const { writeFileSync } = await import("node:fs");
  const [wd, ht] = (process.env.DUELY_SHOT_SIZE ?? "1100x760").split("x").map(Number);
  w.setMinimumSize(320, 320); w.setContentSize(wd, ht);
  w.showInactive();
  const outs = process.env.DUELY_SHOT!.split("|"), scripts = (process.env.DUELY_SHOT_JS ?? "").split("@@");
  for (let i = 0; i < outs.length; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (scripts[i]?.trim()) await w.webContents.executeJavaScript(scripts[i]).catch((e) => console.log("shot script failed:", e?.message));
    await new Promise((r) => setTimeout(r, Number(process.env.DUELY_SHOT_WAIT ?? 900)));
    writeFileSync(outs[i], (await w.webContents.capturePage()).toPNG());
    console.log("shot:", outs[i]);
  }
  quitting = true; app.exit(0);
}

const changed = () => { if (win && !win.isDestroyed()) win.webContents.send("duely:changed"); };

/** Setup happens in a compact window; Duely itself gets the full size. */
const COMPACT = { width: 600, height: 680 }, FULL = { width: 1080, height: 740 };
function sizeFor(onboarded: boolean, w: BrowserWindow) {
  const size = onboarded ? FULL : COMPACT;
  w.setMinimumSize(onboarded ? 640 : 520, 560);
  w.setSize(size.width, size.height);
  w.center();
}

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    if (process.env.DUELY_THEME === "dark" || process.env.DUELY_THEME === "light") nativeTheme.themeSource = process.env.DUELY_THEME;
    svc = services(showWindow);
    onboarded = !!((await svc.store.get<any>("config")) ?? {}).onboarded;
    registerApi({ svc, jobs: () => jobs, changed, showWindow, updates: () => upd,
      onboarded: () => { onboarded = true; if (win && !win.isDestroyed()) sizeFor(true, win); } });
    win = createWindow(!HIDDEN);
    if (SMOKE) return;
    const tray = makeTray(join(RES, "tray.png"), {
      open: showWindow,
      syncNow: () => { void jobs?.syncNow().then(changed); },
      quit: () => { quitting = true; app.quit(); },
      update: () => { const s = upd?.state(); return s?.state === "ready" ? { label: `Restart to update (v${s.version})`, click: () => void upd!.restart() } : null; },
    });
    // updates from GitHub Releases: only a packaged app has something to update
    if (app.isPackaged) {
      const { default: pkg } = await import("electron-updater");
      const cfg = async () => (await svc.store.get<any>("config")) ?? {};
      upd = updates({
        updater: pkg.autoUpdater as any, version: app.getVersion(), platform: process.platform, isAppImage: !!process.env.APPIMAGE,
        busy: () => !!jobs?.isRunning(),
        auto: async () => (await cfg()).auto_update !== false,
        saveAuto: async (on) => { await svc.store.put("config", { ...(await cfg()), auto_update: on }); },
        onChange: () => { changed(); tray?.refresh(); },
      });
      setTimeout(() => void upd?.check(), 30e3);                       // after start-up's own work
    }
    jobs = startJobs(svc.deps, changed, {
      on: async () => !!(await svc.cloudLink()),
      read: () => svc.cloud.refresh(),
      update: () => svc.updateEngine(),
    });
    void svc.discordCheckIn();
    const checkIns = setInterval(() => void svc.discordCheckIn(), 6 * 3600e3);
    app.on("before-quit", () => clearInterval(checkIns));
    app.on("activate", showWindow);
  });
  app.on("before-quit", () => { quitting = true; jobs?.stop(); upd?.stop(); });
  app.on("window-all-closed", () => { /* keep running in the tray */ });
}
