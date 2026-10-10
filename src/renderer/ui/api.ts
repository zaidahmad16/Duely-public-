// window.duely, typed. Calls resolve to the value or throw the main process's message.
import type { Button, CapResult, ChatReply, Result, Settings, SettingsPatch, Status, Upcoming } from "../../shared/types.ts";

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
  settings: () => call<Settings>("settings"),
  saveSettings: (p: SettingsPatch) => call<Settings>("saveSettings", p),
  testAI: (draft?: { provider: string; model: string; baseUrl?: string; key?: string }) => call<CapResult>("testAI", draft),
  connectGoogle: (clientJson?: string) => call<void>("connectGoogle", clientJson),
  disconnectGoogle: () => call<void>("disconnectGoogle"),
  syncNow: () => call<void>("syncNow"),
  setStartAtLogin: (on: boolean) => call<boolean>("setStartAtLogin", on),
  finishOnboarding: () => call<void>("finishOnboarding"),
  openLink: (url: string) => call<void>("openLink", url),
  onChanged: (fn: () => void) => window.duely.onChanged(fn),
};
