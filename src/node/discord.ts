// Discord alerts (P6): the student's link to Duely's Discord relay (relay/src/index.ts). Connect opens
// Discord's sign-in through the relay and waits on a loopback page, like Google's sign-in; the relay
// returns a device token only to the app that holds the PKCE verifier. The token is all Duely keeps
// (the `discord_link` secret, and in cloud mode the script's copy, so alerts reach Discord with the laptop off).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pkce } from "../google/oauth.ts";

import { RELAY_URL } from "../shared/discord.ts";

export { RELAY_URL };

export type DiscordLink = { token: string; name: string };

const PAGE = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Duely</title>`
  + `<body style="font:16px system-ui;max-width:32em;margin:15vh auto;text-align:center">${msg}</body>`;

/** What the relay's error codes mean for the student. */
export function discordWords(code: string | undefined, fallback = ""): string {
  switch (code) {
    case "dm_closed": return "Discord won't let Duely message you. In Discord, open the Duely server's Privacy Settings and turn on Direct Messages.";
    case "not_linked": return "Discord isn't connected anymore (you may have left the Duely server). Connect it again.";
    case "rate": return "Too many alerts went to Discord this hour. The next ones will go through later.";
    case "denied": return "Discord sign-in was cancelled.";
    case "join": return "Discord didn't let Duely add you to its server. Try again in a minute.";
    case "expired": case "bad_verifier": return "That Discord sign-in didn't finish. Try connecting again.";
    case "timeout": return "Discord sign-in timed out. Try connecting again.";
    default: return fallback || "Couldn't reach Duely's Discord relay. Check your internet connection and try again.";
  }
}

export class DiscordError extends Error {
  code: string;
  constructor(code: string, message?: string) { super(discordWords(code, message)); this.code = code; }
}

async function post(f: typeof fetch, relay: string, path: string, body: unknown, method = "POST"): Promise<any> {
  let r: Response;
  try {
    r = await f(`${relay}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch { throw new DiscordError("offline"); }
  let j: any = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || j.ok === false) throw new DiscordError(j.code ?? "error", j.message);
  return j;
}

/** Opens Discord's sign-in (through the relay) and waits for the loopback page. Resolves with the link. */
export async function connect(opts: { open: (url: string) => Promise<void> | void; relay?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<DiscordLink> {
  const relay = opts.relay ?? RELAY_URL, f = opts.fetch ?? fetch;
  const { verifier, challenge } = pkce();
  let done: (v: { pickup?: string; error?: string }) => void = () => {};
  const got = new Promise<{ pickup?: string; error?: string }>((r) => { done = r; });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/discord") { res.writeHead(404).end(); return; }
    const pickup = u.searchParams.get("pickup") ?? undefined, error = u.searchParams.get("error") ?? undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(pickup
      ? "<h2>Discord is connected ✓</h2><p>You can close this tab and go back to Duely.</p>"
      : "<h2>Discord wasn't connected</h2><p>Go back to Duely and try again.</p>"));
    done({ pickup, error });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => done({ error: "timeout" }), opts.timeoutMs ?? 5 * 60e3);
  try {
    await opts.open(`${relay}/connect?${new URLSearchParams({ port: String(port), challenge })}`);
    const r = await got;
    if (!r.pickup) throw new DiscordError(r.error ?? "error", "Discord sign-in didn't finish. Try connecting again.");
    const j = await post(f, relay, "/pickup", { pickup: r.pickup, verifier });
    return { token: String(j.token), name: String(j.name ?? "") };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

export const sendAlert = (link: DiscordLink, a: { title: string; body: string; click?: string }, o: { relay?: string; fetch?: typeof fetch } = {}) =>
  post(o.fetch ?? fetch, o.relay ?? RELAY_URL, "/alert", { token: link.token, ...a }).then(() => undefined);
export const sendTest = (link: DiscordLink, o: { relay?: string; fetch?: typeof fetch } = {}) =>
  post(o.fetch ?? fetch, o.relay ?? RELAY_URL, "/test", { token: link.token }).then(() => undefined);
/** The daily check-in: links unseen for 30 days are removed by the relay. */
export const checkIn = (link: DiscordLink, o: { relay?: string; fetch?: typeof fetch } = {}) =>
  post(o.fetch ?? fetch, o.relay ?? RELAY_URL, "/seen", { token: link.token }).then(() => undefined);
export const unlink = (link: DiscordLink, o: { relay?: string; fetch?: typeof fetch } = {}) =>
  post(o.fetch ?? fetch, o.relay ?? RELAY_URL, "/link", { token: link.token }, "DELETE").then(() => undefined);

export function parseLink(raw: string | null): DiscordLink | null {
  if (!raw) return null;
  try { const j = JSON.parse(raw); return typeof j?.token === "string" ? { token: j.token, name: String(j.name ?? "") } : null; } catch { return null; }
}
