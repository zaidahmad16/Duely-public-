// Duely's Discord relay (P6): one Cloudflare Worker that holds the Duely bot's token, so students can get
// their alerts as Discord DMs without making anything themselves. Apps (and each student's Apps Script)
// hold only a random device token; this keeps sha256(token) → {Discord user id, name, last seen}, nothing
// else. Alert text passes through and is never stored.
//
// Flow: the app opens GET /connect (Discord sign-in) → /discord/callback adds the student to the Duely
// server (so the bot may DM them) and hands a one-time pickup to the app's loopback page → POST /pickup
// (with the PKCE-style verifier) returns the device token. Then POST /alert, /test, /seen; DELETE /link.
// Hourly: links unseen for 30 days are removed, and so is any server member without a link.

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, o?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(o: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export interface Env {
  LINKS: KV;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  /** signs the OAuth state */
  STATE_KEY: string;
  GUILD_ID: string;
  /** Discord user ids the hourly sweep never removes (the owner), comma separated */
  ADMIN_IDS?: string;
  /** tests replace Discord's API */
  DISCORD_API?: string;
}

type Link = { uid: string; name: string; created: number; seen: number };

const API = (env: Env) => env.DISCORD_API ?? "https://discord.com/api/v10";
const STALE_MS = 30 * 86400e3;
const RATE_PER_HOUR = 60;
const MAX_TEXT = 4000;
const enc = new TextEncoder();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (code: string, status: number, message: string) => json({ ok: false, code, message }, status);

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STATE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
/** Constant-time string compare (signatures, challenges). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function bot(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API(env)}${path}`, {
    method, headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** A small page for the browser after sign-in (the app's own loopback page says the rest). */
const page = (title: string, text: string, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>`
  + `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p></body>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

// ---------------------------------------------------------------- sign-in

async function connect(url: URL, env: Env): Promise<Response> {
  const port = Number(url.searchParams.get("port"));
  const challenge = url.searchParams.get("challenge") ?? "";
  if (!(port >= 1024 && port <= 65535) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return page("Something went wrong", "Start again from Duely.", 400);
  const body = `${port}.${challenge}.${Date.now() + 10 * 60e3}`;
  const state = `${body}.${await hmac(env, body)}`;
  const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", scope: "identify guilds.join",
    redirect_uri: `${url.origin}/discord/callback`, state, prompt: "consent" });
  return Response.redirect(`https://discord.com/oauth2/authorize?${q}`, 302);
}

async function callback(url: URL, env: Env): Promise<Response> {
  const [port, challenge, exp, sig] = (url.searchParams.get("state") ?? "").split(".");
  if (!sig || !same(sig, await hmac(env, `${port}.${challenge}.${exp}`))) return page("Something went wrong", "That sign-in link isn't valid. Start again from Duely.", 400);
  if (Date.now() > Number(exp)) return page("That took too long", "Start again from Duely: click Connect Discord.", 400);
  const back = (q: Record<string, string>) => Response.redirect(`http://127.0.0.1:${port}/discord?${new URLSearchParams(q)}`, 302);
  const code = url.searchParams.get("code");
  if (!code) return back({ error: url.searchParams.get("error") === "access_denied" ? "denied" : "failed" });

  const tok = await fetch(`${API(env)}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: `${url.origin}/discord/callback` }),
  });
  if (!tok.ok) return back({ error: "failed" });
  const access = (await tok.json() as any).access_token as string;
  const me = await fetch(`${API(env)}/users/@me`, { headers: { authorization: `Bearer ${access}` } });
  if (!me.ok) return back({ error: "failed" });
  const user = await me.json() as any;
  // into the Duely server, so the bot is allowed to DM them (201 joined, 204 already a member)
  const join = await bot(env, "PUT", `/guilds/${env.GUILD_ID}/members/${user.id}`, { access_token: access });
  if (!join.ok) return back({ error: "join" });

  const token = random(32);
  const name = String(user.global_name || user.username || "you").slice(0, 64);
  const now = Date.now();
  await env.LINKS.put(`link:${await sha256(token)}`, JSON.stringify({ uid: String(user.id), name, created: now, seen: now } satisfies Link));
  const pickup = random(24);
  await env.LINKS.put(`pickup:${pickup}`, JSON.stringify({ token, name, challenge }), { expirationTtl: 60 });
  return back({ pickup });
}

async function pickup(req: Request, env: Env): Promise<Response> {
  const b = await body(req);
  const key = `pickup:${String(b.pickup ?? "")}`;
  const raw = await env.LINKS.get(key);
  if (!raw) return fail("expired", 400, "That sign-in expired. Connect Discord again.");
  const p = JSON.parse(raw);
  const want = b64url(await crypto.subtle.digest("SHA-256", enc.encode(String(b.verifier ?? ""))));
  if (!same(want, p.challenge)) return fail("bad_verifier", 403, "That sign-in belongs to another app.");
  await env.LINKS.delete(key);                                          // once only
  return json({ ok: true, token: p.token, name: p.name });
}

// ---------------------------------------------------------------- alerts

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

async function linkOf(env: Env, token: unknown): Promise<{ key: string; link: Link } | null> {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
  const key = `link:${await sha256(token)}`;
  const raw = await env.LINKS.get(key);
  return raw ? { key, link: JSON.parse(raw) } : null;
}

/** Splits text into Discord-sized messages (2000 chars), on line breaks where it can. */
export function chunks(text: string, size = 2000): string[] {
  const out: string[] = [];
  let rest = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = rest.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function dm(env: Env, uid: string, text: string): Promise<Response | null> {
  const ch = await bot(env, "POST", "/users/@me/channels", { recipient_id: uid });
  if (!ch.ok) return ch;
  const id = (await ch.json() as any).id;
  for (const part of chunks(text)) {
    const r = await bot(env, "POST", `/channels/${id}/messages`, { content: part, allowed_mentions: { parse: [] } });
    if (!r.ok) return r;
  }
  return null;
}

async function discordError(r: Response): Promise<Response> {
  let code = 0;
  try { code = Number((await r.json() as any).code); } catch { /* not JSON */ }
  if (code === 50007) return fail("dm_closed", 409, "Discord won't let Duely message you. Turn on Direct Messages from server members for the Duely server.");
  if (r.status === 429) return fail("rate", 429, "Discord is busy. Try again in a minute.");
  return fail("discord", 502, `Discord didn't accept the message (${r.status}).`);
}

async function alert(req: Request, env: Env, test = false): Promise<Response> {
  const b = await body(req);
  const found = await linkOf(env, b.token);
  if (!found) return fail("not_linked", 401, "Discord isn't connected anymore. Connect it again in Duely.");
  // a per-link hourly limit (KV is eventually consistent: this is a guard, not an exact count)
  const hour = Math.floor(Date.now() / 3600e3);
  const rk = `rate:${found.key.slice(5)}:${hour}`;
  const n = Number(await env.LINKS.get(rk)) || 0;
  if (n >= RATE_PER_HOUR) return fail("rate", 429, "Too many alerts this hour.");
  await env.LINKS.put(rk, String(n + 1), { expirationTtl: 7200 });
  const title = String(b.title ?? "").trim().slice(0, 200), text = String(b.body ?? "").trim(), click = String(b.click ?? "").trim();
  const msg = test ? "**Duely is connected ✓**\nYour alerts will arrive here." : [title && `**${title}**`, text, /^https:\/\//.test(click) ? click : ""].filter(Boolean).join("\n");
  if (!msg) return fail("empty", 400, "Nothing to send.");
  const err = await dm(env, found.link.uid, msg);
  if (err) return discordError(err);
  await env.LINKS.put(found.key, JSON.stringify({ ...found.link, seen: Date.now() }));
  return json({ ok: true });
}

async function seen(req: Request, env: Env): Promise<Response> {
  const found = await linkOf(env, (await body(req)).token);
  if (!found) return fail("not_linked", 401, "Discord isn't connected anymore. Connect it again in Duely.");
  await env.LINKS.put(found.key, JSON.stringify({ ...found.link, seen: Date.now() }));
  return json({ ok: true, name: found.link.name });
}

async function unlink(req: Request, env: Env): Promise<Response> {
  const found = await linkOf(env, (await body(req)).token);
  if (!found) return json({ ok: true });                                // already gone
  await env.LINKS.delete(found.key);
  await removeMember(env, found.link.uid);
  return json({ ok: true });
}

async function removeMember(env: Env, uid: string): Promise<void> {
  if (admins(env).has(uid)) return;
  await bot(env, "DELETE", `/guilds/${env.GUILD_ID}/members/${uid}`).catch(() => {});
}
const admins = (env: Env) => new Set((env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// ---------------------------------------------------------------- hourly sweep

/** Removes links unseen for 30 days (and their members), then any member without a link. */
export async function sweep(env: Env, now = Date.now()): Promise<{ stale: number; removed: number }> {
  const linked = new Set<string>();
  let stale = 0, cursor: string | undefined;
  do {
    const page = await env.LINKS.list({ prefix: "link:", cursor });
    for (const k of page.keys) {
      const raw = await env.LINKS.get(k.name);
      if (!raw) continue;
      const l: Link = JSON.parse(raw);
      if (now - l.seen > STALE_MS) { await env.LINKS.delete(k.name); await removeMember(env, l.uid); stale++; } else linked.add(l.uid);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  let removed = 0, after = "0";
  const keep = admins(env);
  const guild = await bot(env, "GET", `/guilds/${env.GUILD_ID}`);           // never the server's owner
  if (guild.ok) keep.add(String((await guild.json() as any).owner_id ?? ""));
  for (;;) {
    const r = await bot(env, "GET", `/guilds/${env.GUILD_ID}/members?limit=1000&after=${after}`);
    if (!r.ok) break;
    const members = await r.json() as any[];
    for (const m of members) {
      const id = String(m.user?.id ?? "");
      if (!id || m.user?.bot || keep.has(id) || linked.has(id)) continue;
      await bot(env, "DELETE", `/guilds/${env.GUILD_ID}/members/${id}`);
      removed++;
    }
    if (members.length < 1000) break;
    after = String(members[members.length - 1].user.id);
  }
  return { stale, removed };
}

// ---------------------------------------------------------------- routing

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /": return page("Duely", "This is Duely's Discord relay. Connect Discord from the Duely app.");
        case "GET /connect": return await connect(url, env);
        case "GET /discord/callback": return await callback(url, env);
        case "POST /pickup": return await pickup(req, env);
        case "POST /alert": return await alert(req, env);
        case "POST /test": return await alert(req, env, true);
        case "POST /seen": return await seen(req, env);
        case "DELETE /link": return await unlink(req, env);
        default: return fail("not_found", 404, "Not found.");
      }
    } catch {
      return fail("error", 500, "The relay had a problem. Try again in a minute.");
    }
  },
  async scheduled(_e: unknown, env: Env): Promise<void> {
    await sweep(env);
  },
};
