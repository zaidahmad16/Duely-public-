// Duely's engine as an Apps Script project in the student's own Google account (P3.5). Bundled into one
// file by scripts/build-gas.ts. Apps Script has no fetch, Web Crypto, URL, timers or (reliably) Intl time
// zones, so this file supplies them from Apps Script's own services, then runs the same engine the
// desktop app runs (src/node/runner.ts) on a 10-minute timer.
import { googleCal } from "../core/gcal.ts";
import { setOffsetSource } from "../core/time.ts";
import { type Store, setSha1Source } from "../core/util.ts";
import { makeLLM } from "../llm/adapters.ts";
import type { Provider } from "../llm/types.ts";
import { type Deps, FULL_EVERY_MS, newSched, tick } from "../node/runner.ts";

declare const UrlFetchApp: any, Utilities: any, PropertiesService: any, ScriptApp: any, Session: any, MailApp: any;

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
 *  a value is written whole or not at all (chunks first, then the index that points at them). */
export function propsStore(props = PropertiesService.getScriptProperties()): Store & { bytes(): number } {
  return {
    async get<T = any>(key: string): Promise<T | null> {
      const head = props.getProperty(`v:${key}`);
      if (head === null) return null;
      const m = /^chunks:(\d+):(\w+)$/.exec(head);
      if (!m) return JSON.parse(head) as T;
      let text = "";
      for (let i = 0; i < Number(m[1]); i++) text += props.getProperty(`c:${key}:${m[2]}:${i}`) ?? "";
      return JSON.parse(text) as T;
    },
    async put(key: string, value: unknown): Promise<void> {
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
    },
    bytes() {
      const all = props.getProperties();
      return Object.entries(all).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
    },
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
}

function deps(store: Store): Deps {
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
    async calendar() { return googleCal(ScriptApp.getOAuthToken(), gasFetch as any); },
    async notify(title, body, click) {
      // kept for the desktop app to show; emailed too when the student turned that on
      const out: any[] = ((await store.get<any[]>("outbox")) ?? []).slice(-49);
      out.push({ at: Date.now(), title, body, click: click ?? "" });
      await store.put("outbox", out);
      const cfg = (await store.get<any>("config")) ?? {};
      if (cfg.email_alerts) MailApp.sendEmail(Session.getEffectiveUser().getEmail(), `Duely: ${title}`, `${body}${click ? `\n\n${click}` : ""}`);
    },
  };
}

/** The 10-minute trigger. */
export async function duelyTick(now = Date.now()): Promise<{ synced: boolean }> {
  install();
  const store = propsStore();
  const saved = (await store.get<any>("sched")) ?? {};
  const sched = newSched();
  // a trigger "every 10 minutes" can fire a little early: count a full sync as due a bit before 10 min
  sched.lastFull = (saved.lastFull ?? 0) - 90e3;
  sched.lastQuick = saved.lastQuick ?? 0;
  const r = await tick(deps(store), sched, { now });
  await store.put("sched", { lastFull: sched.lastFull + (r.synced ? 0 : 90e3), lastQuick: sched.lastQuick });
  return r;
}

/** Run once by the student (approves the script's permissions), then by itself never again. */
export function duelySetup(): string {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "duelyTick") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("duelyTick").timeBased().everyMinutes(10).create();
  return "Duely is set up: it checks Brightspace every 10 minutes.";
}

/** Disconnect: stop the timer (the data stays until the project is deleted). */
export function duelyStop(): string {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "duelyTick") ScriptApp.deleteTrigger(t);
  return "Duely's timer is off.";
}

export { FULL_EVERY_MS };
