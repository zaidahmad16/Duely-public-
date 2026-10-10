// The app's side of Discord alerts (src/node/discord.ts), end to end offline: Connect → the real relay code
// (relay/src/index.ts) → a fake Discord → the app's loopback page → pickup → device token; then alerts,
// the test message, check-in and disconnect, and errors in words a student can act on.
import assert from "node:assert/strict";
import { test } from "node:test";
import relay, { type Env } from "../relay/src/index.ts";
import { checkIn, connect, discordWords, parseLink, sendAlert, sendTest, unlink } from "../src/node/discord.ts";

const RELAY = "https://relay.test";
const API = "https://discord.test/api";

function setup(o: { dmClosed?: boolean } = {}) {
  const m = new Map<string, string>();
  const env: Env = {
    LINKS: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); },
      list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
    DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "s", DISCORD_BOT_TOKEN: "b", STATE_KEY: "k".repeat(32), GUILD_ID: "42", DISCORD_API: API,
  };
  const members = new Set<string>(), dms: string[] = [];
  const real = globalThis.fetch;
  // Discord's API, as the relay sees it
  const discord = async (url: string, init: any = {}) => {
    const path = url.slice(API.length), method = init.method ?? "GET";
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (path === "/oauth2/token") return ok({ access_token: "a" });
    if (path === "/users/@me") return ok({ id: "7", username: "sam" });
    if (path === "/guilds/42/members/7") { if (method === "PUT") members.add("7"); else members.delete("7"); return new Response(null, { status: 204 }); }
    if (path === "/users/@me/channels") return ok({ id: "dm7" });
    if (path === "/channels/dm7/messages") { if (o.dmClosed) return ok({ code: 50007 }, 403); dms.push(JSON.parse(init.body).content); return ok({}); }
    return ok({}, 404);
  };
  // the relay over "the network"; everything else (the loopback page) for real
  const net = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith(API)) return discord(url, init);
    if (url.startsWith(RELAY)) return relay.fetch(new Request(url, init), env);
    return real(input, init);
  }) as typeof fetch;
  globalThis.fetch = net;                                          // the relay's own calls to Discord
  /** The browser: follows the relay's redirects to Discord and back to the app's loopback page. */
  const browser = async (start: string) => {
    let r = await net(start, { redirect: "manual" });
    const auth = new URL(r.headers.get("location")!);
    r = await net(`${RELAY}/discord/callback?code=c&state=${encodeURIComponent(auth.searchParams.get("state")!)}`, { redirect: "manual" });
    const page = await real(r.headers.get("location")!);
    return page.text();
  };
  return { env, net, browser, members, dms, restore: () => { globalThis.fetch = real; } };
}

test("Connect: Discord sign-in through the relay lands on the app's page and gives the app (only) its device token", async () => {
  const s = setup();
  try {
    let shown = "";
    const link = await connect({ relay: RELAY, fetch: s.net, open: async (url) => { assert.match(url, /^https:\/\/relay\.test\/connect\?port=\d+&challenge=/); shown = await s.browser(url); } });
    assert.match(shown, /Discord is connected/);
    assert.equal(link.name, "sam");
    assert.equal(link.token.length, 43);
    assert.ok(s.members.has("7"), "joined the Duely server");
    assert.deepEqual(parseLink(JSON.stringify(link)), link);
    await sendTest(link, { relay: RELAY, fetch: s.net });
    await sendAlert(link, { title: "Midterm moved", body: "COMP 3005: Oct 22, 6 PM" }, { relay: RELAY, fetch: s.net });
    assert.deepEqual(s.dms, ["**Duely is connected ✓**\nYour alerts will arrive here.", "**Midterm moved**\nCOMP 3005: Oct 22, 6 PM"]);
    await checkIn(link, { relay: RELAY, fetch: s.net });
    await unlink(link, { relay: RELAY, fetch: s.net });
    assert.ok(!s.members.has("7"), "left the server");
    await assert.rejects(sendAlert(link, { title: "x", body: "y" }, { relay: RELAY, fetch: s.net }), (e: any) => e.code === "not_linked" && /Connect it again/.test(e.message));
  } finally { s.restore(); }
});

test("errors in plain words: DMs closed, relay unreachable, sign-in cancelled", async () => {
  const s = setup({ dmClosed: true });
  try {
    const link = await connect({ relay: RELAY, fetch: s.net, open: async (url) => { await s.browser(url); } });
    await assert.rejects(sendTest(link, { relay: RELAY, fetch: s.net }), (e: any) => e.code === "dm_closed" && /Privacy Settings/.test(e.message));
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(sendAlert(link, { title: "x", body: "y" }, { relay: RELAY, fetch: down }), /Couldn't reach Duely's Discord relay/);
    await assert.rejects(connect({ relay: RELAY, fetch: s.net, open: async (url) => {
      const port = new URL(url).searchParams.get("port");
      await fetch(`http://127.0.0.1:${port}/discord?error=denied`);
    } }), /cancelled/);
    assert.match(discordWords("rate"), /this hour/);
  } finally { s.restore(); }
});
