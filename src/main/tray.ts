// The tray icon (Duely keeps syncing with its window closed) and "start at login".
// Electron only does login items on Windows and macOS; on Linux it's an XDG autostart file.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Menu, Tray, app, nativeImage } from "electron";

const autostartFile = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "duely.desktop");

/** Only a packaged app can start at login (a dev build has no stable command to run). */
export const canStartAtLogin = () => app.isPackaged;

export function startsAtLogin(): boolean {
  if (process.platform === "linux") return existsSync(autostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

export function setStartAtLogin(on: boolean): void {
  if (!canStartAtLogin()) return;
  if (process.platform !== "linux") { app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] }); return; }
  const file = autostartFile();
  if (!on) { rmSync(file, { force: true }); return; }
  const exe = process.env.APPIMAGE ?? process.execPath;          // an AppImage runs from its own path
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Duely\nExec="${exe.replace(/"/g, '\\"')}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
}

export function makeTray(icon: string, actions: { open(): void; syncNow(): void; quit(): void }): Tray | null {
  try {
    const tray = new Tray(nativeImage.createFromPath(icon));
    tray.setToolTip("Duely");
    const menu = () => Menu.buildFromTemplate([
      { label: "Open Duely", click: actions.open },
      { label: "Sync now", click: actions.syncNow },
      { type: "separator" },
      { label: "Start at login", type: "checkbox", enabled: canStartAtLogin(), checked: startsAtLogin(),
        click: (item) => { setStartAtLogin(item.checked); tray.setContextMenu(menu()); } },
      { type: "separator" },
      { label: "Quit Duely", click: actions.quit },
    ]);
    tray.setContextMenu(menu());
    tray.on("click", actions.open);
    return tray;
  } catch (e) {
    console.error("no tray on this desktop:", e);                 // the window still works
    return null;
  }
}
