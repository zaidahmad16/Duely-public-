// Google sign-in (loopback + PKCE, driven in-process: the "browser" is a fetch to the redirect) and
// the encrypted secrets store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { NeedsAuth } from "../src/core/gcal.ts";
import { memStore } from "../src/core/util.ts";
import { SCOPE, connect, parseClient, pkce, tokenSource } from "../src/google/oauth.ts";
import { type Cipher, secretStore } from "../src/node/secrets.ts";

const CLIENT = { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test" };

test("client JSON: desktop accepted, web client refused with the fix, junk refused", () => {
  assert.deepEqual(parseClient(JSON.stringify({ installed: { ...CLIENT, redirect_uris: ["http://localhost"] } })), CLIENT);
  assert.throws(() => parseClient(JSON.stringify({ web: CLIENT })), /Desktop app/);
  assert.throws(() => parseClient("nope"), /isn't JSON/);
  assert.throws(() => parseClient(JSON.stringify({ installed: { client_id: "x" } })), /doesn't look like/);
});

test("PKCE challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = pkce();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

/** A fake Google: the token endpoint checks the PKCE verifier against the challenge it was shown. */
function fakeGoogle(opts: { deny?: boolean; scope?: string } = {}) {
  let challenge = "", redirect = "";
  const open = async (url: string) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get("scope"), SCOPE);
    assert.equal(u.searchParams.get("access_type"), "offline");
    challenge = u.searchParams.get("code_challenge")!;
    redirect = u.searchParams.get("redirect_uri")!;
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+$/);
    const state = u.searchParams.get("state")!;
    // a stray request with the wrong state is ignored
    assert.equal((await fetch(`${redirect}/?code=evil&state=wrong`)).status, 404);
    const r = await fetch(`${redirect}/?${opts.deny ? "error=access_denied" : "code=the-code"}&state=${state}`);
    assert.match(await r.text(), opts.deny ? /wasn't connected/ : /connected ✓/);
  };
  const f = (async (_u: any, init: any) => {
    const p = new URLSearchParams(init.body);
    if (p.get("grant_type") === "authorization_code") {
      const ok = p.get("code") === "the-code" && p.get("redirect_uri") === redirect
        && createHash("sha256").update(p.get("code_verifier")!).digest("base64url") === challenge;
      return ok ? Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: opts.scope ?? SCOPE })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({ error: "unsupported" }, { status: 400 });
  }) as typeof fetch;
  return { open, f };
}

test("connect: consent -> redirect -> code exchanged with the PKCE verifier -> refresh token", async () => {
  const g = fakeGoogle();
  assert.equal(await connect(CLIENT, { open: g.open, fetch: g.f }), "rt");
});

test("connect: cancelled, missing calendar permission, timeout", async () => {
  const d = fakeGoogle({ deny: true });
  await assert.rejects(connect(CLIENT, { open: d.open, fetch: d.f }), /cancelled/);
  const s = fakeGoogle({ scope: "openid" });
  await assert.rejects(connect(CLIENT, { open: s.open, fetch: s.f }), /without calendar access/);
  await assert.rejects(connect(CLIENT, { open: () => {}, timeoutMs: 50 }), /timed out/);
});

test("tokenSource caches the access token; a revoked sign-in is NeedsAuth", async () => {
  let calls = 0;
  const ok = (async () => { calls++; return Response.json({ access_token: `at${calls}`, expires_in: 3600 }); }) as unknown as typeof fetch;
  const get = tokenSource(CLIENT, "rt", ok);
  assert.equal(await get(), "at1");
  assert.equal(await get(), "at1");
  assert.equal(calls, 1);
  const revoked = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(tokenSource(CLIENT, "rt", revoked)(), (e) => e instanceof NeedsAuth && /Reconnect Google/.test((e as Error).message));
});

const xor: Cipher = {
  available: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
};

test("secrets: stored encrypted (never the plain value), read back, deleted", async () => {
  const store = memStore();
  const s = secretStore(store, xor);
  await s.set("llm_key", "sk-very-secret");
  assert.ok(!JSON.stringify(store.data.get("secrets")).includes("sk-very-secret"));
  assert.equal(await s.get("llm_key"), "sk-very-secret");
  assert.ok(await s.has("llm_key"));
  await s.delete("llm_key");
  assert.equal(await s.get("llm_key"), null);
});

test("secrets: no keychain -> refuses to save; a key that won't decrypt says to enter it again", async () => {
  const store = memStore();
  await assert.rejects(secretStore(store, { ...xor, available: () => false }).set("llm_key", "x"), /keychain isn't available/);
  await secretStore(store, xor).set("llm_key", "x");
  const broken = secretStore(store, { ...xor, decrypt: () => { throw new Error("bad"); } });
  await assert.rejects(broken.get("llm_key"), /Enter it again/);
});
