// The chat as the student sees it, kept across restarts: their messages and Duely's replies, with the
// list picks (rows are rebuilt from current items, so a tick shows) and the proposal a reply carried.
// Only on this computer (never sent to the script or the Discord relay). The engine's own context is
// separate: the last 3 turns in "chat-session" (src/core/ask.ts).
import type { Store } from "../core/util.ts";

export type LogEntry = {
  id: string; at: number; who: "me" | "duely"; text: string;
  picks?: { uid: string; day: string }[];
  /** the questions this reply asked or showed (action ids: chat's own, or the script's in cloud mode) */
  actionIds?: string[];
};

export const CHAT_KEY = "chat-log";
export const MAX_MESSAGES = 200;
export const MAX_AGE_MS = 30 * 86400e3;

const fresh = (log: LogEntry[], now: number) => log.filter((e) => now - e.at < MAX_AGE_MS).slice(-MAX_MESSAGES);

export async function loadChat(store: Store, now = Date.now()): Promise<LogEntry[]> {
  const log = (await store.get<LogEntry[]>(CHAT_KEY)) ?? [];
  return Array.isArray(log) ? fresh(log, now) : [];
}

export async function appendChat(store: Store, entries: Omit<LogEntry, "id">[], now = Date.now()): Promise<LogEntry[]> {
  const log = await loadChat(store, now);
  const added = entries.map((e, i) => ({ ...e, id: `${now.toString(36)}${i}` }));
  await store.put(CHAT_KEY, fresh([...log, ...added], now));
  return added;
}

/** Forgets the chat, and the engine's recent turns with it (so follow-ups start fresh). */
export async function clearChat(store: Store): Promise<void> {
  await store.put(CHAT_KEY, []);
  const s = await store.get<any>("chat-session");
  if (s) await store.put("chat-session", { ...s, turns: [], lastList: [] });
}

/** "Do you need anything from me?": the student asking for Duely's open questions. */
export function asksForQuestions(text: string): boolean {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  return /\b(what|anything) (do|does) (you|duely) need( from me)?\b|\bdo you need anything\b|\bany (open |pending |waiting )?questions( for me)?\b|\bwhat('s| is| are) (waiting|pending)( for me)?\b|\b(open|pending|waiting) questions\b|\bneed my (answer|input|ok|okay)\b|\bwhat (should|do) i (answer|approve|decide)\b/.test(t);
}
