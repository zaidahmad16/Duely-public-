// Everything the UI can ask of the main process (exposed as window.duely by the preload). Thin glue:
// the logic lives in src/node (view, settings, runner) and src/core. Secrets never leave this side.
import { app, ipcMain } from "electron";
import { decide, loadActions, record, recordDone } from "../core/actions.ts";
import { answer } from "../core/ask.ts";
import { loadDone } from "../core/done.ts";
import { studyTimes } from "../core/studychange.ts";
import { connect, parseClient } from "../google/oauth.ts";
import { makeLLM } from "../llm/adapters.ts";
import { probe } from "../llm/probe.ts";
import { loadCtx } from "../node/runner.ts";
import { aiFingerprint, aiReady, applyPatch, capResult, friendlyAIError, toSettings } from "../node/settings.ts";
import { chatText, question, rowsFor, upcoming } from "../node/view.ts";
import type { Button, ChatReply, Question, Result, SettingsPatch, Status, Upcoming } from "../shared/types.ts";
import type { Jobs } from "./jobs.ts";
import { type Services, openSafe } from "./services.ts";
import { canStartAtLogin, setStartAtLogin, startsAtLogin } from "./tray.ts";

type Ctx = { svc: Services; jobs: () => Jobs | null; changed: () => void; showWindow: () => void; onboarded: () => void };

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

export function registerApi(c: Ctx): void {
  const { svc } = c;
  const store = svc.store;
  const config = async () => (await store.get<any>("config")) ?? {};
  const items = async () => ((await store.get<any>("state")) ?? {}).items ?? [];

  // writes that change the calendar sync soon after, batched (ticking several rows = one sync)
  let syncTimer: NodeJS.Timeout | null = null;
  const syncSoon = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; void c.jobs()?.syncNow().then(c.changed); }, 1500);
  };

  const handle = <A extends unknown[], T>(name: string, fn: (...a: A) => Promise<T>) =>
    ipcMain.handle(`duely:${name}`, async (_e, ...a) => {
      try { return { ok: true, value: await fn(...(a as A)) } satisfies Result<T>; } catch (e) { return { ok: false, error: errText(e) } satisfies Result<T>; }
    });

  handle("status", async (): Promise<Status> => {
    const cfg = await config();
    const st = (await store.get<any>("state")) ?? {};
    return {
      locale: app.getSystemLocale() || app.getLocale(),
      version: app.getVersion(),
      onboarded: !!cfg.onboarded,
      feedSet: !!cfg.feed_url,
      google: await svc.secrets.has("google_refresh"),
      googleClient: await svc.secrets.has("google_client"),
      aiReady: aiReady(cfg, (await svc.secrets.get("llm_key").catch(() => null)) ?? ""),
      weakKeychain: svc.weakKeychain,
      startAtLogin: { can: canStartAtLogin(), on: startsAtLogin() },
      sync: { time: st.time ?? 0, error: st.error ?? "", needsGoogle: !!st.needs_google, running: !!c.jobs()?.isRunning(),
        items: (st.items ?? []).filter((i: any) => i.keep !== false).length },
    };
  });

  handle("upcoming", async (): Promise<Upcoming> => {
    const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    return upcoming(await items(), await loadDone(store), Object.values(await loadActions(store)), tz);
  });

  handle("setDone", async (uid: string, name: string, done: boolean) => {
    if (done) await recordDone(store, [{ uid, name }]);
    else await record(store, { type: "undo_done", key: `undo_done:${uid}`, args: { uid, name }, summary: `Put *${name}* back on the list` });
    syncSoon();
  });

  handle("decide", async (id: string, button: Button, times?: { day: string; time: string }[]) => {
    const yes = ["keep", "add", "yes"].includes(button) || (button === "change" && !!times);
    let override: Record<string, unknown> | undefined;
    if (button === "change") {
      const a = (await loadActions(store))[id];
      if (!a || a.type !== "add_study_blocks") throw new Error("That suggestion isn't open any more.");
      const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
      const values: any = {};
      (times ?? []).forEach((t, i) => { values[`day${i}`] = { v: { selected_date: t.day } }; values[`time${i}`] = { v: { selected_time: t.time } }; });
      const r = studyTimes(a.args.plan, values, tz, Date.now());
      if ("errors" in r) throw new Error(Object.values(r.errors)[0]);
      override = { plan: { ...a.args.plan, blocks: r.blocks } };
    }
    const d = await decide(store, id, yes, "button", Date.now(), override);
    if (!d.action) throw new Error(d.text);
    syncSoon();
  });

  handle("chat", async (text: string): Promise<ChatReply> => {
    const ctx = await loadCtx(svc.deps);
    const all = await items();
    let picks: { uid: string; day: string }[] = [];
    let q: Question | undefined;
    const out = await answer(String(text).slice(0, 2000), all, ctx.cfg, store, ctx.tz, svc.deps.fetch, Date.now(), {
      llm: ctx.cfg.use_ai === false ? undefined : ctx.llm,
      onList: (r) => { picks = r; },
      onProposal: (a) => { q = question(a); },
    });
    const rows = rowsFor(all, picks, await loadDone(store), ctx.tz);
    return { text: chatText(out, rows.length > 0), rows, question: q };
  });

  handle("settings", async () => toSettings(await config(), await svc.secrets.has("llm_key")));

  handle("saveSettings", async (p: SettingsPatch) => {
    const before = await config();
    const next = applyPatch(before, p ?? {});
    if (p?.aiKey !== undefined) {
      const k = String(p.aiKey).trim();
      if (k) await svc.secrets.set("llm_key", k); else await svc.secrets.delete("llm_key");
    }
    await store.put("config", next);
    if (p?.ai || p?.aiKey !== undefined) c.changed();                   // AI changed: it needs testing again (aiReady)
    if (next.feed_url !== before.feed_url || JSON.stringify(next.announcement_feeds) !== JSON.stringify(before.announcement_feeds)) syncSoon();
    return toSettings(next, await svc.secrets.has("llm_key"));
  });

  // tests the saved AI settings; a pass is recorded, which is what unlocks the app (aiReady)
  handle("testAI", async () => {
    const cfg = await config();
    const ai = cfg.ai ?? {};
    if (!ai.provider || !ai.model) return { ok: false, message: "Pick a provider and enter a model name first." };
    const apiKey = (await svc.secrets.get("llm_key").catch(() => null)) ?? "";
    let r;
    try {
      r = capResult(await probe(makeLLM({ provider: ai.provider, model: ai.model, apiKey, baseUrl: ai.baseUrl || undefined })));
    } catch (e) {
      r = { ok: false, message: friendlyAIError(errText(e)) };
    }
    const now = (await config());                                  // re-read: don't undo a change made meanwhile
    const verified = r.ok && JSON.stringify(now.ai ?? {}) === JSON.stringify(ai) ? aiFingerprint(ai, apiKey) : undefined;
    if (verified !== now.ai_verified) { await store.put("config", { ...now, ai_verified: verified }); c.changed(); }
    return r;
  });

  handle("connectGoogle", async (clientJson?: string) => {
    const text = String(clientJson ?? "") || (await svc.secrets.get("google_client")) || "";
    if (!text) throw new Error("Choose the client file you downloaded from Google Cloud first.");
    const client = parseClient(text);
    const refresh = await connect(client, { open: (url) => openSafe(url) });
    await svc.secrets.set("google_client", text);
    await svc.secrets.set("google_refresh", refresh);
    c.showWindow();
    syncSoon();
  });

  handle("disconnectGoogle", async () => {
    const refresh = await svc.secrets.get("google_refresh").catch(() => null);
    if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
    await svc.secrets.delete("google_refresh");
  });

  handle("syncNow", async () => { await c.jobs()?.syncNow(); c.changed(); });

  handle("setStartAtLogin", async (on: boolean) => { setStartAtLogin(!!on); return startsAtLogin(); });

  // agreeing to the Terms of Service and Privacy Policy (onboarding step 1): which version, and when
  handle("acceptTerms", async (version: string) => {
    await store.put("config", { ...(await config()), terms_accepted: { version: String(version).slice(0, 20), at: Date.now() } });
  });

  handle("finishOnboarding", async () => {
    await store.put("config", { ...(await config()), onboarded: true });
    c.onboarded();
    syncSoon();
  });

  handle("openLink", async (url: string) => { openSafe(String(url)); });
}
