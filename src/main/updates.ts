// Updates (P7) from GitHub Releases, through electron-updater. Windows (NSIS) and Linux AppImage install
// themselves: downloaded in the background, applied on "Restart now" or the next quit, never during a
// sync. Unsigned macOS builds and the .deb can't replace themselves, so they get "v… is available ·
// Download" (the release page). A beta follows pre-releases; a stable build only stable ones.
// The updater is passed in, so this is tested with a fake (test/updates.test.ts).

export const RELEASES = "https://github.com/zaidahmad16/Duely-public-/releases";

/** What electron-updater's autoUpdater gives us (only the parts used). */
export type UpdaterLike = {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowPrerelease: boolean;
  on(event: "update-available" | "update-not-available" | "download-progress" | "update-downloaded" | "error", fn: (info: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
};

export type UpdateState = {
  state: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";
  /** the new version, when there is one */
  version: string;
  percent: number;
  lastChecked: number;
  /** this build replaces itself (Windows, AppImage); otherwise the student downloads it */
  canInstall: boolean;
  /** the release page of the new version (or all releases) */
  url: string;
  auto: boolean;
};

export type Updates = {
  state(): UpdateState;
  check(manual?: boolean): Promise<void>;
  /** install now (waits for a running sync to finish) */
  restart(): Promise<void>;
  setAuto(on: boolean): Promise<void>;
  stop(): void;
};

export const CHECK_EVERY_MS = 6 * 3600e3;

export function updates(o: {
  updater: UpdaterLike; version: string; platform: NodeJS.Platform; isAppImage: boolean;
  /** a sync (or Sync now) is running: don't restart under it */ busy: () => boolean;
  auto: () => Promise<boolean>; saveAuto: (on: boolean) => Promise<void>;
  onChange: (s: UpdateState) => void;
  wait?: (ms: number) => Promise<void>;
}): Updates {
  const canInstall = o.platform === "win32" || (o.platform === "linux" && o.isAppImage);
  const s: UpdateState = { state: "idle", version: "", percent: 0, lastChecked: 0, canInstall, url: RELEASES, auto: true };
  const set = (p: Partial<UpdateState>) => { Object.assign(s, p); o.onChange({ ...s }); };
  const u = o.updater;
  u.autoDownload = false;                                          // we decide (auto setting, platform)
  u.autoInstallOnAppQuit = canInstall;
  u.allowPrerelease = /-/.test(o.version);                         // 0.2.0-beta.1 follows betas
  let manualCheck = false;

  u.on("update-available", (info) => {
    const version = String(info?.version ?? "");
    set({ state: "available", version, url: `${RELEASES}/tag/v${version}`, lastChecked: Date.now() });
    if (canInstall && (s.auto || manualCheck)) { set({ state: "downloading", percent: 0 }); void u.downloadUpdate().catch(() => set({ state: "error" })); }
  });
  u.on("update-not-available", () => set({ state: "none", lastChecked: Date.now() }));
  u.on("download-progress", (p) => set({ state: "downloading", percent: Math.round(Number(p?.percent) || 0) }));
  u.on("update-downloaded", (info) => set({ state: "ready", version: String(info?.version ?? s.version), percent: 100 }));
  u.on("error", () => set({ state: s.state === "downloading" ? "error" : s.version ? "available" : "error", lastChecked: Date.now() }));   // quiet; next check retries

  async function check(manual = false) {
    if (s.state === "checking" || s.state === "downloading" || s.state === "ready") return;
    manualCheck = manual;
    s.auto = await o.auto().catch(() => true);
    set({ state: "checking" });
    try { await u.checkForUpdates(); } catch { set({ state: "error", lastChecked: Date.now() }); }
  }
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  return {
    state: () => ({ ...s }),
    check,
    async restart() {
      if (s.state !== "ready") return;
      const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let i = 0; i < 120 && o.busy(); i++) await wait(1000);   // let a running sync finish (2 min at most)
      u.quitAndInstall();
    },
    async setAuto(on) { await o.saveAuto(on); set({ auto: on }); },
    stop() { clearInterval(timer); },
  };
}
