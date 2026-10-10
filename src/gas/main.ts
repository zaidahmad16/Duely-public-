// Duely's engine as an Apps Script project in the student's own Google account (P3.5). Bundled into one
// file by scripts/build-gas.ts. Apps Script has no fetch, Web Crypto, URL, timers or (reliably) Intl time
// zones, so this file supplies them from Apps Script's own services, then runs the same engine the
// desktop app runs (src/node/runner.ts) on a 10-minute timer.
import type { Cal } from "../core/gcal.ts";
import { setOffsetSource } from "../core/time.ts";
import { type Store, setSha1Source, setSleepSource } from "../core/util.ts";
import { makeLLM } from "../llm/adapters.ts";
import type { Provider } from "../llm/types.ts";
import { RELAY_URL } from "../shared/discord.ts";
import { loadActions } from "../core/actions.ts";
import { loadDone } from "../core/done.ts";
import { loadStudy } from "../core/study.ts";
import { applyDecision, parseDecision } from "../node/decisions.ts";
import { type Deps, FULL_EVERY_MS, loadCtx, newSched, tick } from "../node/runner.ts";

declare const Calendar: any, UrlFetchApp: any, Utilities: any, PropertiesService: any, ScriptApp: any, Session: any, MailApp: any, ContentService: any;

// ---------------------------------------------------------------- host services

/** fetch() over UrlFetchApp (synchronous underneath; the engine only needs status, ok, text, json). */
export function gasFetch(input: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const ct = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
  const contentType = ct ? headers[ct] : undefined;
  if (ct) delete headers[ct];
  const method = (init.method ?? "GET").toLowerCase();
  const r = UrlFetchApp.fetch(String(input), {
    method, headers, muteHttpExceptions: true, followRedirects: true,
    ...(init.body !== undefined && method !== "get" ? { payload: init.body, contentType } : {}),
  });
  const status: number = r.getResponseCode();
  const text: string = r.getContentText();
  return Promise.resolve({
    status, ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: (k: string) => { const h = r.getHeaders(); const key = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? h[key] : null; } },
  });
}

/** UTC offset (minutes east) from Apps Script's formatter: "Z" gives "-0400". */
export function gasOffset(t: number, tz: string): number {
  const z: string = Utilities.formatDate(new Date(t), tz === "Z" ? "UTC" : tz, "Z");
  const m = /^([+-])(\d{2})(\d{2})$/.exec(z);
  if (!m) throw new Error(`unknown time zone ${tz}`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function gasSha1(s: string): string {
  const bytes: number[] = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s, Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

const CHUNK = 8000;   // properties: 9 KB per value

/** The engine's key-value store over script properties. Long values are split into numbered chunks;
 *  a value is written whole or not at all (chunks first, then the index that points at them). Properties
 *  are synchronous, so there are sync versions too (the web app channel must answer synchronously). */
export function propsStore(props = PropertiesService.getScriptProperties()): Store & { getSync<T = any>(key: string): T | null; putSync(key: string, value: unknown): void; bytes(): number } {
  const getSync = <T = any>(key: string): T | null => {
    const head = props.getProperty(`v:${key}`);
    if (head === null) return null;
    const m = /^chunks:(\d+):(\w+)$/.exec(head);
    if (!m) return JSON.parse(head) as T;
    let text = "";
    for (let i = 0; i < Number(m[1]); i++) text += props.getProperty(`c:${key}:${m[2]}:${i}`) ?? "";
    return JSON.parse(text) as T;
  };
  const putSync = (key: string, value: unknown): void => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error(`refusing to store undefined under ${key}`);
    const old = props.getProperty(`v:${key}`);
    if (text.length <= CHUNK) props.setProperty(`v:${key}`, text);
    else {
      const gen = Date.now().toString(36);
      const n = Math.ceil(text.length / CHUNK);
      const batch: Record<string, string> = {};
      for (let i = 0; i < n; i++) batch[`c:${key}:${gen}:${i}`] = text.slice(i * CHUNK, (i + 1) * CHUNK);
      props.setProperties(batch);
      props.setProperty(`v:${key}`, `chunks:${n}:${gen}`);
    }
    const m = old && /^chunks:(\d+):(\w+)$/.exec(old);       // the previous chunks are now unused
    if (m) for (let i = 0; i < Number(m[1]); i++) props.deleteProperty(`c:${key}:${m[2]}:${i}`);
  };
  return {
    getSync, putSync,
    async get<T = any>(key: string) { return getSync<T>(key); },
    async put(key: string, value: unknown) { putSync(key, value); },
    bytes() {
      const all = props.getProperties();
      return Object.entries(all).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
    },
  };
}

/** The engine's calendar through Apps Script's Calendar advanced service (declared in the manifest, so
 *  it's switched on for the script automatically; the REST API would need the student to enable it in a
 *  hidden Cloud project). Same five calls as core/gcal.ts. */
export function gasCalendar(): Cal {
  const gone = (e: unknown) => /not ?found|404|410|deleted/i.test(String((e as Error)?.message ?? e));
  const forbidden = (e: unknown) => /forbidden|403/i.test(String((e as Error)?.message ?? e));
  return {
    async ensureCalendar(name, id, tz) {
      if (id) {
        try { if (Calendar.Calendars.get(id)) return id; } catch (e) { if (!gone(e) && !forbidden(e)) throw e; }
      }
      return Calendar.Calendars.insert({ summary: name, timeZone: tz }).id;
    },
    async listEvents(calId) {
      let out: any[] = [], token: string | undefined;
      do {
        const page = Calendar.Events.list(calId, { maxResults: 2500, showDeleted: false, ...(token ? { pageToken: token } : {}) }) ?? {};
        out = out.concat(page.items ?? []);
        token = page.nextPageToken;
      } while (token);
      return out;
    },
    async insert(calId, body) { Calendar.Events.insert(body, calId); },
    async update(calId, eventId, body) { Calendar.Events.update(body, calId, eventId); },
    async delete(calId, eventId) { try { Calendar.Events.remove(calId, eventId); } catch (e) { if (!gone(e)) throw e; } },
  };
}

// ---------------------------------------------------------------- wiring

export function install(): void {
  const g = globalThis as any;
  if (typeof g.fetch !== "function") g.fetch = gasFetch;
  // no timers in Apps Script: fetches are synchronous, so a timeout race can't fire anyway
  if (typeof g.setTimeout !== "function") { g.setTimeout = () => 0; g.clearTimeout = () => {}; }
  setOffsetSource(gasOffset);
  setSha1Source(gasSha1);
  setSleepSource(async (ms) => { Utilities.sleep(ms); });
}

export function deps(store: Store): Deps {
  return {
    store,
    fetch: gasFetch as any,
    defaultTz: () => Session.getScriptTimeZone(),
    async llm() {
      const ai = ((await store.get<any>("config")) ?? {}).ai ?? {};
      if (!ai.provider || !ai.model) return undefined;
      const apiKey = PropertiesService.getScriptProperties().getProperty("secret:llm_key") ?? "";
      return makeLLM({ provider: ai.provider as Provider, model: ai.model, apiKey, baseUrl: ai.baseUrl }, gasFetch as any);
    },
    async calendar() { return gasCalendar(); },
    async notify(title, body, click) {
      // kept for the desktop app to show; emailed too when the student turned that on
      const out: any[] = ((await store.get<any[]>("outbox")) ?? []).slice(-49);
      out.push({ at: Date.now(), title, body, click: click ?? "" });
      await store.put("outbox", out);
      const cfg = (await store.get<any>("config")) ?? {};
      if (cfg.email_alerts) MailApp.sendEmail(Session.getEffectiveUser().getEmail(), `Duely: ${title}`, `${body}${click ? `\n\n${click}` : ""}`);
      discord("/alert", { title, body, click: click ?? "" }, cfg);
    },
  };
}

/** The 10-minute trigger (and Sync now, with force). */
/** A Discord DM through Duely's relay, when the student connected Discord (the app put the device token
 *  here, so alerts reach their phone with the laptop off). The last failure is kept for the app. */
function discord(path: string, body: Record<string, unknown>, cfg: any): boolean {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("secret:discord_link");
  if (!token) return false;
  try {
    const r = UrlFetchApp.fetch(`${cfg?.discord_relay || RELAY_URL}${path}`, { method: "post", contentType: "application/json",
      payload: JSON.stringify({ token, ...body }), muteHttpExceptions: true });
    if (r.getResponseCode() >= 300) {
      let code = "error";
      try { code = JSON.parse(r.getContentText()).code ?? code; } catch { /* not JSON */ }
      props.setProperty("v:discord-error", JSON.stringify({ code, at: Date.now() }));
      return false;
    }
    props.deleteProperty("v:discord-error");
    return true;
  } catch { return false; }
}

export async function duelyTick(now = Date.now(), force = false): Promise<{ synced: boolean }> {
  install();
  const store = propsStore();
  // Discord's daily check-in (the relay forgets links unseen for 30 days), from here so it holds while the laptop is off
  const seen = Number(store.getSync("discord-seen")) || 0;
  if (now - seen > 20 * 3600e3 && discord("/seen", {}, store.getSync("config"))) store.putSync("discord-seen", now);
  const saved = (await store.get<any>("sched")) ?? {};
  const sched = newSched();
  if (force) saved.lastFull = 0;
  if (await processInbox(store, now)) saved.lastFull = 0;       // decisions change the calendar: sync now
  // a trigger "every 10 minutes" can fire a little early: count a full sync as due a bit before 10 min
  sched.lastFull = (saved.lastFull ?? 0) - 90e3;
  sched.lastQuick = saved.lastQuick ?? 0;
  const r = await tick(deps(store), sched, { now });
  await store.put("sched", { lastFull: sched.lastFull + (r.synced ? 0 : 90e3), lastQuick: sched.lastQuick });
  await keepStorageSmall(store);
  return r;
}

/** The desktop's decisions, waiting in "inbox" (written by the channel, which must answer at once).
 *  Applied in order with the engine's own rules; each result is kept briefly in "inbox-done" so the
 *  desktop can drop its optimistic copy. Returns how many were applied. */
export async function processInbox(store: ReturnType<typeof propsStore>, now = Date.now()): Promise<number> {
  const items: any[] = store.getSync("inbox") ?? [];
  if (!items.length) return 0;
  store.putSync("inbox", []);                                    // taken: a crash can't apply them twice
  const { tz } = await loadCtx(deps(store));
  const results: any[] = (store.getSync<any[]>("inbox-done") ?? []).filter((x) => now - x.at < 3600e3);
  for (const it of items) {
    const d = parseDecision(it.decision);
    try {
      if (!d) throw new Error("That change wasn't understood.");
      await applyDecision(store, d, tz, now);
      results.push({ id: it.id, at: now, ok: true });
    } catch (e) {
      results.push({ id: it.id, at: now, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  }
  store.putSync("inbox-done", results.slice(-50));
  return items.length;
}

/** Script properties hold 500 KB in all. The caches trim themselves to what's in the feeds; this is the
 *  safety net: past 350 KB the AI cache (rebuilt on the next sync) and the logs go first. */
export async function keepStorageSmall(store: ReturnType<typeof propsStore>): Promise<void> {
  if (store.bytes() < 350 * 1024) return;
  store.putSync("ai-cache", {});
  store.putSync("outbox", (store.getSync<any[]>("outbox") ?? []).slice(-20));
  store.putSync("errors", (store.getSync<any[]>("errors") ?? []).slice(-10));
}

/** Run once by the student (approves the script's permissions), then by itself never again. A first
 *  config can come with the project (global DUELY_CONFIG, written by the installer). */
export function duelySetup(): string {
  const props = PropertiesService.getScriptProperties();
  const first = (globalThis as any).DUELY_CONFIG;
  if (first && props.getProperty("v:config") === null) props.setProperty("v:config", JSON.stringify(first));
  const key = (globalThis as any).DUELY_CHANNEL_KEY;
  if (typeof key === "string" && key.length >= 32) props.setProperty("secret:channel_key", key);
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "duelyTick") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("duelyTick").timeBased().everyMinutes(10).create();
  return "Duely is set up: it checks Brightspace every 10 minutes.";
}

/** Disconnect: stop the timer (the data stays until the project is deleted). */
export function duelyStop(): string {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "duelyTick") ScriptApp.deleteTrigger(t);
  return "Duely's timer is off.";
}

// ---------------------------------------------------------------- the desktop app's channel
// A web app reachable by its link, guarded by a long random key only the student's Duely app and this
// script know (script property "secret:channel_key", set at setup). Google's own "only myself" access
// would need every student to grant Duely a Drive permission just to call it.

/** Constant-time comparison of the channel key. */
export function keyOk(given: unknown): boolean {
  const want = PropertiesService.getScriptProperties().getProperty("secret:channel_key") ?? "";
  const got = typeof given === "string" ? given : "";
  if (want.length < 32 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

const json = (data: unknown) => ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);

/** GET: what the desktop shows (last sync, health, open alerts, storage use). Synchronous on purpose:
 *  a web app's answer is read as soon as doGet returns. */
export function readState(): any {
  const store = propsStore();
  const actions = Object.values(store.getSync<Record<string, any>>("actions") ?? {});
  const cfg = store.getSync<any>("config") ?? {};
  return { ok: true, version: (globalThis as any).DUELY_ENGINE_VERSION ?? "", state: store.getSync("state"), health: store.getSync("health"),
    sched: store.getSync("sched"), outbox: store.getSync("outbox") ?? [], bytes: store.bytes(), syncQueued: !!store.getSync("sync-queued"),
    done: store.getSync("done") ?? {}, actions, study: store.getSync("study") ?? { approved: {} },
    inbox: (store.getSync<any[]>("inbox") ?? []).map((x) => x.id), inboxDone: store.getSync("inbox-done") ?? [],
    emailAlerts: !!cfg.email_alerts, aiKeySet: !!PropertiesService.getScriptProperties().getProperty("secret:llm_key"),
    discordSet: !!PropertiesService.getScriptProperties().getProperty("secret:discord_link"), discordError: store.getSync("discord-error"),
    triggers: ScriptApp.getProjectTriggers().map((t: any) => t.getHandlerFunction()) };
}

/** POST {op}: "sync" (queue a run within about a minute), "decision" (into the inbox, then a run is
 *  queued), "config" (merge settings), "secret" ({name, value}), "email" (on/off), "outbox-clear",
 *  "stop" (timer off), "forget" (timer off, keys and links removed). Synchronous, like readState. */
export function command(body: any): any {
  const store = propsStore();
  const props = PropertiesService.getScriptProperties();
  const queueRun = () => {
    if (!store.getSync("sync-queued")) {
      ScriptApp.newTrigger("duelySyncNow").timeBased().after(1000).create();
      store.putSync("sync-queued", Date.now());
    }
  };
  if (body?.op === "sync") { queueRun(); return { ok: true, queued: true }; }
  if (body?.op === "decision") {
    if (!parseDecision(body.decision)) return { ok: false, error: "That change wasn't understood." };
    const id = typeof body.id === "string" && body.id.length <= 64 ? body.id : `d${Date.now().toString(36)}`;
    const inbox: any[] = store.getSync<any[]>("inbox") ?? [];
    if (inbox.length >= 100) return { ok: false, error: "Too many changes waiting; try again in a minute." };
    store.putSync("inbox", [...inbox, { id, at: Date.now(), decision: body.decision }]);
    queueRun();
    return { ok: true, id, queued: true };
  }
  if (body?.op === "email") { store.putSync("config", { ...(store.getSync<any>("config") ?? {}), email_alerts: !!body.on }); return { ok: true }; }
  if (body?.op === "start") {
    for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "duelyTick") ScriptApp.deleteTrigger(t);
    ScriptApp.newTrigger("duelyTick").timeBased().everyMinutes(10).create();
    return { ok: true };
  }
  if (body?.op === "stop" || body?.op === "forget") {
    for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
    if (body.op === "forget") {
      props.deleteProperty("secret:llm_key");
      props.deleteProperty("secret:discord_link");
      const cfg = store.getSync<any>("config") ?? {};
      store.putSync("config", { ...cfg, feed_url: "", announcement_feeds: [], email_alerts: false });
    }
    return { ok: true };
  }
  if (body?.op === "config") { store.putSync("config", { ...(store.getSync<any>("config") ?? {}), ...(body.config ?? {}) }); return { ok: true }; }
  if (body?.op === "secret" && ["llm_key", "discord_link"].includes(body.name)) {
    if (body.value) props.setProperty(`secret:${body.name}`, String(body.value)); else props.deleteProperty(`secret:${body.name}`);
    return { ok: true };
  }
  if (body?.op === "outbox-clear") { store.putSync("outbox", []); return { ok: true }; }
  return { ok: false, error: `unknown op ${body?.op}` };
}

/** The one-off run Sync now queued: sync, then remove its trigger. */
export async function duelySyncNow(): Promise<{ synced: boolean }> {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "duelySyncNow") ScriptApp.deleteTrigger(t);
  PropertiesService.getScriptProperties().deleteProperty("v:sync-queued");
  return duelyTick(Date.now(), true);
}

export { FULL_EVERY_MS, json };
