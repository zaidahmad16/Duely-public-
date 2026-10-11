// Google sign-in for a desktop app: the student's own OAuth client (the JSON file Google Cloud gives
// for a "Desktop app" client), the loopback redirect (a one-shot server on 127.0.0.1) and PKCE.
// Scope: only calendars Duely creates itself, so it can never read or change the student's other
// calendars. Plain Node (no Electron) so it can be tested; the app passes `open` = shell.openExternal.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NeedsAuth } from "../core/gcal.ts";

export const SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type Client = { client_id: string; client_secret: string };

/** The client JSON downloaded from Google Cloud. A "Web application" client is refused with the fix. */
export function parseClient(text: string): Client {
  let d: any;
  try { d = JSON.parse(text); } catch { throw new Error("That file isn't a Google client JSON file (it isn't JSON)."); }
  if (d?.web) throw new Error("That's a \"Web application\" client. Duely needs a \"Desktop app\" client: create one in Google Cloud → Credentials and download its JSON.");
  const c = d?.installed ?? d;
  if (typeof c?.client_id !== "string" || !c.client_id.endsWith(".apps.googleusercontent.com") || typeof c?.client_secret !== "string" || !c.client_secret) {
    throw new Error("That file doesn't look like a Google OAuth client (no client_id / client_secret).");
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

const b64url = (b: Buffer) => b.toString("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authUrl(client: Client, redirect: string, challenge: string, state: string, scopes: string[] = [SCOPE]): string {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: scopes.join(" "),
    code_challenge: challenge, code_challenge_method: "S256", state,
    access_type: "offline", prompt: "consent",                 // always hand back a refresh token
  })}`;
}

const PAGE = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Duely</title>`
  + `<body style="font:16px system-ui;max-width:32em;margin:15vh auto;text-align:center">${msg}</body>`;

/** Opens Google's consent page and waits for the redirect. Resolves with the refresh token. */
export async function connect(client: Client, opts: { open: (url: string) => Promise<void> | void; fetch?: typeof fetch; timeoutMs?: number;
  /** permissions to ask for (default: Duely's own calendar only) */ scopes?: string[] }): Promise<string> {
  const scopes = opts.scopes ?? [SCOPE];
  const f = opts.fetch ?? fetch;
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  let done: (v: { code?: string; error?: string }) => void = () => {};
  const got = new Promise<{ code?: string; error?: string }>((r) => { done = r; });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/" || u.searchParams.get("state") !== state) { res.writeHead(404).end(); return; }
    const error = u.searchParams.get("error") ?? undefined, code = u.searchParams.get("code") ?? undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(code
      ? "<h2>Google is connected ✓</h2><p>You can close this tab and go back to Duely.</p>"
      : "<h2>Google wasn't connected</h2><p>Go back to Duely and try again.</p>"));
    done({ code, error });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setTimeout(() => done({ error: "timeout" }), opts.timeoutMs ?? 5 * 60e3);
  try {
    await opts.open(authUrl(client, redirect, challenge, state, scopes));
    const r = await got;
    if (r.error === "timeout") throw new Error("Google sign-in timed out. Try connecting again.");
    if (r.error === "access_denied") throw new Error("Google sign-in was cancelled.");
    if (!r.code) throw new Error(`Google sign-in failed (${r.error ?? "no code"}).`);
    const res = await f(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...client, code: r.code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" }),
    });
    const text = await res.text();
    let tok: any = {};
    try { tok = JSON.parse(text); } catch { /* reported below */ }
    if (res.status !== 200 || !tok.refresh_token) throw new Error(`Google didn't finish the sign-in: ${tok.error_description ?? tok.error ?? text.slice(0, 200)}`);
    if (typeof tok.scope === "string" && !scopes.every((s) => tok.scope.split(" ").includes(s))) {
      throw new Error("Google sign-in finished without calendar access. Connect again and tick the calendar permission.");
    }
    return tok.refresh_token;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

/** Remembers whether Google's sign-in has expired: `mark(true)` when a token call needs a new sign-in,
 *  `mark(false)` when one works again. A client in Google's "Testing" status expires every 7 days. */
export function trackExpiry(get: () => Promise<string>, mark: (expired: boolean) => Promise<void>): () => Promise<string> {
  return async () => {
    try {
      const t = await get();
      await mark(false);
      return t;
    } catch (e) {
      if (e instanceof NeedsAuth) await mark(true);
      throw e;
    }
  };
}

/** Access tokens from the refresh token, reused until a minute before they expire. */
export function tokenSource(client: Client, refreshToken: string, f: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const r = await f(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...client, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const text = await r.text();
    if (r.status !== 200) {
      if (text.includes("invalid_grant") || text.includes("invalid_client") || text.includes("unauthorized_client")) {
        throw new NeedsAuth("Google sign-in expired or was removed. Reconnect Google in Duely's settings.");
      }
      throw new Error(`Google sign-in refresh failed: ${text.slice(0, 200)}`);
    }
    const d = JSON.parse(text);
    cached = { token: d.access_token, until: Date.now() + (Number(d.expires_in) || 3600) * 1000 - 60e3 };
    return cached.token;
  };
}
