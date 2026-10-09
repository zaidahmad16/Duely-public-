// Duely's main process: owns the window, the engine (sync, AI, notifications) and the user's data.
// The renderer only talks to it through the preload bridge (window.duely).
import { join } from "node:path";
import { BrowserWindow, app } from "electron";

const SMOKE = process.argv.includes("--smoke");   // CI: open the window, then quit with exit code 0

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980, height: 760, minWidth: 720, minHeight: 520, show: false, title: "Duely",
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.mjs"), contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => {
    if (SMOKE) { console.log("smoke: window ready"); app.quit(); return; }
    win.show();
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
