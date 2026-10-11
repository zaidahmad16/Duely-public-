// window.duely, typed. Calls resolve to the value or throw the main process's message.
import type { Button, CapResult, ChatMessage, ChatReply, ExamDraft, Result, Settings, SettingsPatch, Status, TermDraft, Upcoming } from "../../shared/types.ts";

type Raw = Record<string, (...a: unknown[]) => Promise<Result<any>>> & { onChanged(fn: () => void): void };
declare global { interface Window { duely: Raw } }

async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const r = await window.duely[name](...args);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}

export const api = {
  status: () => call<Status>("status"),
  upcoming: () => call<Upcoming>("upcoming"),
  setDone: (uid: string, name: string, done: boolean) => call<void>("setDone", uid, name, done),
  decide: (id: string, button: Button, times?: { day: string; time: string }[]) => call<void>("decide", id, button, times),
  chat: (text: string) => call<ChatReply>("chat", text),
  /** the saved chat (rows and question states as of now) */
  chatHistory: () => call<ChatMessage[]>("chatHistory"),
  chatClear: () => call<void>("chatClear"),
  updateCheck: () => call<void>("updateCheck"),
  updateRestart: () => call<void>("updateRestart"),
  updateAuto: (on: boolean) => call<void>("updateAuto", on),
  usageNoticeSeen: () => call<void>("usageNoticeSeen"),
  settings: () => call<Settings>("settings"),
  saveSettings: (p: SettingsPatch) => call<Settings>("saveSettings", p),
  testAI: () => call<CapResult>("testAI"),
  /** the models the saved key can use (empty when the provider can't list them) */
  aiModels: () => call<string[]>("aiModels"),
  /** screenshots (downscaled, base64) → what the AI read, for review; nothing is saved */
  readTimetable: (images: { mime: string; b64: string }[]) => call<{ terms: TermDraft[] }>("readTimetable", images),
  readExams: (images: { mime: string; b64: string }[]) => call<ExamDraft[]>("readExams", images),
  addTerm: (term: TermDraft) => call<Settings>("addTerm", term),
  removeTerm: (key: string) => call<Settings>("removeTerm", key),
  addExams: (exams: ExamDraft[]) => call<Settings>("addExams", exams),
  removeExam: (key: string) => call<Settings>("removeExam", key),
  discordConnect: () => call<Settings>("discordConnect"),
  discordTest: () => call<void>("discordTest"),
  discordDisconnect: () => call<Settings>("discordDisconnect"),
  connectGoogle: (clientJson?: string) => call<void>("connectGoogle", clientJson),
  disconnectGoogle: () => call<void>("disconnectGoogle"),
  syncNow: () => call<void>("syncNow"),
  setStartAtLogin: (on: boolean) => call<boolean>("setStartAtLogin", on),
  finishOnboarding: () => call<void>("finishOnboarding"),
  acceptTerms: (version: string) => call<void>("acceptTerms", version),
  cloudCheck: () => call<{ apiEnabled: boolean; installed: boolean; approved: boolean; bundle: boolean; account: string }>("cloudCheck"),
  cloudInstall: () => call<{ editor: string }>("cloudInstall"),
  cloudWait: () => call<void>("cloudWait"),
  cloudTimer: (on: boolean) => call<void>("cloudTimer", on),
  cloudEmail: (on: boolean) => call<void>("cloudEmail", on),
  openLink: (url: string) => call<void>("openLink", url),
  onChanged: (fn: () => void) => window.duely.onChanged(fn),
};
