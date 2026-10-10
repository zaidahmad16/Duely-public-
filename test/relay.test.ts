// The Discord relay (relay/src/index.ts) against a fake Discord API and an in-memory KV: sign-in state,
// joining the server, the one-time pickup, alerts (split, capped, rate-limited, DMs closed), unlinking and
// the hourly sweep. Only hashes of device tokens may be stored, and alert text never.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import relay, { type Env, type KV, chunks, sweep } from "../relay/src/index.ts";

const ORIGIN = "https://duely-relay.example.workers.dev";
const API = "https://discord.test/api";

function memKV(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

/** A fake Discord: OAuth, /users/@me, guild members, DMs. `dmClosed` users answer 50007. */
function fakeDiscord(o: { members?: { id: string; bot?: boolean }[]; dmClosed?: string[] } = {}) {
  const members = new Map((o.members ?? []).map((m) => [m.id, m]));
  const sent: { channel: string; content: string }[] = [];
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (!url.startsWith(API)) return real(input, init);
    const path = url.slice(API.length), method = init.method ?? "GET";
    calls.push(`${method} ${path.split("?")[0]}`);
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (path === "/oauth2/token") return String(init.body).includes("code=good") ? ok({ access_token: "user-access" }) : ok({ error: "invalid_grant" }, 400);
    if (path === "/users/@me") return ok({ id: "111", username: "student", global_name: "Sam" });
    if (/^\/guilds\/\d+\/members\/\d+$/.test(path)) {
      const id = path.split("/").pop()!;
      if (method === "PUT") { assert.equal(JSON.parse(init.body).access_token, "user-access"); assert.match(init.headers.authorization, /^Bot /); members.set(id, { id }); return new Response(null, { status: 201 }); }
      if (method === "DELETE") { members.delete(id); return new Response(null, { status: 204 }); }
    }
    if (/^\/guilds\/\d+$/.test(path)) return ok({ id: "g", owner_id: "8" });
    if (path.startsWith("/guilds/") && path.includes("/members?")) return ok([...members.values()].map((m) => ({ user: { id: m.id, bot: !!m.bot } })));
    if (path === "/users/@me/channels") { const id = JSON.parse(init.body).recipient_id; return ok({ id: `dm-${id}` }); }
    if (/^\/channels\/dm-\d+\/messages$/.test(path)) {
      const uid = path.split("/")[2].slice(3);
      if (o.dmClosed?.includes(uid)) return ok({ code: 50007, message: "Cannot send messages to this user" }, 403);
      sent.push({ channel: path.split("/")[2], content: JSON.parse(init.body).content });
      return ok({ id: "m" });
    }
    return ok({ message: "unknown" }, 404);
  }) as typeof fetch;
  return { members, sent, calls, restore: () => { globalThis.fetch = real; } };
}

function env(kv = memKV(), extra: Partial<Env> = {}): Env & { LINKS: ReturnType<typeof memKV> } {
  return { LINKS: kv, DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "secret", DISCORD_BOT_TOKEN: "bot-token", STATE_KEY: "k".repeat(32),
    GUILD_ID: "1558321208481685534", DISCORD_API: API, ...extra } as any;
}
const call = (e: Env, method: string, path: string, body?: unknown) =>
  relay.fetch(new Request(`${ORIGIN}${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), e);
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pkce = () => { const verifier = b64url(Buffer.from("v".repeat(40))); return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }; };

/** The whole sign-in, as the app and the browser do it. */
async function signIn(e: Env, code = "good") {
  const { verifier, challenge } = pkce();
  const go = await call(e, "GET", `/connect?port=53682&challenge=${challenge}`);
  assert.equal(go.status, 302);
  const auth = new URL(go.headers.get("location")!);
  assert.equal(auth.origin + auth.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(auth.searchParams.get("scope"), "identify guilds.join");
  assert.equal(auth.searchParams.get("redirect_uri"), `${ORIGIN}/discord/callback`);
  const cb = await call(e, "GET", `/discord/callback?code=${code}&state=${encodeURIComponent(auth.searchParams.get("state")!)}`);
  const back = new URL(cb.headers.get("location")!);
  assert.equal(back.origin, "http://127.0.0.1:53682");
  return { back, verifier };
}

test("sign-in: Discord OAuth → joined the Duely server → one-time pickup with the verifier → device token", async () => {
  const d = fakeDiscord();
  try {
    const e = env();
    const { back, verifier } = await signIn(e);
    assert.ok(d.members.has("111"), "joined the server (so the bot may DM)");
    const pickup = back.searchParams.get("pickup")!;
    assert.equal((await (await call(e, "POST", "/pickup", { pickup, verifier: "wrong" })).json() as any).code, "bad_verifier");
    const r = await (await call(e, "POST", "/pickup", { pickup, verifier })).json() as any;
    assert.deepEqual([r.ok, r.name], [true, "Sam"]);
    assert.equal(r.token.length, 43);
    assert.equal((await (await call(e, "POST", "/pickup", { pickup, verifier })).json() as any).code, "expired", "once only");
    // stored: only the token's hash, the Discord id and name; never the OAuth token
    const links = [...e.LINKS.m.entries()].filter(([k]) => k.startsWith("link:"));
    assert.equal(links.length, 1);
    assert.equal(links[0][0], `link:${createHash("sha256").update(r.token).digest("hex")}`);
    assert.deepEqual(Object.keys(JSON.parse(links[0][1])).sort(), ["created", "name", "seen", "uid"]);
    assert.ok(![...e.LINKS.m.values()].some((v) => v.includes("user-access") || v.includes(r.token)), "no OAuth token, no plain device token");
  } finally { d.restore(); }
});

test("sign-in refuses a tampered or expired state, and reports a refused sign-in to the app", async () => {
  const d = fakeDiscord();
  try {
    const e = env();
    const { challenge } = pkce();
    const state = new URL((await call(e, "GET", `/connect?port=53682&challenge=${challenge}`)).headers.get("location")!).searchParams.get("state")!;
    const [p, c, exp, sig] = state.split(".");
    assert.equal((await call(e, "GET", `/discord/callback?code=good&state=${p.replace("53682", "53683")}.${c}.${exp}.${sig}`)).status, 400, "another port");
    const old = `${p}.${c}.${Date.now() - 1}`;                         // correctly signed, but expired
    const oldSig = b64url(createHmac("sha256", "k".repeat(32)).update(old).digest());
    const expired = await call(e, "GET", `/discord/callback?code=good&state=${old}.${oldSig}`);
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /took too long/);
    assert.equal((await call(e, "GET", "/connect?port=80&challenge=x")).status, 400);
    const denied = await call(e, "GET", `/discord/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "denied");
    assert.ok(!d.members.size, "nobody joined");
  } finally { d.restore(); }
});

test("alerts: a DM with the title in bold, long text split under 2000 and capped; nothing about it stored", async () => {
  const d = fakeDiscord();
  try {
    const e = env();
    const { back, verifier } = await signIn(e);
    const { token } = await (await call(e, "POST", "/pickup", { pickup: back.searchParams.get("pickup"), verifier })).json() as any;
    const keys = e.LINKS.m.size;
    assert.equal((await (await call(e, "POST", "/alert", { token, title: "Midterm moved", body: "COMP 3005: now Oct 22, 6 PM", click: "https://brightspace.example.ca/x" })).json() as any).ok, true);
    assert.equal(d.sent[0].content, "**Midterm moved**\nCOMP 3005: now Oct 22, 6 PM\nhttps://brightspace.example.ca/x");
    await call(e, "POST", "/alert", { token, title: "Digest", body: "line\n".repeat(1500) });
    assert.ok(d.sent.slice(1).every((m) => m.content.length <= 2000));
    assert.ok(d.sent.slice(1).map((m) => m.content).join("").length <= 4000);
    assert.ok(![...e.LINKS.m.values()].some((v) => v.includes("Midterm")), "alert text isn't stored");
    assert.equal(e.LINKS.m.size, keys + 1, "only the hourly counter was added");
    assert.equal((await (await call(e, "POST", "/test", { token })).json() as any).ok, true);
    assert.match(d.sent.at(-1)!.content, /Duely is connected/);
  } finally { d.restore(); }
});

test("alerts: unknown token, closed DMs and the hourly limit come back as codes the app can word", async () => {
  const d = fakeDiscord({ dmClosed: ["111"] });
  try {
    const e = env();
    assert.equal((await (await call(e, "POST", "/alert", { token: "x".repeat(43), body: "hi" })).json() as any).code, "not_linked");
    const { back, verifier } = await signIn(e);
    const { token } = await (await call(e, "POST", "/pickup", { pickup: back.searchParams.get("pickup"), verifier })).json() as any;
    const r = await (await call(e, "POST", "/alert", { token, body: "hi" })).json() as any;
    assert.equal(r.code, "dm_closed");
    assert.match(r.message, /Direct Messages from server members/);
    const hash = createHash("sha256").update(token).digest("hex");
    e.LINKS.m.set(`rate:${hash}:${Math.floor(Date.now() / 3600e3)}`, "60");
    assert.equal((await (await call(e, "POST", "/alert", { token, body: "hi" })).json() as any).code, "rate");
  } finally { d.restore(); }
});

test("disconnect deletes the link and removes the member; the token stops working", async () => {
  const d = fakeDiscord();
  try {
    const e = env();
    const { back, verifier } = await signIn(e);
    const { token } = await (await call(e, "POST", "/pickup", { pickup: back.searchParams.get("pickup"), verifier })).json() as any;
    assert.equal((await (await call(e, "DELETE", "/link", { token })).json() as any).ok, true);
    assert.ok(!d.members.has("111"));
    assert.equal((await (await call(e, "POST", "/seen", { token })).json() as any).code, "not_linked");
  } finally { d.restore(); }
});

test("hourly sweep: links unseen for 30 days go (with their member); members without a link go; the owner, admins and bots stay", async () => {
  const d = fakeDiscord({ members: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "8" }, { id: "9" }, { id: "99", bot: true }] });
  try {
    const e = env(memKV(), { ADMIN_IDS: "9" });
    const now = Date.now();
    e.LINKS.m.set("link:a", JSON.stringify({ uid: "1", name: "a", created: now, seen: now - 2 * 86400e3 }));
    e.LINKS.m.set("link:b", JSON.stringify({ uid: "2", name: "b", created: now, seen: now - 31 * 86400e3 }));
    const r = await sweep(e, now);
    assert.deepEqual(r, { stale: 1, removed: 1 });
    assert.deepEqual([...d.members.keys()].sort(), ["1", "8", "9", "99"], "the server owner (8) stays too");
    assert.ok(!e.LINKS.m.has("link:b"));
  } finally { d.restore(); }
});

test("message splitting prefers line breaks and never cuts past the size", () => {
  const parts = chunks(`${"a".repeat(1500)}\n${"b".repeat(1500)}`);
  assert.deepEqual(parts.map((p) => p.length), [1500, 1500]);
  assert.ok(chunks("x".repeat(5000)).every((p) => p.length <= 2000));
});
