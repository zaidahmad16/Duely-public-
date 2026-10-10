// Settings as the UI sees them <-> config.json, with validation; and "Test connection" in plain words.
// Secrets aren't here: the AI key goes to the keychain (src/node/secrets.ts) and never comes back.
import { createHash } from "node:crypto";
import type { Capabilities } from "../llm/probe.ts";
import { DEFAULTS } from "../core/sync.ts";
import type { CapResult, Settings, SettingsPatch } from "../shared/types.ts";

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toSettings(saved: any, keySet: boolean, discord: Settings["discord"] = null): Settings {
  const c = { ...DEFAULTS, ...saved };
  return {
    feedUrl: c.feed_url ?? "",
    announcementFeeds: (c.announcement_feeds ?? []).filter((u: unknown) => typeof u === "string"),
    ai: { provider: c.ai?.provider ?? "", model: c.ai?.model ?? "", auto: autoModel(c.ai), baseUrl: c.ai?.baseUrl ?? "", keySet, dailyLimit: Number(c.ai_daily_limit ?? 200) },
    notifications: c.notifications !== false,
    importantAnnouncements: c.phone_alerts !== false,
    studyBlocks: !!c.study_blocks,
    studyDay: c.study_day,
    studyBlockHours: Number(c.study_block_hours),
    digestDaily: !!c.digest_daily,
    digestTime: c.digest_time,
    digestWeekly: !!c.digest_weekly,
    briefings: c.briefings !== false,
    calendarName: c.calendar_name,
    terms: [...(c.term && c.classes?.length ? [{ ...c.term, classes: c.classes, key: "legacy" }] : []), ...(c.terms ?? []).map((t: any) => ({ ...t, key: t.start }))]
      .map((t: any) => ({ key: t.key, name: String(t.name || "Term"), start: t.start, end: t.end, classes: (t.classes ?? []).length,
        courses: [...new Set<string>((t.classes ?? []).map((x: any) => x.course))].sort() }))
      .sort((a, b) => a.start.localeCompare(b.start)),
    exams: (c.exams ?? []).map((e: any) => ({ key: `${e.course}|${e.date}|${e.start}`, course: e.course, title: e.title, date: e.date, start: e.start, end: e.end, room: e.room ?? "" })),
    academicDatesUrl: c.academic_dates_url ?? "",
    discord,
  };
}

/** A feed or RSS link: https (webcal is the same thing). */
export function httpsLink(raw: string, what: string): string {
  let u: URL;
  try { u = new URL(String(raw).trim().replace(/^webcal:\/\//i, "https://")); } catch { throw new Error(`That ${what} isn't a link.`); }
  if (u.protocol !== "https:") throw new Error(`The ${what} should start with https:// or webcal://`);
  return u.toString();
}

/** Applies a patch to the saved config. Throws a message for the UI on bad input; saves nothing then. */
export function applyPatch(saved: any, p: SettingsPatch): any {
  const c = { ...saved };
  if (p.feedUrl !== undefined) c.feed_url = httpsLink(p.feedUrl, "calendar link");
  if (p.announcementFeeds !== undefined) {
    const seen = new Set<string>();
    c.announcement_feeds = p.announcementFeeds.map((u) => httpsLink(u, "announcements link")).filter((u) => !seen.has(u) && !!seen.add(u));
  }
  if (p.academicDatesUrl !== undefined) c.academic_dates_url = String(p.academicDatesUrl).trim() ? httpsLink(p.academicDatesUrl, "academic dates link") : "";
  if (p.ai) {
    const ai = { ...(c.ai ?? {}) };
    if (p.ai.provider !== undefined) {
      if (!["openai", "anthropic", "gemini"].includes(p.ai.provider)) throw new Error("Pick a provider.");
      ai.provider = p.ai.provider;
    }
    // a model name is the student's own choice; empty means "Duely picks"
    if (p.ai.model !== undefined) { ai.model = String(p.ai.model).trim(); ai.auto = !ai.model; }
    if (p.ai.baseUrl !== undefined) {
      const b = String(p.ai.baseUrl).trim();
      if (b) {
        let u: URL;
        try { u = new URL(b); } catch { throw new Error("The base URL isn't a link."); }
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("The base URL should start with https:// (http:// only for this computer).");
      }
      ai.baseUrl = b.replace(/\/+$/, "");
    }
    // model names don't carry over to another provider: Duely picks again. On another server, a model
    // Duely picked is picked again too (one the student typed is kept).
    if (p.ai.model === undefined) {
      if (p.ai.provider !== undefined && p.ai.provider !== c.ai?.provider) { ai.model = ""; ai.auto = true; }
      else if (p.ai.baseUrl !== undefined && ai.baseUrl !== (c.ai?.baseUrl ?? "") && autoModel(ai)) ai.model = "";
    }
    if (p.ai.dailyLimit !== undefined) {
      const n = Math.round(Number(p.ai.dailyLimit));
      if (!(n >= 0 && n <= 10000)) throw new Error("The daily cap should be between 0 and 10,000 requests.");
      c.ai_daily_limit = n; c.chat_daily_limit = n;
    }
    c.ai = ai;
  }
  const flag = (k: keyof SettingsPatch, key: string) => { if (p[k] !== undefined) c[key] = !!p[k]; };
  flag("notifications", "notifications");
  flag("importantAnnouncements", "phone_alerts");
  flag("studyBlocks", "study_blocks");
  flag("digestDaily", "digest_daily");
  flag("digestWeekly", "digest_weekly");
  flag("briefings", "briefings");
  if (p.digestTime !== undefined) {
    if (!HM.test(p.digestTime)) throw new Error("Pick a time for the morning digest.");
    c.digest_time = p.digestTime;
  }
  if (p.studyDay !== undefined) {
    const [a, b] = p.studyDay;
    if (!HM.test(a) || !HM.test(b) || a >= b) throw new Error("Study hours should start before they end.");
    c.study_day = [a, b];
  }
  if (p.studyBlockHours !== undefined) {
    const n = Number(p.studyBlockHours);
    if (!(n >= 0.5 && n <= 4)) throw new Error("A study block should be between 30 minutes and 4 hours.");
    c.study_block_hours = n;
  }
  return c;
}

/** Duely chooses the model unless the student typed one (settings from before this have a model and no
 *  flag: that was typed or accepted by them, so it's kept). */
export function autoModel(ai: any): boolean {
  return ai?.auto ?? !ai?.model;
}

/** An AI error in words a student can act on. */
export function friendlyAIError(raw: string | undefined): string {
  const m = String(raw ?? "");
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.*key|api key/i.test(m)) return "The API key wasn't accepted. Check that it's copied in full.";
  if (/no models available/i.test(m)) return "Duely couldn't find a model to use with this key. Choose one under Advanced.";
  if (/\b404\b|not found|does not exist|unknown model/i.test(m)) return "That model wasn't found. Check the model name (and the base URL).";
  if (/\b(503|500|502)\b|overloaded|high demand|unavailable/i.test(m)) return "The provider is busy right now. Try again in a minute, or choose another model under Advanced.";
  if (/\b429\b|rate|quota|insufficient/i.test(m)) return "The provider is limiting requests or the account has no credit. Try again in a minute.";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|network/i.test(m)) return "Couldn't reach the provider. Check your internet connection or the base URL.";
  if (/timed? ?out/i.test(m)) return "The provider took too long to answer. Try again.";
  return "The AI didn't answer as expected. Check the provider, model and key.";
}

export function capResult(c: Capabilities): CapResult {
  if (!c.chat) return { ok: false, message: friendlyAIError(c.error) };
  return {
    ok: true, message: "Connected",
    caps: [
      { label: "Chat", ok: c.tools, note: c.tools ? "" : "Simple lists only (this model can't use tools)" },
      { label: "Reading", ok: c.json, note: c.json ? "" : "Announcements won't be read for dates" },
      { label: "Screenshots", ok: c.vision, note: c.vision ? "" : "Type your timetable in instead" },
    ],
  };
}

/** Duely needs its AI: it counts as set up once "Test connection" worked for exactly this provider,
 *  model, URL and key. The fingerprint of that test is kept (config "ai_verified"); any change to
 *  them no longer matches, so the student tests again. (A hash: the key itself isn't stored here.) */
export function aiFingerprint(ai: any, key: string): string {
  return createHash("sha256").update([ai?.provider ?? "", ai?.model ?? "", ai?.baseUrl ?? "", key].join("\u0000")).digest("hex").slice(0, 24);
}

export function aiReady(cfg: any, key: string): boolean {
  return !!(cfg?.ai?.provider && cfg?.ai?.model && cfg?.ai_verified && cfg.ai_verified === aiFingerprint(cfg.ai, key));
}
