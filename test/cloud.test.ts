// The desktop's side of the cloud engine (src/node/cloud.ts) against the real bundle in the Apps Script
// sandbox: install through a fake Apps Script API, the student's one-time approval, talking over the
// channel (key-checked), decisions, updates that keep the web-app address.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import type { ScriptApi, ScriptFile } from "../src/google/script.ts";
import { type CloudLink, channel, install, update, waitForApproval } from "../src/node/cloud.ts";
import { buildGas } from "../scripts/build-gas.ts";
import { CONFIG, sandbox } from "./gas-sandbox.ts";

const URL1 = "https://script.google.com/macros/s/AKfyc-test/exec";

function fakeApi() {
  const calls: string[] = [];
  let uploaded: ScriptFile[] = [], versions = 0;
  const api: ScriptApi = {
    async apiEnabled() { return true; },
    async create(title) { calls.push(`create ${title}`); return "script-1"; },
    async upload(_id, files) { calls.push("upload"); uploaded = files; },
    async version() { calls.push("version"); return ++versions; },
    async deploy(_id, v) { calls.push(`deploy v${v}`); return { deploymentId: "dep-1", url: URL1 }; },
    async redeploy(_id, dep, v) { calls.push(`redeploy ${dep} v${v}`); return URL1; },
  };
  return { api, calls, files: () => uploaded };
}

/** fetch() that delivers channel calls to the sandboxed script's doGet / doPost. */
function channelFetch(s: any) {
  return (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    assert.equal(`${u.origin}${u.pathname}`, URL1);
    const text = init.method === "POST"
      ? vm.runInContext(`doPost(${JSON.stringify({ postData: { contents: init.body } })})`, s.ctx).text
      : vm.runInContext(`doGet(${JSON.stringify({ parameter: Object.fromEntries(u.searchParams) })})`, s.ctx).text;
    return new Response(text);
  }) as typeof fetch;
}

test("install → the student approves once → the desktop reads and steers the script", async () => {
  const s = await sandbox();
  s.props.m.delete("v:config");                                  // a fresh project: settings come from the installer
  const { api, calls, files } = fakeApi();
  const { code, version } = await buildGas();
  const link = await install(api, { code, version }, "America/Toronto", CONFIG);
  assert.deepEqual(calls, ["create Duely", "upload", "version", "deploy v1"]);
  assert.deepEqual(files().map((f) => f.name), ["Start", "appsscript", "Code", "Config"], "Start first: the editor opens on duelySetup");
  assert.match(JSON.parse(files()[1].source).timeZone, /Toronto/);
  assert.equal(link.key.length, 43);
  const ch = channel(link, channelFetch(s));

  await assert.rejects(waitForApproval(ch, { timeoutMs: 1, everyMs: 0 }), /wasn't approved/, "not approved yet");

  // the student clicks Run on duelySetup (the uploaded Config and Start files are what the editor runs)
  vm.runInContext(files().find((f) => f.name === "Config")!.source, s.ctx);
  s.run("duelySetup");
  const st = await waitForApproval(ch, { timeoutMs: 1000, everyMs: 0 });
  assert.equal(st.ok, true);
  assert.deepEqual(st.triggers, ["duelyTick"]);
  assert.equal(st.version, version);
  assert.equal(JSON.parse(s.props.m.get("v:config")!).feed_url, CONFIG.feed_url, "first settings from the installer");

  await ch.post({ op: "sync" });
  await s.run("duelySyncNow");
  const after = await ch.read();
  assert.ok(after.state.items.length >= 4);
  const uid = after.state.items[0].uid;
  await ch.post({ op: "decision", id: "x1", decision: { kind: "done", uid, name: "it" } });
  assert.deepEqual((await ch.read()).inbox, ["x1"]);
  await s.run("duelySyncNow");
  assert.ok((await ch.read()).done[uid]);

  const wrong = channel({ ...link, key: "y".repeat(43) }, channelFetch(s));
  await assert.rejects(wrong.read(), /hasn't been approved/, "a wrong key reads nothing");
  await assert.rejects(wrong.post({ op: "forget" }), /not allowed/);
});

test("editor links open in the account the script is in", async () => {
  const { editorUrl } = await import("../src/node/cloud.ts");
  assert.equal(editorUrl({ scriptId: "abc" }), "https://script.google.com/home/projects/abc/edit");
  assert.equal(editorUrl({ scriptId: "abc", account: "me+x@gmail.com" }), "https://script.google.com/home/projects/abc/edit?authuser=me%2Bx%40gmail.com");
});

test("update: nothing when current; a newer engine is uploaded and the web-app address stays", async () => {
  const { api, calls } = fakeApi();
  const link: CloudLink = { scriptId: "script-1", deploymentId: "dep-1", url: URL1, key: "k".repeat(43), version: "old", scopes: "" };
  const same = await update(api, { ...link, version: "v2" }, { code: "x", version: "v2" }, "UTC");
  assert.deepEqual([same.changed, calls.length], [false, 0]);
  const r = await update(api, link, { code: "x", version: "v2" }, "UTC");
  assert.deepEqual(calls, ["upload", "version", "redeploy dep-1 v1"]);
  assert.equal(r.link.url, URL1);
  assert.equal(r.link.version, "v2");
  assert.equal(r.needsApproval, true, "the permissions changed since this link was made: approve again");
  const again = await update(api, { ...r.link, version: "v2" }, { code: "y", version: "v3" }, "UTC");
  assert.equal(again.needsApproval, false, "same permissions: no new approval");
});
