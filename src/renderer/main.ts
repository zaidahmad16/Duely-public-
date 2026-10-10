// The UI. Talks to the main process only through window.duely (src/preload/index.ts).
// P2: a temporary setup panel; P3 replaces it with the wizard, Upcoming and Settings.
type Status = {
  feedSet: boolean; google: boolean; weakKeychain: boolean;
  sync: { time: number; error: string; needsGoogle: boolean; items: number; added: number; updated: number; removed: number; ai: string };
};
type Result = { ok: boolean; error?: string; status?: Status };
declare global {
  interface Window {
    duely: {
      status(): Promise<Status>; setFeed(url: string): Promise<Result>; connectGoogle(json: string): Promise<Result>;
      disconnectGoogle(): Promise<Result>; syncNow(): Promise<Result>; onChanged(fn: () => void): void;
    };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (id: string, text: string, error = false) => { const el = $(id); el.textContent = text; el.className = error ? "err" : "muted"; };

async function render() {
  const s = await window.duely.status();
  const when = s.sync.time ? new Date(s.sync.time * 1000).toLocaleString() : "never";
  say("summary", `Last sync: ${when}${s.sync.items ? ` · ${s.sync.items} items` : ""}`);
  $("warn").hidden = !s.weakKeychain;
  $("warn").textContent = "This computer has no keyring, so saved keys are only lightly protected.";
  say("feed-state", s.feedSet ? "Saved ✓" : "Not set yet.");
  say("google-state", s.google ? "Connected ✓" : "Not connected.");
  $("disconnect").hidden = !s.google;
  if (s.sync.error) say("sync-state", s.sync.error, true);
  else if (s.sync.time) say("sync-state", `Up to date. Last run: ${s.sync.added} added, ${s.sync.updated} updated, ${s.sync.removed} removed.${s.sync.ai ? ` ${s.sync.ai}` : ""}`);
  else say("sync-state", "");
}

$("feed").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await window.duely.setFeed($<HTMLInputElement>("feed-url").value);
  if (!r.ok) say("feed-state", r.error ?? "Couldn't save it.", true);
  else { $<HTMLInputElement>("feed-url").value = ""; await render(); }
});

$("google").addEventListener("click", async () => {
  const file = $<HTMLInputElement>("client").files?.[0];
  say("google-state", "Finish signing in in your browser…");
  const r = await window.duely.connectGoogle(file ? await file.text() : "");
  if (!r.ok) say("google-state", r.error ?? "Couldn't connect.", true);
  else await render();
});

$("disconnect").addEventListener("click", async () => { await window.duely.disconnectGoogle(); await render(); });

$("sync").addEventListener("click", async () => {
  say("sync-state", "Syncing…");
  const r = await window.duely.syncNow();
  if (!r.ok) say("sync-state", r.error ?? "Sync failed.", true);
  else await render();
});

window.duely.onChanged(() => void render());
void render();

export {};
