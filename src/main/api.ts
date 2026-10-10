// Everything the UI can ask of the main process (exposed as window.duely by the preload). Thin glue:
// the logic lives in src/node (view, settings, runner) and src/core. Secrets never leave this side.
import { app, ipcMain } from "electron";
import { loadActions } from "../core/actions.ts";
import { answer } from "../core/ask.ts";
import { loadDone } from "../core/done.ts";
import { SCOPE, connect, parseClient } from "../google/oauth.ts";
import { SCRIPT_API_SCOPES } from "../google/script.ts";
import { makeLLM } from "../llm/adapters.ts";
import { probe } from "../llm/probe.ts";
import { cached, channel, editorUrl, install, waitForApproval } from "../node/cloud.ts";
import { engineConfig } from "../node/cloudapp.ts";
import { applyDecision } from "../node/decisions.ts";
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
  // cloud mode (P3.5): the script in the student's Google account is the engine; else this computer is
  const cloudOn = async () => !!(await svc.cloudLink());
  const items = async () => (await cloudOn())
    ? ((await cached(store))?.state?.items ?? [])
    : ((await store.get<any>("state")) ?? {}).items ?? [];

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
    const link = await svc.cloudLink();
    const cs = link ? await cached(store) : null;
    const st = (link ? cs?.state : await store.get<any>("state")) ?? {};
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
      sync: { time: st.time ?? 0, error: st.error ?? "", needsGoogle: !!st.needs_google, running: !!c.jobs()?.isRunning() || !!cs?.syncQueued,
        items: (st.items ?? []).filter((i: any) => i.keep !== false).length },
      engine: link ? "cloud" : "local",
      cloud: link ? { readAt: (cs as any)?.readAt ?? 0, version: cs?.version ?? "", running: (cs?.triggers ?? []).includes("duelyTick"),
        emailAlerts: !!cs?.emailAlerts, needsApproval: !!cfg.cloud_needs_approval, editor: editorUrl(link) } : null,
    };
  });

  handle("upcoming", async (): Promise<Upcoming> => {
    if (await cloudOn()) return svc.cloud.upcoming();
    const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    return upcoming(await items(), await loadDone(store), Object.values(await loadActions(store)), tz);
  });

  handle("setDone", async (uid: string, name: string, done: boolean) => {
    if (await cloudOn()) { await svc.cloud.decide(done ? { kind: "done", uid, name } : { kind: "undo", uid, name }); c.changed(); return; }
    const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    await applyDecision(store, done ? { kind: "done", uid, name } : { kind: "undo", uid, name }, tz);
    syncSoon();
  });

  handle("decide", async (id: string, button: Button, times?: { day: string; time: string }[]) => {
    const decision = { kind: "decide" as const, id, button, ...(times ? { times } : {}) };
    const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    // cloud mode: questions come from the script, except ones chat asked here (they're only in this store)
    if (await cloudOn() && !(await loadActions(store))[id]) { await svc.cloud.decide(decision); c.changed(); return; }
    const before = await loadDone(store);
    await applyDecision(store, decision, tz);
    if (await cloudOn()) await mirrorDone(before);
    else syncSoon();
  });

  /** Cloud mode: chat runs here, on a copy of the script's done marks; what it changed goes to the script. */
  async function mirrorDone(before: Record<string, number>): Promise<void> {
    const after = await loadDone(store);
    const all = await items();
    const name = (uid: string) => { const it = all.find((i: any) => i.uid === uid); return it ? `${it.course ? it.course + " " : ""}${it.title}` : uid; };
    for (const uid of Object.keys(after)) if (!before[uid]) await svc.cloud.decide({ kind: "done", uid, name: name(uid) });
    for (const uid of Object.keys(before)) if (!after[uid]) await svc.cloud.decide({ kind: "undo", uid, name: name(uid) });
  }

  handle("chat", async (text: string): Promise<ChatReply> => {
    const ctx = await loadCtx(svc.deps);
    const all = await items();
    const doneBefore = await loadDone(store);
    let picks: { uid: string; day: string }[] = [];
    let q: Question | undefined;
    const out = await answer(String(text).slice(0, 2000), all, ctx.cfg, store, ctx.tz, svc.deps.fetch, Date.now(), {
      llm: ctx.cfg.use_ai === false ? undefined : ctx.llm,
      onList: (r) => { picks = r; },
      onProposal: (a) => { q = question(a); },
    });
    if (await cloudOn()) await mirrorDone(doneBefore).catch(() => {});   // "done 2" in chat reaches the script
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
    if (await cloudOn()) {                                               // the engine is in the script: it gets the settings too
      await svc.cloud.pushSettings(next);
      if (p?.aiKey !== undefined) await svc.cloud.setAiKey(String(p.aiKey).trim());
      return toSettings(next, await svc.secrets.has("llm_key"));
    }
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
    // Duely's own calendar (local mode) + managing Duely's script in the student's account (cloud mode)
    const refresh = await connect(client, { open: (url) => openSafe(url), scopes: [SCOPE, ...SCRIPT_API_SCOPES] });
    await svc.secrets.set("google_client", text);
    await svc.secrets.set("google_refresh", refresh);
    c.showWindow();
    syncSoon();
  });

  handle("disconnectGoogle", async () => {
    if (await cloudOn()) {                                               // the script stops and forgets keys and links
      await svc.cloud.forget().catch(() => {});
      await svc.saveCloudLink(null);
    }
    const refresh = await svc.secrets.get("google_refresh").catch(() => null);
    if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
    await svc.secrets.delete("google_refresh");
  });

  handle("syncNow", async () => {
    if (await cloudOn()) { await svc.cloud.sync(); c.changed(); return; }
    await c.jobs()?.syncNow(); c.changed();
  });

  // ---- cloud setup (P3.5): Apps Script API on? → install → the student approves once → cloud mode
  handle("cloudCheck", async () => ({ apiEnabled: await svc.scriptApi().apiEnabled(), installed: await cloudOn(),
    approved: !!(await config()).cloud_approved, bundle: !!svc.bundle() }));

  handle("cloudInstall", async () => {
    const bundle = svc.bundle();
    if (!bundle) throw new Error("This copy of Duely doesn't include its cloud engine. Reinstall Duely.");
    const { cfg, tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    const link = await install(svc.scriptApi(), bundle, tz, engineConfig(cfg, tz));
    await svc.saveCloudLink(link);
    await store.put("config", { ...(await config()), cloud_approved: false });
    openSafe(editorUrl(link));
    return { editor: editorUrl(link) };
  });

  handle("cloudWait", async () => {
    const link = await svc.cloudLink();
    if (!link) throw new Error("Duely isn't installed in your Google account yet.");
    await waitForApproval(channel(link), { timeoutMs: 10 * 60e3 });
    // approved: the script gets the full settings and the AI key, then syncs
    await svc.cloud.pushSettings(await config());
    const key = await svc.secrets.get("llm_key").catch(() => null);
    if (key) await svc.cloud.setAiKey(key);
    await store.put("config", { ...(await config()), cloud_approved: true, cloud_needs_approval: false });
    await svc.cloud.sync({ timeoutMs: 150e3 }).catch(() => {});
    c.changed();
  });

  handle("cloudTimer", async (on: boolean) => { if (on) await svc.cloud.start(); else await svc.cloud.stop(); await svc.cloud.refresh(); c.changed(); });
  handle("cloudEmail", async (on: boolean) => { await svc.cloud.email(!!on); await svc.cloud.refresh(); c.changed(); });

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
