// The only bridge between the UI and the main process. Kept small and explicit on purpose.
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("duely", {
  version: () => process.versions.electron,
});
