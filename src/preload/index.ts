// The only bridge between the UI and the main process. Kept small and explicit on purpose.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("duely", {
  version: () => process.versions.electron,
  status: () => ipcRenderer.invoke("duely:status"),
  setFeed: (url: string) => ipcRenderer.invoke("duely:set-feed", url),
  connectGoogle: (clientJson: string) => ipcRenderer.invoke("duely:google-connect", clientJson),
  disconnectGoogle: () => ipcRenderer.invoke("duely:google-disconnect"),
  syncNow: () => ipcRenderer.invoke("duely:sync-now"),
  setStartAtLogin: (on: boolean) => ipcRenderer.invoke("duely:start-at-login", on),
  onChanged: (fn: () => void) => { ipcRenderer.on("duely:changed", () => fn()); },
});
