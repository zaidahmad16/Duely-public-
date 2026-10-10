// The desktop app in cloud mode (P3.5): the script in the student's Google account is the engine and
// the only thing that writes to the calendar; this is what the app shows and sends. Plain Node, tested
// against the real bundle in the Apps Script sandbox (test/cloudapp.test.ts).
import { randomBytes } from "node:crypto";
import type { Store } from "../core/util.ts";
import type { ScriptApi } from "../google/script.ts";
import type { Upcoming } from "../shared/types.ts";
import { type Bundle, type CloudLink, type CloudState, cached, channel, keep, update } from "./cloud.ts";
import type { Decision } from "./decisions.ts";
import { upcoming } from "./view.ts";

/** Settings the engine uses, as sent to the script. Never the desktop's own calendar id (the script
 *  has its own calendar), never keys, never app-only fields. */
const ENGINE_FIELDS = ["feed_url", "announcement_feeds", "ai", "use_ai", "ai_daily_limit", "chat_daily_limit", "tz", "notifications", "phone_alerts",
  "study_blocks", "study_hours", "study_block_hours", "study_window_days", "study_day", "digest_daily", "digest_time", "digest_weekly", "weekly_day",
  "weekly_time", "heavy_threshold", "briefings", "calendar_name", "overrides", "sync_types", "reminders", "event_reminders", "lookback_days",
  "term", "terms", "classes", "exams", "discord_relay"];

export function engineConfig(cfg: any, tz: string): any {
  const out: any = {};
  for (const k of ENGINE_FIELDS) if (cfg[k] !== undefined) out[k] = cfg[k];
  if (out.ai) out.ai = { provider: out.ai.provider, model: out.ai.model, baseUrl: out.ai.baseUrl ?? "" };
  if (!out.tz) out.tz = tz;                                      // the student's zone, not the script's default
  return out;
}

export type CloudAppDeps = {
  store: Store;
  link: () => Promise<CloudLink | null>;
  saveLink: (l: CloudLink) => Promise<void>;
  fetch: typeof fetch;
  notify: (title: string, body: string, click?: string) => Promise<void>;
  tz: () => string;
  /** the engine this app version carries, and the Apps Script API (for updates) */
  bundle?: () => Bundle | null;
  scriptApi?: () => Promise<ScriptApi>;
};

export function cloudApp(d: CloudAppDeps) {
  // decisions sent but not yet in the script's state: shown as if done (optimistic)
  const pending = new Map<string, Decision>();

  async function ch() {
    const l = await d.link();
    if (!l) throw new Error("Duely isn't installed in your Google account yet.");
    return channel(l, d.fetch);
  }

  /** Reads the script's state, keeps it for offline use, shows new alerts once. */
  async function refresh(): Promise<CloudState> {
    const s = await (await ch()).read();
    await keep(d.store, s);
    for (const r of s.inboxDone ?? []) if (pending.has(r.id) && !(s.inbox ?? []).includes(r.id)) pending.delete(r.id);
    await d.store.put("done", s.done ?? {});                    // local chat answers see the same done marks
    const seen = (await d.store.get<number>("cloud-outbox-seen")) ?? -1;
    const fresh = (s.outbox ?? []).filter((o) => o.at > seen);
    if (seen === -1) {                                          // first read: old alerts aren't news
      await d.store.put("cloud-outbox-seen", Math.max(0, ...fresh.map((o) => o.at)));
    } else if (fresh.length) {
      for (const o of fresh.slice(-5)) await d.notify(o.title, o.body, o.click || undefined).catch(() => {});
      await d.store.put("cloud-outbox-seen", Math.max(...fresh.map((o) => o.at)));
    }
    return s;
  }

  async function current(): Promise<CloudState | null> {
    try { return await refresh(); } catch { return cached(d.store); }
  }

  return {
    refresh,
    current,

    /** Upcoming from the script's items, with pending decisions applied. */
    async upcoming(now = Date.now()): Promise<Upcoming> {
      const s = (await cached(d.store)) ?? (await current());
      const done: Record<string, number> = { ...(s?.done ?? {}) };
      const answered = new Set<string>();
      for (const p of pending.values()) {
        if (p.kind === "done") done[p.uid] = now;
        else if (p.kind === "undo") delete done[p.uid];
        else answered.add(p.id);
      }
      const actions = (s?.actions ?? []).filter((a: any) => !answered.has(a.id));
      return upcoming(s?.state?.items ?? [], done, actions, d.tz(), now);
    },

    async decide(decision: Decision): Promise<void> {
      const id = `d${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
      await (await ch()).post({ op: "decision", id, decision });
      pending.set(id, decision);
    },

    /** Sync now: the script runs within a few minutes (Google decides when); resolves when its state shows the new run. */
    async sync(o: { timeoutMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<CloudState> {
      const c = await ch();
      const before = (await cached(d.store))?.state?.time ?? 0;
      await c.post({ op: "sync" });
      const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const until = Date.now() + (o.timeoutMs ?? 150e3);
      for (;;) {
        await sleep(o.everyMs ?? 5000);
        const s = await refresh();
        if ((s.state?.time ?? 0) > before && !s.syncQueued) return s;
        if (Date.now() > until) throw new Error("Google hasn't started Duely's run yet. It will within a few minutes, and on its own every 10 minutes.");
      }
    },

    async pushSettings(cfg: any): Promise<void> { await (await ch()).post({ op: "config", config: engineConfig(cfg, d.tz()) }); },
    async setAiKey(key: string): Promise<void> { await (await ch()).post({ op: "secret", name: "llm_key", value: key }); },
    /** The Discord device token, so the script sends alerts to Discord itself ("" removes it). */
    async setDiscord(token: string): Promise<void> { await (await ch()).post({ op: "secret", name: "discord_link", value: token }); },
    async email(on: boolean): Promise<void> { await (await ch()).post({ op: "email", on }); },
    async stop(): Promise<void> { await (await ch()).post({ op: "stop" }); },
    async start(): Promise<void> { await (await ch()).post({ op: "start" }); },
    async forget(): Promise<void> { await (await ch()).post({ op: "forget" }); },

    /** Puts this app's engine in the script when it's newer. `needsApproval`: run setup again. */
    async updateEngine(): Promise<{ changed: boolean; needsApproval: boolean }> {
      const l = await d.link(), b = d.bundle?.();
      if (!l || !b || !d.scriptApi) return { changed: false, needsApproval: false };
      const r = await update(await d.scriptApi(), l, b, d.tz());
      if (r.changed) await d.saveLink(r.link);
      return { changed: r.changed, needsApproval: r.needsApproval };
    },
  };
}

export type CloudApp = ReturnType<typeof cloudApp>;
