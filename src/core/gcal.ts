// Google OAuth (refresh token) + the few Calendar v3 calls the sync needs.
const BASE = "https://www.googleapis.com/calendar/v3";

export class NeedsAuth extends Error {}

export interface Cal {
  ensureCalendar(name: string, id: string | null, tz: string): Promise<string>;
  listEvents(calId: string): Promise<any[]>;
  insert(calId: string, body: any): Promise<void>;
  update(calId: string, eventId: string, body: any): Promise<void>;
  delete(calId: string, eventId: string): Promise<void>;
}

export async function accessToken(env: { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; GOOGLE_REFRESH_TOKEN: string }, f = fetch): Promise<string> {
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const text = await r.text();
  if (r.status !== 200) {
    if (text.includes("invalid_grant")) throw new NeedsAuth("Google sign-in expired or revoked; reconnect Google, then run `syllabus cloud-setup` again");
    throw new Error(`Google token refresh failed: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text).access_token;
}

export function googleCal(token: string, f = fetch): Cal {
  const enc = encodeURIComponent;
  async function req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await f(BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((r.status === 404 || r.status === 410) && (method === "GET" || method === "DELETE")) return null;
    const text = await r.text();
    if (r.status >= 400) {
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text).error.message; } catch { /* raw */ }
      throw new Error(`Google Calendar ${r.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  }
  return {
    async ensureCalendar(name, id, tz) {
      if (id && (await req("GET", `/calendars/${enc(id)}`))) return id;
      return (await req("POST", "/calendars", { summary: name, timeZone: tz })).id;
    },
    async listEvents(calId) {
      let out: any[] = [], token = "";
      do {
        const q = new URLSearchParams({ maxResults: "2500", showDeleted: "false", ...(token ? { pageToken: token } : {}) });
        const page = (await req("GET", `/calendars/${enc(calId)}/events?${q}`)) ?? {};
        out = out.concat(page.items ?? []);
        token = page.nextPageToken ?? "";
      } while (token);
      return out;
    },
    async insert(calId, body) { await req("POST", `/calendars/${enc(calId)}/events`, body); },
    async update(calId, eventId, body) { await req("PUT", `/calendars/${enc(calId)}/events/${eventId}`, body); },
    async delete(calId, eventId) { await req("DELETE", `/calendars/${enc(calId)}/events/${eventId}`); },
  };
}
