// The only bridge between the UI and the main process. Kept small and explicit on purpose.
// Every call resolves to { ok: true, value } or { ok: false, error } (src/main/api.ts).
import { contextBridge, ipcRenderer } from "electron";

const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(`duely:${name}`, ...args);

contextBridge.exposeInMainWorld("duely", {
  status: call("status"),
  upcoming: call("upcoming"),
  setDone: call("setDone"),
  decide: call("decide"),
  chat: call("chat"),
  settings: call("settings"),
  saveSettings: call("saveSettings"),
  testAI: call("testAI"),
  aiModels: call("aiModels"),
  readTimetable: call("readTimetable"),
  discordConnect: call("discordConnect"),
  chatHistory: call("chatHistory"),
  updateCheck: call("updateCheck"),
  updateRestart: call("updateRestart"),
  updateAuto: call("updateAuto"),
  chatClear: call("chatClear"),
  discordTest: call("discordTest"),
  discordDisconnect: call("discordDisconnect"),
  readExams: call("readExams"),
  addTerm: call("addTerm"),
  removeTerm: call("removeTerm"),
  addExams: call("addExams"),
  removeExam: call("removeExam"),
  connectGoogle: call("connectGoogle"),
  disconnectGoogle: call("disconnectGoogle"),
  syncNow: call("syncNow"),
  setStartAtLogin: call("setStartAtLogin"),
  finishOnboarding: call("finishOnboarding"),
  acceptTerms: call("acceptTerms"),
  cloudCheck: call("cloudCheck"),
  cloudInstall: call("cloudInstall"),
  cloudWait: call("cloudWait"),
  cloudTimer: call("cloudTimer"),
  cloudEmail: call("cloudEmail"),
  openLink: call("openLink"),
  onChanged: (fn: () => void) => { ipcRenderer.on("duely:changed", () => fn()); },
});
