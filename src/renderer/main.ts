// The app shell: onboarding on first run, then a narrow sidebar (Upcoming, Chat, Settings, and a
// quiet sync area) beside the page. Talks to the main process only through window.duely.
import "@fontsource-variable/inter/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";
import type { Status } from "../shared/types.ts";
import { type BannerSpec, setBanners } from "./components/banner.ts";
import { toast } from "./components/toast.ts";
import { chatScreen } from "./screens/chat.ts";
import { onboarding } from "./screens/onboarding.ts";
import { settingsScreen } from "./screens/settings.ts";
import type { AppCtx, Route, Screen } from "./screens/types.ts";
import { upcomingScreen } from "./screens/upcoming.ts";
import { api } from "./ui/api.ts";
import { ago, setLocale } from "./ui/format.ts";
import { clear, h } from "./ui/h.ts";
import { type IconName, icon, mark } from "./ui/icons.ts";
import { enter, reduced } from "./ui/motion.ts";

const app = document.getElementById("app")!;

const ctx: AppCtx = {
  status: null,
  syncing: false,
  async sync() {
    if (ctx.syncing) return false;
    ctx.syncing = true; paintStatus();
    let ok = true;
    try { await api.syncNow(); } catch (e) { ok = false; toast((e as Error).message); }
    ctx.syncing = false;
    await ctx.refreshStatus();
    current?.refresh();
    return ok && !ctx.status?.sync.error;
  },
  async refreshStatus() {
    try { ctx.status = await api.status(); } catch { return; }
    paintStatus();
  },
  go: (r) => show(r),
};

// ---------------------------------------------------------------- shell
const NAV: { id: Route; label: string; icon: IconName }[] = [
  { id: "upcoming", label: "Upcoming", icon: "calendar" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "settings", label: "Settings", icon: "settings" },
];
const navButtons = new Map<Route, HTMLButtonElement>();
const syncDot = h("i", { class: "sync-dot" });
const syncText = h("span", { class: "sync-text" });
const syncArea = h("button", { class: "side-sync", attrs: { title: "Sync now" } }, syncDot, syncText);
syncArea.addEventListener("click", () => void ctx.sync());
const banners = h("div", { class: "banners" });
const content = h("main", { class: "content" });

function shell(): HTMLElement {
  const nav = h("nav", { class: "nav", attrs: { "aria-label": "Duely" } }, NAV.map((n) => {
    const b = h("button", { class: "nav-item", attrs: { "aria-label": n.label } }, h("span", { class: "nav-bg" }), icon(n.icon, 17, "nav-icon"), h("span", { class: "nav-label" }, n.label));
    b.addEventListener("click", () => show(n.id));
    navButtons.set(n.id, b);
    return b;
  }));
  return h("div", { class: "shell" },
    h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, mark(22), h("span", { class: "brand-name" }, "Duely")),
      nav, h("div", { class: "side-foot" }, syncArea)),
    h("div", { class: "main-col" }, banners, content));
}

// ---------------------------------------------------------------- routing
const screens = new Map<Route, Screen>();
let current: Screen | null = null;
let route: Route | null = null;

function show(r: Route) {
  if (r === route) return;
  const prev = route ? NAV.findIndex((n) => n.id === route) : -1;
  const next = NAV.findIndex((n) => n.id === r);
  route = r;
  for (const [id, b] of navButtons) {
    const on = id === r;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  // the highlight slides a few px into place from the side it came from
  const bg = navButtons.get(r)!.querySelector(".nav-bg")!;
  const dy = reduced() || prev < 0 ? 0 : prev < next ? -6 : 6;
  bg.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });

  let s = screens.get(r);
  if (!s) { s = r === "upcoming" ? upcomingScreen(ctx) : r === "chat" ? chatScreen(ctx) : settingsScreen(ctx); screens.set(r, s); }
  current = s;
  clear(content);
  content.append(s.el);
  content.scrollTop = 0;
  enter(s.el, { y: 4, dur: 160 });
  s.mount();
}

// ---------------------------------------------------------------- status + banners
function paintStatus() {
  const s = ctx.status;
  syncArea.classList.toggle("is-syncing", ctx.syncing);
  const problem = !!s?.sync.error;
  syncDot.className = ["sync-dot", ctx.syncing ? "is-busy" : problem ? "is-warn" : s?.sync.time ? "is-ok" : ""].join(" ");
  syncText.textContent = ctx.syncing ? "Syncing…" : !s?.sync.time ? "Not synced yet"
    : s.sync.needsGoogle ? "Calendar not connected" : problem ? "Sync needs attention" : `Synced ${ago(s.sync.time * 1000)}`;
  setBanners(banners, bannerSpecs(s));
  current?.status();
}

function bannerSpecs(s: Status | null): BannerSpec[] {
  if (!s) return [];
  const out: BannerSpec[] = [];
  const settings = () => show("settings");
  if (!s.google) {
    out.push({ id: "google", tone: "warn", title: "Google Calendar isn't connected", text: "Duely can't add anything to your calendar yet.", action: { label: "Connect", run: settings } });
  } else if (s.sync.needsGoogle) {
    out.push({ id: "google", tone: "warn", title: "Google needs to be reconnected", text: "Duely can't update your calendar until access is restored.", action: { label: "Reconnect", run: settings } });
  } else if (s.sync.error) {
    out.push({ id: "sync", tone: "warn", title: "Sync isn't working", text: s.sync.error, action: { label: "Try again", run: () => void ctx.sync() } });
  }
  if (s.weakKeychain) {
    out.push({ id: "keyring", tone: "info", title: "Saved keys are only lightly protected", text: "This computer has no keyring, so the system can't encrypt them." });
  }
  return out;
}

// ---------------------------------------------------------------- start
async function start() {
  await ctx.refreshStatus();
  setLocale(ctx.status?.locale);
  if (!ctx.status?.onboarded) {
    app.append(onboarding(() => { clear(app); boot(); }));
    return;
  }
  boot();
}

function boot() {
  app.append(shell());
  paintStatus();
  show("upcoming");
}

api.onChanged(() => { void ctx.refreshStatus().then(() => current?.refresh()); });
setInterval(() => void ctx.refreshStatus(), 30e3);
void start();
