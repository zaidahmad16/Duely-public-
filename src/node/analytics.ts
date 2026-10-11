// Anonymous usage counts (PostHog): at most one "active" event a day per install, so the developer can
// see how many people use Duely and on which versions. It sends a random install id that's linked to
// nothing, the app version, the OS and the engine mode. Never names, emails, courses, calendar items,
// keys or questions. No person profiles, and PostHog's IP-to-location lookup is switched off.
// Students turn it off in Settings → About ("usage_counts": false). No key built in = nothing is sent.
import { randomUUID } from "node:crypto";
import type { Store } from "../core/util.ts";

/** PostHog project API key (a write-only "phc_…" key, meant to ship in apps) and its host. */
export const POSTHOG_KEY = "phc_wWygnod7i4JmXGsGtXkHwXAzKf7nfcdZ7ybpiXBifrMK";
export const POSTHOG_HOST = "https://us.i.posthog.com";

export type Usage = { version: string; os: string; arch: string; mode: "cloud" | "local"; packaged: boolean };
type Saved = { id: string; last: string };

/** The day in the computer's own time zone, so "once a day" means the student's day. */
export const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The one event, exactly as sent: nothing else leaves the computer. */
export function event(key: string, id: string, u: Usage, now: number) {
  return {
    api_key: key,
    event: "app_active",
    distinct_id: id,
    timestamp: new Date(now).toISOString(),
    properties: {
      app_version: u.version, os: u.os, arch: u.arch, mode: u.mode, packaged: u.packaged,
      $process_person_profile: false,   // count events, don't build a profile of anyone
      $geoip_disable: true,             // no location from the IP address
      $lib: "duely",
    },
  };
}

/** Sends today's event if the student allows it and it hasn't gone yet today. Returns whether one was sent. */
export async function pingDaily(o: {
  store: Store; enabled: () => Promise<boolean>; usage: () => Promise<Usage>;
  fetch?: typeof fetch; now?: number; key?: string; host?: string;
}): Promise<boolean> {
  const key = o.key ?? POSTHOG_KEY;
  if (!key || !(await o.enabled())) return false;
  const now = o.now ?? Date.now();
  const saved = ((await o.store.get<Saved>("usage-counts")) ?? null) as Saved | null;
  const id = saved?.id || randomUUID();
  if (saved?.last === dayOf(now)) return false;
  const f = o.fetch ?? fetch;
  try {
    const r = await f(`${o.host ?? POSTHOG_HOST}/i/v0/e/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(event(key, id, await o.usage(), now)), signal: AbortSignal.timeout(10e3),
    });
    if (!r.ok) return false;                                      // tried again later today
  } catch { return false; }
  await o.store.put("usage-counts", { id, last: dayOf(now) });
  return true;
}

/** Turning it off also forgets the install id, so turning it back on starts a new, unlinked one. */
export async function forget(store: Store): Promise<void> { await store.put("usage-counts", null); }
