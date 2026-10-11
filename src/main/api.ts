// Everything the UI can ask of the main process (exposed as window.duely by the preload). Thin glue:
// the logic lives in src/node (view, settings, runner) and src/core. Secrets never leave this side.
import { app, ipcMain } from "electron";
import { loadActions } from "../core/actions.ts";
import { answer } from "../core/ask.ts";
import { loadDone } from "../core/done.ts";
import { cleanExams, cleanTerm, readExams, readTimetable, removeExam, removeTerm, saveExams, saveTerm } from "../core/timetableImport.ts";
import { SCOPE, connect, parseClient } from "../google/oauth.ts";
import { SCRIPT_API_SCOPES, accountEmail } from "../google/script.ts";
import { makeLLM } from "../llm/adapters.ts";
import { listModels, pickModel } from "../llm/models.ts";
import { PROBE_TIMEOUT_MS, probe } from "../llm/probe.ts";
import { cached, channel, editorUrl, install, waitForApproval } from "../node/cloud.ts";
import { engineConfig } from "../node/cloudapp.ts";
import { appendChat, asksForQuestions, clearChat, loadChat } from "../node/chatlog.ts";
import { applyDecision } from "../node/decisions.ts";
import { RELAY_URL, connect as discordConnect, discordWords, parseLink, sendTest, unlink as unlinkDiscord } from "../node/discord.ts";
import { loadCtx } from "../node/runner.ts";
import { aiFingerprint, aiReady, applyPatch, autoModel, capResult, friendlyAIError, toSettings } from "../node/settings.ts";
import { chatHistory, chatText, question, resolvedBetween, rowsFor, upcoming } from "../node/view.ts";
import type { Image } from "../llm/types.ts";
import type { Button, CapResult, ChatMessage, ChatReply, ExamDraft, Question, Result, SettingsPatch, Status, TermDraft, Upcoming } from "../shared/types.ts";
import type { Jobs } from "./jobs.ts";
import type { Updates } from "./updates.ts";
import { type Services, openSafe } from "./services.ts";
import { canStartAtLogin, setStartAtLogin, startsAtLogin } from "./tray.ts";

type Ctx = { svc: Services; jobs: () => Jobs | null; changed: () => void; showWindow: () => void; onboarded: () => void; updates: () => Updates | null };

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

  /** Discord as Settings shows it: who's connected, and the last sending problem in words. In cloud mode
   *  the script sends, so its last error counts. */
  const discordState = async () => {
    const link = parseLink(await svc.secrets.get("discord_link").catch(() => null));
    if (!link) return null;
    const err = (await cloudOn()) ? (await cached(store))?.discordError : await store.get<any>("discord-error");
    return { name: link.name, error: err?.code ? discordWords(err.code) : "" };
  };
  const settingsOut = async (cfg: any) => toSettings(cfg, await svc.secrets.has("llm_key"), await discordState());

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
      update: c.updates()?.state() ?? null,
      onboarded: !!cfg.onboarded,
      feedSet: !!cfg.feed_url,
      google: await svc.secrets.has("google_refresh"),
      googleExpired: !!(await store.get("google-expired")) && await svc.secrets.has("google_refresh"),
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

  const upcomingNow = async (): Promise<Upcoming> => {
    if (await cloudOn()) return svc.cloud.upcoming();
    const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    return upcoming(await items(), await loadDone(store), Object.values(await loadActions(store)), tz);
  };
  handle("upcoming", upcomingNow);

  /** Every question Duely asked: chat's own (this computer) and, in cloud mode, the script's. */
  const allActions = async (): Promise<Record<string, any>> => {
    const local = await loadActions(store);
    if (!(await cloudOn())) return local;
    const remote = (await cached(store))?.actions ?? [];
    return { ...Object.fromEntries(remote.map((a: any) => [a.id, a])), ...local };
  };

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
    const said = String(text).slice(0, 2000), at = Date.now();
    if (asksForQuestions(said)) {                                      // "what do you need from me?": the open questions
      const qs = (await upcomingNow()).questions;
      const reply = qs.length ? (qs.length === 1 ? "Just one thing:" : `${qs.length} things are waiting for you:`) : "Nothing right now. I'll ask when something needs you.";
      await appendChat(store, [{ at, who: "me", text: said }, { at: at + 1, who: "duely", text: reply, actionIds: qs.map((q) => q.id) }], at);
      return { text: reply, rows: [], questions: qs };
    }
    const ctx = await loadCtx(svc.deps);
    const all = await items();
    const doneBefore = await loadDone(store);
    const before = await loadActions(store);
    let picks: { uid: string; day: string }[] = [];
    let q: Question | undefined;
    const out = await answer(String(text).slice(0, 2000), all, ctx.cfg, store, ctx.tz, svc.deps.fetch, Date.now(), {
      llm: ctx.cfg.use_ai === false ? undefined : ctx.llm,
      onList: (r) => { picks = r; },
      onProposal: (a) => { q = question(a); },
    });
    if (await cloudOn()) await mirrorDone(doneBefore).catch(() => {});   // "done 2" in chat reaches the script
    const rows = rowsFor(all, picks, await loadDone(store), ctx.tz);
    const after = await loadActions(store);
    const resolved = resolvedBetween(before, after);
    const reply = chatText(out, rows.length > 0);
    await appendChat(store, [{ at, who: "me", text: said },
      { at: Date.now(), who: "duely", text: reply, ...(picks.length ? { picks } : {}), ...(q ? { actionIds: [(q as Question).id] } : {}) }], at);
    return { text: reply, rows, question: q, ...(resolved.length ? { resolved } : {}) };
  });

  /** The saved chat, rebuilt with today's rows (ticks show) and where each question stands now. */
  handle("chatHistory", async (): Promise<ChatMessage[]> => {
    const log = await loadChat(store);
    if (!log.length) return [];
    const { tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    return chatHistory(log, await items(), await loadDone(store), await allActions(), tz);
  });
  handle("chatClear", async () => { await clearChat(store); });

  handle("settings", async () => settingsOut(await config()));

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
      return settingsOut(next);
    }
    if (next.feed_url !== before.feed_url || JSON.stringify(next.announcement_feeds) !== JSON.stringify(before.announcement_feeds)) syncSoon();
    return settingsOut(next);
  });

  // tests the saved AI settings; a pass is recorded, which is what unlocks the app (aiReady). With no
  // model chosen by the student, Duely finds one that works with the key (src/llm/models.ts).
  handle("testAI", async () => {
    const cfg = await config();
    const ai = cfg.ai ?? {};
    const auto = autoModel(ai);
    if (!ai.provider) return { ok: false, message: "Pick a provider first." };
    if (!auto && !ai.model) return { ok: false, message: "Enter a model name first." };
    const apiKey = (await svc.secrets.get("llm_key").catch(() => null)) ?? "";
    const conn = { provider: ai.provider, apiKey, baseUrl: ai.baseUrl || undefined };
    let r: CapResult; let model: string = ai.model;
    try {
      if (auto) {
        const pick = await pickModel(conn);
        r = capResult(pick.caps);
        if (pick.model) model = pick.model;
      } else {
        r = capResult(await probe(makeLLM({ ...conn, model })));
      }
    } catch (e) {
      r = { ok: false, message: friendlyAIError(errText(e)) };
    }
    if (r.ok) { r.model = model; r.auto = auto; }
    const now = (await config());                                  // re-read: don't undo a change made meanwhile
    if (JSON.stringify(now.ai ?? {}) !== JSON.stringify(ai)) return r;
    const tested = { ...ai, model, ...(auto ? { auto: true } : {}) };
    const verified = r.ok ? aiFingerprint(tested, apiKey) : undefined;
    if (verified !== now.ai_verified || model !== ai.model) {
      const next = { ...now, ai: tested, ai_verified: verified };
      await store.put("config", next);
      c.changed();
      if (model !== ai.model && await cloudOn()) await svc.cloud.pushSettings(next).catch(() => {});   // the script reads with it too
    }
    return r;
  });

  handle("aiModels", async () => {
    const ai = (await config()).ai ?? {};
    if (!ai.provider) return [];
    const apiKey = (await svc.secrets.get("llm_key").catch(() => null)) ?? "";
    const list = await listModels({ provider: ai.provider, apiKey, model: "", baseUrl: ai.baseUrl || undefined }, fetch, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    return (list.models ?? []).sort();
  });

  handle("connectGoogle", async (clientJson?: string) => {
    const text = String(clientJson ?? "") || (await svc.secrets.get("google_client")) || "";
    if (!text) throw new Error("Choose the client file you downloaded from Google Cloud first.");
    const client = parseClient(text);
    // Duely's own calendar (local mode) + managing Duely's script in the student's account (cloud mode)
    const refresh = await connect(client, { open: (url) => openSafe(url), scopes: [SCOPE, ...SCRIPT_API_SCOPES] });
    await svc.secrets.set("google_client", text);
    await svc.secrets.set("google_refresh", refresh);
    await store.put("google-expired", null);
    c.showWindow();
    syncSoon();
    if (await cloudOn()) void svc.updateEngine().then(c.changed, (e) => console.error("engine update failed:", e));   // one that waited for this sign-in
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

  // ---- timetable and exam screenshots (P5): read → the student reviews → "Add to calendar" saves
  const readCtx = async () => {
    const ctx = await loadCtx(svc.deps);
    if (!ctx.llm) throw new Error("Set up your AI first, in Settings → AI.");
    return ctx;
  };
  /** The screenshots as sent by the window: a few images, each a reasonable size. Never saved. */
  const screenshots = (images: unknown): Image[] => {
    const list = Array.isArray(images) ? images : [];
    if (!list.length) throw new Error("Choose at least one screenshot.");
    if (list.length > 10) throw new Error("That's a lot of screenshots: choose up to 10.");
    return list.map((i: any) => {
      if (!/^image\/(png|jpeg|webp)$/.test(String(i?.mime)) || typeof i?.b64 !== "string" || i.b64.length > 12e6) throw new Error("Those files need to be PNG, JPEG or WebP screenshots.");
      return { mime: i.mime, b64: i.b64 };
    });
  };
  const readError = (e: unknown) => {
    const m = errText(e);
    return new Error(/^No (classes|upcoming exams)|AI limit/.test(m) ? m : `Couldn't read the screenshots. ${friendlyAIError(m)}`);
  };
  /** A timetable or exam change: saved, then on the calendar at the next sync (here, or the script's). */
  const saveEngine = async (next: any) => {
    await store.put("config", next);
    c.changed();
    if (await cloudOn()) {
      await svc.cloud.pushSettings(next);
      void svc.cloud.sync().then(c.changed, () => {});                // Google starts it within a few minutes
    } else syncSoon();
    return settingsOut(next);
  };

  handle("readTimetable", async (images: unknown) => {
    const ctx = await readCtx();
    try { return await readTimetable(ctx, screenshots(images), await items(), ctx.cfg.academic_dates_url ?? ""); } catch (e) { throw readError(e); }
  });
  handle("readExams", async (images: unknown) => {
    const ctx = await readCtx();
    try { return await readExams(ctx, screenshots(images)); } catch (e) { throw readError(e); }
  });
  handle("addTerm", async (draft: TermDraft) => {
    let term;
    try { term = cleanTerm(draft); } catch (e) { throw new Error(`Check the term dates: ${errText(e)}.`); }
    if (!term.classes.length) throw new Error("Tick at least one class.");
    if (term.classes.length < (draft?.classes?.length ?? 0)) throw new Error("Some classes have days or times Duely can't read. Fix or untick them.");
    return saveEngine(saveTerm(await config(), term));
  });
  handle("removeTerm", async (key: string) => saveEngine(removeTerm(await config(), String(key))));
  handle("addExams", async (drafts: ExamDraft[]) => {
    const exams = cleanExams({ exams: drafts });
    if (!exams.length) throw new Error("Tick at least one exam.");
    if (exams.length < (drafts?.length ?? 0)) throw new Error("Some exams have a date or time Duely can't read. Fix or untick them.");
    return saveEngine(saveExams(await config(), exams));
  });
  handle("removeExam", async (key: string) => saveEngine(removeExam(await config(), String(key))));

  // ---- Discord alerts (P6): connect through Duely's relay; alerts follow the Notifications switches
  const relayUrl = async () => (await config()).discord_relay || RELAY_URL;
  handle("discordConnect", async () => {
    const relay = await relayUrl();
    const link = await discordConnect({ relay, open: (url) => openSafe(url) });
    await svc.secrets.set("discord_link", JSON.stringify(link));
    await store.put("discord-error", null);
    await store.put("discord-seen", Date.now());
    if (await cloudOn()) await svc.cloud.setDiscord(link.token);      // the script sends from now on, laptop on or off
    c.showWindow();
    c.changed();
    return settingsOut(await config());
  });
  handle("discordTest", async () => {
    const link = parseLink(await svc.secrets.get("discord_link").catch(() => null));
    if (!link) throw new Error("Connect Discord first.");
    try { await sendTest(link, { relay: await relayUrl() }); await store.put("discord-error", null); } catch (e) {
      await store.put("discord-error", { code: (e as any).code ?? "error", at: Date.now() });
      throw e;
    }
  });
  handle("discordDisconnect", async () => {
    const link = parseLink(await svc.secrets.get("discord_link").catch(() => null));
    if (link) await unlinkDiscord(link, { relay: await relayUrl() }).catch(() => {});   // the relay forgets it and removes the member
    if (await cloudOn()) await svc.cloud.setDiscord("").catch(() => {});
    await svc.secrets.delete("discord_link");
    await store.put("discord-error", null);
    c.changed();
    return settingsOut(await config());
  });

  // ---- updates (P7)
  handle("updateCheck", async () => { await c.updates()?.check(true); });
  handle("updateRestart", async () => { await c.updates()?.restart(); });
  handle("updateAuto", async (on: boolean) => { await c.updates()?.setAuto(!!on); });

  handle("syncNow", async () => {
    if (await cloudOn()) { await svc.cloud.sync(); c.changed(); return; }
    await c.jobs()?.syncNow(); c.changed();
  });

  // ---- cloud setup (P3.5): Apps Script API on? → install → the student approves once → cloud mode
  handle("cloudCheck", async () => ({ apiEnabled: await svc.scriptApi().apiEnabled(), installed: await cloudOn(),
    approved: !!(await config()).cloud_approved, bundle: !!svc.bundle(), account: await accountEmail(svc.googleToken) }));

  handle("cloudInstall", async () => {
    const bundle = svc.bundle();
    if (!bundle) throw new Error("This copy of Duely doesn't include its cloud engine. Reinstall Duely.");
    const { cfg, tz } = await loadCtx({ ...svc.deps, llm: async () => undefined });
    const link = await install(svc.scriptApi(), bundle, tz, engineConfig(cfg, tz), await accountEmail(svc.googleToken));
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
    c.changed();
    // approved: answer now (the setup screen shows ✓); the first sync carries on by itself
    void svc.cloud.sync({ timeoutMs: 150e3 }).catch(() => {}).then(c.changed);
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
