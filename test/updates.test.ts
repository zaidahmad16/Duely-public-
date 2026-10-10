// Updates (src/main/updates.ts) with a fake electron-updater: Windows/AppImage download and install on
// restart (never during a sync); unsigned macOS and .deb get a download link; betas follow pre-releases;
// failures stay quiet and the next check retries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASES, type UpdaterLike, updates } from "../src/main/updates.ts";

function fake(o: { next?: string | null; fail?: boolean } = {}) {
  const handlers = new Map<string, (x: any) => void>();
  const log: string[] = [];
  const u: UpdaterLike & { log: string[]; emit(e: string, x?: any): void } = {
    autoDownload: true, autoInstallOnAppQuit: false, allowPrerelease: false, log,
    on(e, fn) { handlers.set(e, fn); return u; },
    emit(e, x) { handlers.get(e)?.(x); },
    async checkForUpdates() {
      log.push("check");
      if (o.fail) { u.emit("error", new Error("offline")); throw new Error("offline"); }
      if (o.next) u.emit("update-available", { version: o.next }); else u.emit("update-not-available", {});
    },
    async downloadUpdate() { log.push("download"); u.emit("download-progress", { percent: 50 }); u.emit("update-downloaded", { version: o.next }); },
    quitAndInstall() { log.push("install"); },
  };
  return u;
}
const make = (u: UpdaterLike, platform: NodeJS.Platform, extra: Partial<Parameters<typeof updates>[0]> = {}) =>
  updates({ updater: u, version: "0.2.0-beta.1", platform, isAppImage: false, busy: () => false, auto: async () => true, saveAuto: async () => {}, onChange: () => {}, wait: async () => {}, ...extra });

test("Windows: a new version downloads in the background and installs on restart; betas follow pre-releases", async () => {
  const u = fake({ next: "0.2.0-beta.2" });
  const up = make(u, "win32");
  assert.deepEqual([u.autoDownload, u.autoInstallOnAppQuit, u.allowPrerelease], [false, true, true]);
  await up.check();
  assert.deepEqual([up.state().state, up.state().version, up.state().percent], ["ready", "0.2.0-beta.2", 100]);
  assert.equal(up.state().url, `${RELEASES}/tag/v0.2.0-beta.2`);
  await up.restart();
  assert.deepEqual(u.log, ["check", "download", "install"]);
  up.stop();
  const stable = updates({ updater: fake(), version: "1.0.0", platform: "win32", isAppImage: false, busy: () => false, auto: async () => true, saveAuto: async () => {}, onChange: () => {} });
  stable.stop();
});

test("unsigned macOS and the .deb: no download, a link to the release; the AppImage installs itself", async () => {
  for (const [platform, appImage, can] of [["darwin", false, false], ["linux", false, false], ["linux", true, true]] as const) {
    const u = fake({ next: "0.2.0-beta.2" });
    const up = make(u, platform, { isAppImage: appImage });
    await up.check();
    assert.equal(up.state().canInstall, can, platform);
    assert.equal(up.state().state, can ? "ready" : "available", platform);
    assert.equal(u.log.includes("download"), can, platform);
    up.stop();
  }
});

test("restart waits for a running sync; automatic download off: only a manual check downloads", async () => {
  let syncing = 3, waited = 0;
  const u = fake({ next: "0.2.0-beta.2" });
  const up = make(u, "win32", { busy: () => syncing-- > 0, wait: async () => { waited++; } });
  await up.check();
  await up.restart();
  assert.equal(waited, 3, "waited out the sync");
  assert.equal(u.log.at(-1), "install");
  up.stop();
  const u2 = fake({ next: "0.2.0-beta.2" });
  const up2 = make(u2, "win32", { auto: async () => false });
  await up2.check();
  assert.deepEqual([up2.state().state, u2.log.includes("download")], ["available", false]);
  await up2.check(true);
  assert.equal(up2.state().state, "ready", "Check for updates downloads it");
  up2.stop();
});

test("offline: the state says so quietly, and the next check tries again", async () => {
  const u = fake({ fail: true });
  const up = make(u, "linux", { isAppImage: true });
  await up.check();
  assert.equal(up.state().state, "error");
  assert.ok(up.state().lastChecked > 0);
  await up.check();
  assert.equal(u.log.filter((x) => x === "check").length, 2);
  up.stop();
});
