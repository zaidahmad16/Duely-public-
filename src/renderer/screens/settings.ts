// Settings: a native-feeling page. Section headings, hairline dividers, two-column rows (what it
// is on the left, the control on the right). Toggles save at once, quietly; typed values save on
// Enter / leaving the field with a small "Saved" toast. Keys are masked and never shown again.
import type { CapResult, Provider, Settings, SettingsPatch } from "../../shared/types.ts";
import { cloudSetup } from "../components/cloudSetup.ts";
import { openDoc } from "../components/doc.ts";
import { toast } from "../components/toast.ts";
import { toggle } from "../components/toggle.ts";
import { api } from "../ui/api.ts";
import { ago } from "../ui/format.ts";
import { SLOW, slowHint } from "../ui/slow.ts";
import { clear, h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { enter, expandIn, stagger } from "../ui/motion.ts";
import type { AppCtx, Screen } from "./types.ts";

export const PROVIDERS: { id: Provider; name: string; hint: string; base: string }[] = [
  { id: "openai", name: "OpenAI-compatible", hint: "OpenAI, Mistral, Groq, Ollama…", base: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", hint: "Claude models", base: "" },
  { id: "gemini", name: "Gemini", hint: "Google AI Studio key", base: "" },
];

export function settingRow(name: string, desc: string | null, control: Node | null, o: { muted?: boolean; stack?: boolean } = {}): HTMLElement {
  return h("div", { class: ["setting", o.muted && "is-muted", o.stack && "is-stacked"] },
    h("div", { class: "setting-label" }, h("div", { class: "setting-name" }, name), desc && h("div", { class: "setting-desc" }, desc)),
    control && h("div", { class: "setting-control" }, control));
}

/** Test results, revealed one by one. */
export function capList(r: CapResult): HTMLElement {
  if (!r.ok) return h("div", { class: "caps" }, h("p", { class: "cap-fail" }, icon("alert", 14), r.message));
  const el = h("ul", { class: "caps" }, (r.caps ?? []).map((c) =>
    h("li", { class: ["cap", c.ok ? "is-ok" : "is-no"] }, h("span", { class: "cap-label" }, c.label),
      h("span", { class: "cap-state" }, c.ok ? icon("check", 14) : icon("x", 14)), c.note && h("span", { class: "cap-note" }, c.note))),
    r.model && h("li", { class: "cap-model" }, `Using ${r.model}${r.auto ? ", chosen by Duely" : ""}`));
  stagger(el.children, 90, { y: 3, dur: 180 });
  return el;
}

export function spinnerButton(btn: HTMLButtonElement, on: boolean, busyLabel?: string) {
  btn.classList.toggle("is-busy", on);
  btn.disabled = on;
  const label = btn.querySelector(".btn-label") as HTMLElement | null;
  if (label && busyLabel !== undefined) label.textContent = busyLabel;
}

export function settingsScreen(app: AppCtx): Screen {
  const body = h("div", { class: "settings" });
  const root = h("div", { class: "page page-settings" }, h("header", { class: "page-head" }, h("h1", { class: "page-title" }, "Settings")), body);
  let s: Settings | null = null;

  const save = async (p: SettingsPatch, say = false): Promise<void> => {
    try {
      s = await api.saveSettings(p);
      if (say) toast("Settings saved");
    } catch (e) {
      toast((e as Error).message);
      throw e;
    }
  };

  /** A text field that saves on Enter or blur, when changed. */
  function field(value: string, o: { placeholder?: string; type?: string; label: string; width?: string; onSave: (v: string) => SettingsPatch }) {
    const el = h("input", { class: "input", value, placeholder: o.placeholder ?? "", type: o.type ?? "text", attrs: { "aria-label": o.label }, style: o.width ? { width: o.width } : {} });
    let saved = value;
    const commit = async () => {
      if (el.value === saved) return;
      try { await save(o.onSave(el.value), true); saved = el.value; el.classList.remove("is-invalid"); } catch { el.classList.add("is-invalid"); }
    };
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } });
    el.addEventListener("blur", () => void commit());
    return el;
  }

  function section(title: string, ...rows: (Node | null | false)[]) {
    return h("section", { class: "settings-section" }, h("h2", { class: "section-title settings-head" }, title), h("div", { class: "settings-rows" }, rows));
  }

  // ---- Sources
  function sources(st: Settings) {
    const calState = h("div", { class: "inline-state" },
      st.feedUrl ? h("span", { class: "state-ok" }, icon("check", 14), "Connected") : h("span", { class: "faint" }, "Not set"),
      h("button", { class: "btn btn-ghost btn-sm" }, st.feedUrl ? "Edit" : "Add"));
    const calRow = settingRow("Brightspace calendar", "Your deadlines, tests and events.", calState);
    calState.querySelector("button")!.addEventListener("click", () => {
      if (calRow.querySelector(".edit-line")) return;
      const inp = h("input", { class: "input", value: st.feedUrl, placeholder: "webcal://…/feed.ics?token=…", attrs: { "aria-label": "Brightspace calendar link" } });
      const ok = h("button", { class: "btn btn-primary btn-sm" }, "Save");
      const cancel = h("button", { class: "btn btn-ghost btn-sm" }, "Cancel");
      const line = h("div", { class: "edit-line" }, inp, ok, cancel);
      calRow.append(line); expandIn(line); inp.focus(); inp.select();
      cancel.addEventListener("click", () => line.remove());
      const go = async () => { try { await save({ feedUrl: inp.value }, true); paint(); } catch { inp.classList.add("is-invalid"); } };
      ok.addEventListener("click", () => void go());
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") void go(); if (e.key === "Escape") line.remove(); });
    });

    const list = h("ul", { class: "link-list" });
    const paintLinks = () => {
      clear(list);
      for (const u of s!.announcementFeeds) {
        const rm = h("button", { class: "icon-btn", attrs: { "aria-label": "Remove this link", title: "Remove" } }, icon("x", 14));
        const li = h("li", null, icon("link", 13, "faint"), h("span", { class: "link-text", attrs: { title: u } }, shortUrl(u)), rm);
        rm.addEventListener("click", async () => { try { await save({ announcementFeeds: s!.announcementFeeds.filter((x) => x !== u) }); paintLinks(); } catch { /* toast shown */ } });
        list.append(li);
      }
    };
    paintLinks();
    const add = h("input", { class: "input", placeholder: "Paste a course's announcements RSS link", attrs: { "aria-label": "Add an announcements link" } });
    add.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      try { await save({ announcementFeeds: [...s!.announcementFeeds, add.value.trim()] }, true); add.value = ""; paintLinks(); enter(list.lastElementChild!, { y: 4 }); } catch { add.classList.add("is-invalid"); }
    });
    const ann = settingRow("Announcements", "Each course's RSS link from Brightspace. Duely reads new posts for dates.", null, { stack: true });
    ann.append(h("div", { class: "setting-wide" }, list, add));

    return section("Sources", calRow, ann,
      settingRow("Timetable / exam schedule", "Import from a screenshot.", h("span", { class: "soon" }, "Coming soon"), { muted: true }));
  }

  // ---- AI
  function ai(st: Settings) {
    let provider: Provider | "" = st.ai.provider;
    const seg = h("div", { class: "segmented", attrs: { role: "radiogroup", "aria-label": "AI provider" } });
    // empty = Duely picks (and the row says which); a name = the student's own choice
    const model = field(st.ai.auto ? "" : st.ai.model, { label: "Model", placeholder: "Automatic", onSave: (v) => ({ ai: { model: v } }) });
    const modelList = h("datalist", { attrs: { id: "settings-ai-models" } });
    model.setAttribute("list", modelList.id);
    model.addEventListener("focus", () => { if (!modelList.childElementCount) void api.aiModels().then((n) => modelList.append(...n.map((v) => h("option", { value: v })))).catch(() => {}); });
    const modelRow = settingRow("Model", "-", h("div", null, model, modelList));
    const modelDesc = (auto: boolean, name: string) => {
      modelRow.querySelector(".setting-desc")!.textContent = auto && name ? `Chosen by Duely: ${name}. Type a name to use your own.`
        : auto ? "Duely picks one that works with your key when you test the connection." : "Your choice. Clear it to let Duely pick.";
    };
    modelDesc(st.ai.auto, st.ai.model);
    let typed = model.value;                                           // the description follows an edit
    model.addEventListener("blur", () => { if (model.value !== typed) { typed = model.value; modelDesc(!typed.trim(), ""); } });
    const base = field(st.ai.baseUrl, { label: "Base URL", placeholder: "https://api.openai.com/v1", onSave: (v) => ({ ai: { baseUrl: v } }) });
    const baseRow = settingRow("Base URL", "Leave empty for OpenAI. Other providers list theirs in their docs.", base);
    const key = h("input", { class: "input", type: "password", placeholder: st.ai.keySet ? "•••••••••••• saved" : "Paste your API key", attrs: { "aria-label": "API key", autocomplete: "off" } });
    const keySave = async () => {
      if (!key.value.trim()) return;
      try { await save({ aiKey: key.value.trim() }, true); key.value = ""; key.placeholder = "•••••••••••• saved"; } catch { key.classList.add("is-invalid"); }
    };
    key.addEventListener("keydown", (e) => { if (e.key === "Enter") void keySave(); });
    key.addEventListener("blur", () => void keySave());
    const paintSeg = () => {
      clear(seg);
      for (const x of PROVIDERS) {
        const b = h("button", { class: ["seg", provider === x.id && "is-active"], attrs: { role: "radio", "aria-checked": String(provider === x.id) } }, x.name);
        b.addEventListener("click", async () => {
          if (provider === x.id) return;
          try { await save({ ai: { provider: x.id } }); provider = x.id; paintSeg(); model.value = typed = ""; modelList.replaceChildren(); modelDesc(true, ""); baseRow.hidden = x.id !== "openai"; } catch { /* toast */ }
        });
        seg.append(b);
      }
    };
    paintSeg();
    baseRow.hidden = provider !== "openai";
    const results = h("div", { class: "test-results" });
    const test = h("button", { class: "btn btn-secondary btn-sm" }, icon("sparkles", 14, "btn-icon"), h("i", { class: "spinner" }), h("span", { class: "btn-label" }, "Test connection"));
    test.addEventListener("click", async () => {
      await keySave();
      spinnerButton(test, true, "Testing…");
      clear(results);
      const stopHint = slowHint(results, SLOW.test);
      const r = await api.testAI().catch((e) => ({ ok: false, message: (e as Error).message }) as CapResult);
      stopHint();
      spinnerButton(test, false, "Test connection");
      results.append(capList(r));
      if (r.ok && r.model) modelDesc(!!r.auto, r.model);
    });
    const cap = field(String(st.ai.dailyLimit), { label: "Daily cap", type: "number", width: "96px", onSave: (v) => ({ ai: { dailyLimit: Number(v) } }) });
    const testRow = settingRow("Test connection", "Checks what this model can do for Duely.", test);
    testRow.append(results);
    return section("AI",
      settingRow("Provider", null, seg),
      modelRow,
      baseRow,
      settingRow("API key", "Kept in your computer's keychain. You're responsible for this key and any charges on it.", key),
      testRow,
      settingRow("Daily cap", "Most requests Duely makes a day. It stops cleanly at the cap.", cap));
  }

  // ---- Notifications
  function notifications(st: Settings) {
    return section("Notifications",
      settingRow("Desktop notifications", "Sync problems, changes and digests.", toggle(st.notifications, (v) => save({ notifications: v }), { label: "Desktop notifications" })),
      settingRow("Important announcements", "When a prof posts something with a date.", toggle(st.importantAnnouncements, (v) => save({ importantAnnouncements: v }), { label: "Important announcements" })),
      settingRow("Discord", "Get your alerts as Discord DMs, so they reach your phone.", h("span", { class: "soon" }, "Coming later"), { muted: true }));
  }

  // ---- Study & digests
  function study(st: Settings) {
    const [from, to] = st.studyDay;
    const fromIn = field(from, { label: "Study from", type: "time", width: "116px", onSave: (v) => ({ studyDay: [v, toIn.value] }) });
    const toIn = field(to, { label: "Study until", type: "time", width: "116px", onSave: (v) => ({ studyDay: [fromIn.value, v] }) });
    const len = h("select", { class: "input", attrs: { "aria-label": "Block length" } },
      [1, 1.5, 2, 3].map((n) => h("option", { value: String(n), selected: n === st.studyBlockHours }, n === 1 ? "1 hour" : `${n} hours`)));
    len.addEventListener("change", () => void save({ studyBlockHours: Number(len.value) }, true).catch(() => {}));
    const more = h("div", { class: "collapse is-closed" }, h("div", { class: "collapse-inner" },
      settingRow("Preferred study hours", "Blocks are only suggested inside these hours.", h("div", { class: "pair" }, fromIn, h("span", { class: "faint" }, "to"), toIn)),
      settingRow("Block length", null, len)));
    const moreBtn = h("button", { class: "more-toggle" }, icon("chevron", 13, "chev"), "More");
    moreBtn.addEventListener("click", () => { const open = more.classList.toggle("is-closed") === false; moreBtn.classList.toggle("is-open", open); });
    const digestTime = field(st.digestTime, { label: "Morning digest time", type: "time", width: "116px", onSave: (v) => ({ digestTime: v }) });
    return section("Study & digests",
      settingRow("Study blocks", "Duely suggests study time before deadlines and tests. Nothing is added until you say yes.",
        toggle(st.studyBlocks, (v) => save({ studyBlocks: v }), { label: "Study blocks" })),
      h("div", { class: "more-wrap" }, moreBtn, more),
      settingRow("Morning digest", "Today's classes and what's due.", h("div", { class: "pair" }, digestTime, toggle(st.digestDaily, (v) => save({ digestDaily: v }), { label: "Morning digest" }))),
      settingRow("Sunday preview", "The week ahead, Sunday evening.", toggle(st.digestWeekly, (v) => save({ digestWeekly: v }), { label: "Sunday preview" })),
      settingRow("Test briefing", "The evening before a test: when, where and what to bring.", toggle(st.briefings, (v) => save({ briefings: v }), { label: "Test briefing" })));
  }

  // ---- Google
  function google(st: Settings) {
    const connected = !!app.status?.google;
    const acct = h("div", { class: "inline-state" });
    const file = h("input", { type: "file", accept: ".json,application/json", class: "sr-only", attrs: { "aria-label": "Google client file" } });
    if (connected) acct.append(h("span", { class: "state-ok" }, icon("check", 14), "Connected"));
    else {
      // with a client saved before, connecting again doesn't need the file
      const saved = !!app.status?.googleClient;
      const pick = h("button", { class: "btn btn-primary btn-sm" }, h("i", { class: "spinner" }), h("span", { class: "btn-label" }, "Connect Google"));
      const other = h("button", { class: "btn btn-ghost btn-sm", hidden: !saved }, "Use a different client file");
      const connect = async (json?: string) => {
        spinnerButton(pick, true, "Finish in your browser…");
        try { await api.connectGoogle(json); await app.refreshStatus(); toast("Google connected"); paint(); }
        catch (e) { toast((e as Error).message); spinnerButton(pick, false, "Connect Google"); }
      };
      pick.addEventListener("click", () => (saved ? void connect() : file.click()));
      other.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => { const f = file.files?.[0]; if (f) await connect(await f.text()); });
      acct.append(h("span", { class: "faint" }, "Not connected"), other, pick, file);
    }
    const login = app.status?.startAtLogin;
    const disc = h("button", { class: "btn btn-quiet-danger btn-sm" }, "Disconnect");
    const discRow = settingRow("Disconnect Google", "Duely stops updating your calendar. The calendar itself stays.", disc);
    disc.addEventListener("click", () => {
      if (discRow.querySelector(".confirm-line")) return;
      const yes = h("button", { class: "btn btn-danger btn-sm" }, "Disconnect");
      const no = h("button", { class: "btn btn-ghost btn-sm" }, "Cancel");
      const line = h("div", { class: "confirm-line" }, h("span", null, "Disconnect Google from Duely?"), yes, no);
      discRow.append(line); expandIn(line);
      no.addEventListener("click", () => line.remove());
      yes.addEventListener("click", async () => {
        try { await api.disconnectGoogle(); await app.refreshStatus(); toast("Google disconnected"); paint(); } catch (e) { toast((e as Error).message); }
      });
    });
    // Duely's engine in the student's Google account (P3.5)
    const c = app.status?.cloud;
    let cloudRows: Node[] = [];
    if (connected && c) {
      const checked = c.readAt ? `checked ${ago(c.readAt)}` : "not checked yet";
      cloudRows = [
        settingRow("Duely in your Google account", c.running ? `Running, every 10 minutes · ${checked}` : `Paused · ${checked}`,
          toggle(c.running, async (v) => { await api.cloudTimer(v); await app.refreshStatus(); }, { label: "Duely in your Google account" })),
        settingRow("Email me alerts", "When this computer is off, alerts go to your Gmail instead.",
          toggle(c.emailAlerts, async (v) => { await api.cloudEmail(v); await app.refreshStatus(); }, { label: "Email me alerts" })),
      ];
    } else if (connected) {
      const wrap = h("div", { class: "setting-wide" });
      const start = h("button", { class: "btn btn-secondary btn-sm" }, "Set up");
      start.addEventListener("click", () => { start.remove(); wrap.append(cloudSetup(() => void app.refreshStatus().then(paint))); expandIn(wrap); });
      const row = settingRow("Keep syncing when this computer is off", "Duely can run in your own Google account, for free.", start, { stack: false });
      cloudRows = [row, wrap];
    }
    return section("Google",
      settingRow("Google account", "Duely only sees the one calendar it creates.", acct),
      ...cloudRows,
      settingRow("Calendar name", null, h("span", { class: "value-text" }, st.calendarName)),
      settingRow("Start at login", login?.can ? "Duely keeps syncing in the background." : "Available in the installed app.",
        toggle(!!login?.on, async (v) => { await api.setStartAtLogin(v); }, { label: "Start at login", disabled: !login?.can })),
      connected && discRow);
  }

  // ---- About
  function about() {
    const link = (label: string, run: () => void) => h("button", { class: "btn btn-ghost btn-sm", on: { click: run } }, label);
    return section("About",
      settingRow("Duely", `Version ${app.status?.version ?? ""}`, null),
      settingRow("Terms of Service", null, link("Read", () => openDoc("terms"))),
      settingRow("Privacy Policy", "Your data stays on this computer and in your own Google account, except what goes to the services you connect.", link("Read", () => openDoc("privacy"))),
      settingRow("Setup guide", "Step by step: Brightspace, Google, your AI, announcements.", link("Read", () => openDoc("setup"))),
      settingRow("Source code", "Open source under the MIT License.", link("GitHub", () => void api.openLink("https://github.com/zaidahmad16/Duely-public-"))));
  }

  function paint() {
    if (!s) return;
    clear(body);
    body.append(sources(s), ai(s), notifications(s), study(s), google(s), about());
  }

  return {
    el: root,
    mount: () => { void api.settings().then((v) => { s = v; paint(); }); },
    refresh: () => {},
    status: () => {},
    destroy: () => {},
  };
}

function shortUrl(u: string): string {
  try { const x = new URL(u); return x.hostname + (x.pathname.length > 28 ? x.pathname.slice(0, 26) + "…" : x.pathname); } catch { return u; }
}
