// The desktop engine run: what the personal Worker did on its cron, for one student's computer.
// tick() is called every minute by the app (src/main/jobs.ts) and straight away after the computer
// wakes up: it syncs Brightspace -> Google Calendar every 10 minutes (sooner when an announcement
// changed), then sends the morning digest / Sunday preview / test-eve briefing when they're due,
// including ones the computer slept through (wider windows than the Worker's).
// Plain Node: Electron things (notifications, keychain, Google sign-in) come in through Deps.
import type { LLM } from "../llm/types.ts";
import { type Action, loadActions, propose } from "../core/actions.ts";
import { fetchRss, rssCourse } from "../core/announcements.ts";
import { maybeBriefing } from "../core/briefing.ts";
import { changeMessages, changedItems, markSent } from "../core/changes.ts";
import { type DigestState, dailyDigest, due, weeklyDigest } from "../core/digest.ts";
import { applyDone, loadDone } from "../core/done.ts";
import { type Cal, NeedsAuth } from "../core/gcal.ts";
import type { Ctx } from "../core/aifilter.ts";
import { decisionsKey, studyForSync } from "../core/proposals.ts";
import { renderPlans } from "../core/study.ts";
import { DEFAULTS, build, push, serial } from "../core/sync.ts";
import { localDate, today, weekday } from "../core/time.ts";
import { type Store, sha1hex } from "../core/util.ts";
import { keptItems, vanishedDrafts, vanishedItems } from "../core/vanished.ts";

export type Deps = {
  store: Store;
  /** the student's AI, or undefined (rules only) */
  llm: () => Promise<LLM | undefined>;
  /** Google Calendar; throws NeedsAuth when Google isn't connected */
  calendar: () => Promise<Cal>;
  /** a desktop notification; `click` = a link to open when it's clicked */
  notify: (title: string, body: string, click?: string) => Promise<void>;
  fetch: typeof fetch;
  /** the computer's (or script's) time zone, used when the settings don't name one */
  defaultTz?: () => string;
};

const hostTz = (deps: Deps) => deps.defaultTz?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

export const FULL_EVERY_MS = 10 * 60e3;
export const QUICK_EVERY_MS = 3 * 60e3;          // announcement feeds between full syncs (polite to the school)
const FULL_REFRESH_MS = 24 * 3600e3;               // a full push at least daily even when nothing changed
const DIGEST_WINDOW_MIN = 4 * 60;                  // 07:30 digest still goes out at 11:00 after a sleep
const BRIEFING_UNTIL = "22:00";
const WRITE_CAP = 300;                             // calendar writes per run: a runaway bug can't flood the calendar

export async function loadCtx(deps: Deps): Promise<Ctx> {
  const saved = (await deps.store.get<any>("config")) ?? {};
  const cfg = { ...DEFAULTS, ...saved };
  cfg.sync_types = { ...DEFAULTS.sync_types, ...(saved.sync_types ?? {}) };
  const tz = cfg.tz || hostTz(deps);
  return { store: deps.store, cfg, tz, fetch: deps.fetch, llm: await deps.llm() };
}

const notifying = (cfg: any) => cfg.notifications !== false;

/** Slack-style text (the engine's digests) as plain notification text. */
export function plainText(s: string): string {
  return s.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, "$1").replace(/\*([^*\n]+)\*/g, "$1").replace(/_([^_\n]+)_/g, "$1");
}

async function rssSig(texts: (string | null)[], cfg: any, tz: string): Promise<string> {
  return sha1hex([
    ...texts.map((t) => (t === null ? "<failed>" : t.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/g, ""))),
    JSON.stringify({ ...cfg, calendar_id: null }), today(tz),
  ].join("\u0000"));
}

const feedsOf = (cfg: any): string[] => (cfg.announcement_feeds ?? []).filter((f: string) => typeof f === "string" && f.trim());

/** One sync: feed + announcements -> items -> Google Calendar. Never throws; the error is in the result. */
export async function syncOnce(deps: Deps, force = false): Promise<any> {
  const { store } = deps;
  const result: any = { time: Date.now() / 1000, items: [], ai: "", error: "", pushed: false, added: 0, updated: 0, removed: 0, pending: 0 };
  const prev = (await store.get<any>("state")) ?? {};
  try {
    const ctx = await loadCtx(deps);
    const { cfg, tz } = ctx;
    if (!cfg.feed_url) throw new Error("No Brightspace calendar link yet. Add it in Duely's settings.");
    const feeds = feedsOf(cfg);
    const [feedRes, ...rss] = await Promise.allSettled([
      deps.fetch(String(cfg.feed_url).replace(/^webcal:\/\//, "https://"), { headers: { "User-Agent": "Duely/1.0" } })
        .then(async (r) => { if (!r.ok) throw new Error(`Brightspace calendar link returned ${r.status}`); return r.text(); }),
      ...feeds.map((u) => fetchRss(u, deps.fetch)),
    ]);
    if (feedRes.status === "rejected") {
      const e = feedRes.reason as Error;
      throw /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(e?.message ?? e) + String((e as any)?.cause ?? ""))
        ? new Error("Couldn't reach Brightspace (offline?)") : e;
    }
    const text = feedRes.value;
    if (!text.slice(0, 2000).includes("BEGIN:VCALENDAR")) throw new Error("The Brightspace calendar link didn't return a calendar (expired or wrong link?)");
    const got = rss.map((r) => (r.status === "fulfilled" ? r.value : null));
    result.feed_status = feeds.map((u, i) => (got[i] !== null
      ? { url: u, ok: true, course: rssCourse(got[i]!) }
      : { url: u, ok: false, error: String(((rss[i] as PromiseRejectedResult).reason as Error)?.message ?? (rss[i] as PromiseRejectedResult).reason) }));
    const rssText = new Map<string, string>();
    feeds.forEach((u, i) => { if (got[i] !== null) rssText.set(u, got[i]!); });
    const fetchFeed = async (u: string) => { const t = rssText.get(u); if (t === undefined) throw new Error("unreachable"); return t; };

    // nothing changed since the last full run -> nothing to push (most runs)
    const done = await loadDone(store);
    const doneKey = Object.keys(done).sort().join(",");
    const study = await decisionsKey(store);
    const annSig = await rssSig(got, { ...cfg, _done: doneKey, _study: study }, tz);
    const sig = await sha1hex([
      text.replace(/^DTSTAMP:.*$/gm, ""), ...[...rssText.values()].map((r) => r.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/g, "")),
      JSON.stringify({ ...cfg, calendar_id: null }), today(tz), doneKey, study, ctx.llm?.label ?? "",
    ].join("\u0000"));
    const lastFull = (await store.get<any>("last-full")) ?? {};
    if (!force && lastFull.sig === sig && !prev.error && !prev.pending && Date.now() - (lastFull.at ?? 0) < FULL_REFRESH_MS) {
      if (lastFull.rss_sig !== annSig) await store.put("last-full", { ...lastFull, rss_sig: annSig });
      const out = { ...prev, time: result.time, checked_only: true, feed_status: result.feed_status };
      await store.put("state", out);
      return out;
    }

    const send = notifying(cfg) ? (title: string, message: string, click: string) => deps.notify(title, message, click) : undefined;
    const [items, status] = await build(ctx, text, { annFetch: fetchFeed, send });
    applyDone(items, done);
    // tests/deadlines that vanished from Brightspace: asked about (in the app), kept meanwhile
    const gone = vanishedItems(prev.items ?? [], items.map((it) => serial(it, tz)), cfg);
    const asked = gone.length ? await propose(store, vanishedDrafts(gone, tz)) : [];
    // tests/deadlines that moved or got a room: told once each
    const changes = changedItems(prev.items ?? [], items.map((it) => serial(it, tz)), tz);
    if (changes.length && send) {
      const sent = (await store.get<Record<string, number>>("changes-sent")) ?? {};
      const msgs = changeMessages(changes, sent);
      for (const m of msgs) await deps.notify(plainText(m.title), plainText(m.text)).catch(() => {});
      if (msgs.length) await store.put("changes-sent", markSent(changes, sent));
    }
    const acts: Action[] = Object.values(await loadActions(store));
    for (const a of asked) if (!acts.some((x) => x.id === a.id)) acts.push(a);
    items.push(...keptItems(acts, new Set(items.map((i) => i.uid)), tz));
    // study blocks: only plans the student said yes to; new ones are proposals
    const serialised = items.map((it) => serial(it, tz));
    const sp = await studyForSync(store, serialised, cfg, tz, (prev.items ?? []).some((i: any) => i.source === "study"));
    items.push(...renderPlans(sp.render, serialised, tz));
    await propose(store, sp.fresh);
    result.ai = status;
    result.items = items.map((it) => serial(it, tz));
    const cal = await deps.calendar();
    Object.assign(result, await push(items, ctx, cal, WRITE_CAP), { pushed: true });
    await store.put("last-full", { sig, rss_sig: annSig, at: Date.now() });
  } catch (e) {
    result.error = e instanceof NeedsAuth ? e.message : (e as Error)?.message || String(e);
    result.needs_google = e instanceof NeedsAuth;
    if (!result.items.length) result.items = prev.items ?? [];
  }
  await store.put("state", result);
  return result;
}

/** syncOnce plus health: the first failure notifies (again if the reason changes), and recovery
 *  says so; a broken announcements feed and failing AI reading are told once. */
export async function runSync(deps: Deps, force = false): Promise<any> {
  const { store } = deps;
  const health = (await store.get<any>("health")) ?? { fails: 0, alerted: false };
  const result = await syncOnce(deps, force);
  const cfg = (await loadCtx({ ...deps, llm: async () => undefined })).cfg;
  const say = async (title: string, body: string) => {
    if (!notifying(cfg)) return false;
    try { await deps.notify(title, body); return true; } catch { return false; }
  };
  const fails = result.error ? (health.fails ?? 0) + 1 : 0;
  let alerted = !!health.alerted, alerted_msg: string = health.alerted_msg ?? "";
  if (result.error && (!alerted || alerted_msg !== result.error)) {
    if (await say("Duely sync isn't working", `${result.error} Open Duely to fix it.`)) { alerted = true; alerted_msg = result.error; }
  } else if (!result.error && alerted) {
    if (await say("Duely is syncing again", "Your calendar is up to date.")) { alerted = false; alerted_msg = ""; }
  }
  // announcements feeds
  const prevFeeds: Record<string, any> = health.feeds ?? {};
  let feeds = prevFeeds;
  if (Array.isArray(result.feed_status)) {
    feeds = {};
    for (const f of result.feed_status) {
      const p = prevFeeds[f.url] ?? { alerted: false, course: "" };
      const course = f.course || p.course || "";
      if (f.ok) {
        const back = p.alerted && await say(`${course || "A course"}: announcements working again`, "Its announcements are being read again.");
        feeds[f.url] = { alerted: p.alerted && !back, course };
      } else {
        const told = p.alerted || await say(`${course || "A course"}: announcements link isn't working`,
          `${f.error}, so its announcements aren't being read. If the course is over, remove its link in Duely's settings; otherwise copy its RSS link from Brightspace again.`);
        feeds[f.url] = { alerted: told, course };
      }
    }
  }
  // AI reading failing: once a day per reason
  let ai_day = health.ai_day ?? "", ai_reason = health.ai_reason ?? "";
  const day = today(cfg.tz || hostTz(deps));
  const failed = !result.checked_only && /AI failed \(([^)]*)\)/.exec(result.ai ?? "");
  if (failed && (ai_day !== day || ai_reason !== failed[1])) {
    if (await say("Duely's AI reading isn't working right now",
      `Duely is using its simple built-in rules until it's back, so new announcements may not be checked for dates. Reason: ${failed[1]}.`)) {
      ai_day = day; ai_reason = failed[1];
    }
  }
  const next = { fails, alerted, alerted_msg, feeds, ai_day, ai_reason, finished: Date.now() };
  if (JSON.stringify({ ...next, finished: 0 }) !== JSON.stringify({ ...health, finished: 0 })) await store.put("health", next);
  return { ...result, failing_runs: fails };
}

/** Re-read only the announcement feeds: "changed" means sync now. */
export async function quickCheck(deps: Deps): Promise<"changed" | "unchanged" | "skip"> {
  const { store } = deps;
  const [prev, lastFull] = await Promise.all([store.get<any>("state"), store.get<any>("last-full")]);
  if (!prev || prev.error || prev.pending || !lastFull?.rss_sig) return "skip";
  const ctx = await loadCtx({ ...deps, llm: async () => undefined });
  const feeds = feedsOf(ctx.cfg);
  if (!feeds.length) return "unchanged";
  const [got, done, study] = await Promise.all([Promise.allSettled(feeds.map((u) => fetchRss(u, deps.fetch))), loadDone(store), decisionsKey(store)]);
  const sig = await rssSig(got.map((g) => (g.status === "fulfilled" ? g.value : null)),
    { ...ctx.cfg, _done: Object.keys(done).sort().join(","), _study: study }, ctx.tz);
  return sig === lastFull.rss_sig ? "unchanged" : "changed";
}

/** Morning digest / Sunday preview when due (or missed while asleep, within a few hours). */
export async function maybeDigest(deps: Deps, now = Date.now()): Promise<"daily" | "weekly" | null> {
  const { store } = deps;
  const { cfg, tz } = await loadCtx({ ...deps, llm: async () => undefined });
  if (!notifying(cfg) || !(cfg.digest_daily || cfg.digest_weekly)) return null;
  const st = (await store.get<DigestState>("digest")) ?? {};
  const day = localDate({ t: now, tz }, tz);
  const wantWeekly = cfg.digest_weekly && weekday(day) === Number(cfg.weekly_day ?? 6) && due(now, tz, cfg.weekly_time ?? "19:00", st.weekly, DIGEST_WINDOW_MIN);
  const wantDaily = cfg.digest_daily && due(now, tz, cfg.digest_time ?? "07:30", st.daily, DIGEST_WINDOW_MIN);
  if (!wantWeekly && !wantDaily) return null;
  const items: any[] = ((await store.get<any>("state")) ?? {}).items ?? [];
  const done = await loadDone(store);
  const marked = items.map((it) => (done[it.uid] ? { ...it, done: true } : it));
  const send = (text: string) => {
    const [head, ...rest] = text.split("\n\n");
    return deps.notify(plainText(head), plainText(rest.join("\n\n")));
  };
  if (wantWeekly) {
    await store.put("digest", { ...st, weekly: day });               // claim first: never twice
    await send(weeklyDigest(marked, tz, now));
    return "weekly";
  }
  const d = dailyDigest(marked, tz, now, cfg, st.heavy ?? []);
  await store.put("digest", { ...st, daily: day, heavy: [...(st.heavy ?? []), ...d.heavy].slice(-20) });
  await send(d.text);
  return "daily";
}

export type Sched = { lastFull: number; lastQuick: number; running: Promise<void> | null };
export const newSched = (): Sched => ({ lastFull: 0, lastQuick: 0, running: null });

async function logError(store: Store, where: string, e: unknown): Promise<void> {
  try {
    const log = ((await store.get<any[]>("errors")) ?? []).slice(-29);
    log.push({ at: Date.now(), where, message: (e as Error)?.message ?? String(e) });
    await store.put("errors", log);
  } catch { /* the store itself failed: nothing more to do */ }
}

/** One scheduler step. Overlapping calls wait for the running one instead of starting another. */
export async function tick(deps: Deps, sched: Sched, opts: { now?: number; forceSync?: boolean } = {}): Promise<{ synced: boolean }> {
  while (sched.running) await sched.running;
  let synced = false;
  const work = (async () => {
    const now = opts.now ?? Date.now();
    const cfg = (await loadCtx({ ...deps, llm: async () => undefined })).cfg;
    if (!cfg.feed_url) return;                                      // not set up yet
    let full = opts.forceSync || now - sched.lastFull >= FULL_EVERY_MS;
    if (!full && now - sched.lastQuick >= QUICK_EVERY_MS) {
      sched.lastQuick = now;
      full = (await quickCheck(deps).catch(async (e) => { await logError(deps.store, "quick-check", e); return "skip" as const; })) === "changed";
    }
    if (full) {
      sched.lastFull = sched.lastQuick = now;
      await runSync(deps, !!opts.forceSync).catch((e) => logError(deps.store, "sync", e));
      synced = true;
    }
    // after the sync, so a morning digest after a sleep uses fresh data
    await maybeDigest(deps, now).catch((e) => logError(deps.store, "digest", e));
    await (async () => {
      const c = await loadCtx(deps);
      if (!notifying(c.cfg) || c.cfg.briefings === false) return;
      const post = (t: string) => deps.notify(plainText(t.split("\n")[0]), plainText(t.split("\n").slice(1).join("\n").trim()));
      await maybeBriefing(deps.store, c.cfg, c.tz, now, { llm: c.llm }, post, deps.fetch, BRIEFING_UNTIL);
    })().catch((e) => logError(deps.store, "briefing", e));
  })();
  sched.running = work;
  try { await work; } finally { sched.running = null; }
  return { synced };
}
