// First run: five focused steps in a compact window. Each step: a clear title, one line of
// explanation, the one thing to do, Continue (and a quiet secondary action). Steps slide 8px
// (out to the left, in from the right); the progress bar fills to the next segment.
import { toggle } from "../components/toggle.ts";
import { api } from "../ui/api.ts";
import { h } from "../ui/h.ts";
import { icon, mark } from "../ui/icons.ts";
import { enter, leave, reduced, wait } from "../ui/motion.ts";
import { aiSetup } from "../components/aiSetup.ts";
import { cloudSetup } from "../components/cloudSetup.ts";
import { TERMS_VERSION, helpLink, legalLine } from "../components/doc.ts";
import { spinnerButton } from "./settings.ts";
import { splitLinks } from "../ui/links.ts";
import { importTimetable } from "../components/timetableImport.ts";
import { discordControl } from "../components/discordRow.ts";

const STEPS = 5;

/** Onboarding step 4's timetable: the same import as Settings, with what was added listed under it. */
function timetableField(): HTMLElement {
  const added = h("ul", { class: "saved-list" });
  const pick = h("button", { class: "dropzone", type: "button" }, icon("upload", 16, "faint"),
    h("span", null, "Add terms from screenshots of your weekly timetable"));
  pick.addEventListener("click", () => void importTimetable((s) => {
    added.replaceChildren(...s.terms.map((t) => h("li", { class: "saved-row" }, icon("check", 14, "state-ok"),
      h("span", { class: "import-title" }, `${t.name}: ${t.classes} class${t.classes === 1 ? "" : "es"}`))));
  }));
  return h("div", { class: "field" }, h("label", { class: "field-label" }, "Timetable screenshots ", h("span", { class: "optional" }, "Optional")),
    pick, added, h("p", { class: "help" }, "Fall and winter together is fine. You check everything before it's added."));
}

export function onboarding(done: () => void): HTMLElement {
  const bar = h("div", { class: "steps-bar", attrs: { role: "progressbar", "aria-valuemin": "1", "aria-valuemax": String(STEPS) } },
    Array.from({ length: STEPS }, () => h("i", null, h("b"))));
  const count = h("span", { class: "meta" });
  const stage = h("div", { class: "ob-stage" });
  const root = h("div", { class: "onboarding" },
    h("header", { class: "ob-head" }, h("div", { class: "ob-brand" }, mark(22), h("span", null, "Duely")), count),
    bar, stage);

  let step = 0;
  const notif = { notifications: true, important: true };

  function progress() {
    count.textContent = `Step ${step + 1} of ${STEPS}`;
    bar.setAttribute("aria-valuenow", String(step + 1));
    [...bar.children].forEach((seg, i) => seg.classList.toggle("is-on", i <= step));
  }

  async function go(next: number) {
    const old = stage.firstElementChild as HTMLElement | null;
    const forward = next > step;
    if (old) { await leave(old, { x: forward ? -8 : 8, dur: 120 }); old.remove(); }
    step = next;
    progress();
    const el = views[step]();
    stage.append(el);
    enter(el, { x: forward ? 8 : -8, y: 0, dur: 220 });
    (el.querySelector("input:not([type=file]), button.btn-primary") as HTMLElement | null)?.focus();
  }

  function view(title: string, text: string, body: Node[], actions: Node[], help?: string): HTMLElement {
    return h("section", { class: "ob-step" },
      h("h1", { class: "ob-title" }, title), h("p", { class: "ob-text" }, text, help ? [" ", helpLink(help)] : null),
      h("div", { class: "ob-body" }, body), h("div", { class: "ob-actions" }, actions));
  }

  const err = () => h("p", { class: "field-error", attrs: { role: "alert" } });
  const back = () => h("button", { class: "btn btn-ghost", on: { click: () => void go(step - 1) } }, "Back");

  const views: (() => HTMLElement)[] = [
    // 1. Brightspace
    () => {
      const inp = h("input", { class: "input input-lg", placeholder: "webcal://…/feed.ics?token=…", attrs: { "aria-label": "Brightspace calendar link" } });
      const e = err();
      const next = h("button", { class: "btn btn-primary" }, h("span", { class: "btn-label" }, "Continue"));
      const submit = async () => {
        e.textContent = "";
        if (!inp.value.trim()) { e.textContent = "Paste your calendar link to continue."; return; }
        spinnerButton(next, true);
        try { await api.saveSettings({ feedUrl: inp.value }); await api.acceptTerms(TERMS_VERSION); await go(1); } catch (x) { e.textContent = (x as Error).message; inp.classList.add("is-invalid"); }
        spinnerButton(next, false);
      };
      next.addEventListener("click", () => void submit());
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void submit(); });
      void api.settings().then((s) => { if (s.feedUrl && !inp.value) inp.value = s.feedUrl; }).catch(() => {});
      return view("Connect Brightspace", "Duely reads your course calendar to find deadlines, tests and classes.",
        [h("label", { class: "field-label" }, "Brightspace calendar link"), inp, e,
          h("p", { class: "help" }, "In Brightspace, open Calendar → Subscribe, and copy the link it shows.")],
        [legalLine(), next], "1. Your Brightspace");
    },
    // 2. Google
    () => {
      const file = h("input", { type: "file", accept: ".json,application/json", class: "sr-only", attrs: { "aria-label": "Google client file" } });
      const chosen = h("span", { class: "file-name faint" }, "No file chosen");
      const pick = h("button", { class: "btn btn-secondary btn-sm" }, icon("upload", 14, "btn-icon"), "Choose file");
      pick.addEventListener("click", () => file.click());
      let text = "";
      file.addEventListener("change", async () => {
        const f = file.files?.[0]; if (!f) return;
        text = await f.text(); chosen.textContent = f.name; chosen.className = "file-name";
        connect.disabled = false;
        enter(chosen, { x: 4, y: 0, dur: 160 });
      });
      const state = h("div", { class: "connect-state" });
      const e = err();
      const connect = h("button", { class: "btn btn-primary", disabled: true }, h("i", { class: "spinner" }), h("span", { class: "btn-label" }, "Connect Google"));
      const next = h("button", { class: "btn btn-primary", hidden: true }, h("span", { class: "btn-label" }, "Continue"));
      next.addEventListener("click", () => void go(2));
      // after Google is connected: put Duely's engine in the student's Google account (P3.5)
      const cloud = h("div", { class: "ob-cloud" });
      const localOnly = h("button", { class: "btn btn-ghost", hidden: true }, "Sync from this computer only");
      localOnly.addEventListener("click", () => void go(2));
      const showCloud = () => {
        if (cloud.firstChild) return;
        cloud.append(cloudSetup(() => { next.hidden = false; localOnly.hidden = true; next.focus(); }));
        enter(cloud, { y: 6, dur: 200 });
        localOnly.hidden = false; next.hidden = true;
      };
      connect.addEventListener("click", async () => {
        e.textContent = "";
        spinnerButton(connect, true, "Finish in your browser…");
        try {
          await api.connectGoogle(text);
          connect.hidden = true;
          state.replaceChildren(h("span", { class: "connected" }, h("span", { class: "connected-icon" }, icon("check", 14)), "Google Calendar connected"));
          state.firstElementChild!.animate([{ opacity: 0, transform: reduced() ? "none" : "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 150, easing: "ease-out" });
          showCloud();
        } catch (x) {
          e.textContent = (x as Error).message;
          spinnerButton(connect, false, "Connect Google");
        }
      });
      void api.status().then((s) => { if (s.google) { connect.hidden = true; state.replaceChildren(h("span", { class: "connected" }, h("span", { class: "connected-icon" }, icon("check", 14)), "Google Calendar connected")); showCloud(); } }).catch(() => {});
      return view("Connect Google Calendar", "Duely puts everything in a calendar of its own. It can't see or change your other calendars.",
        [h("ol", { class: "checklist" },
          h("li", null, h("span", null, "Create a ", h("strong", null, "Desktop app"), " OAuth client in Google Cloud.")),
          h("li", null, h("span", null, "Download its JSON file.")),
          h("li", null, h("span", { class: "check-file" }, pick, chosen, file))),
          state, cloud, e],
        [back(), h("button", { class: "btn btn-ghost", on: { click: () => void go(2) } }, "Skip for now"), localOnly, connect, next], "2. Google");
    },
    // 3. AI (required: Continue only after the connection test passes)
    () => {
      const next = h("button", { class: "btn btn-primary", disabled: true }, "Continue");
      const setup = aiSetup((ok) => { next.disabled = !ok; });
      next.addEventListener("click", () => { if (setup.ready()) void go(3); });
      // coming back to this step: start from what's saved (and already tested)
      void Promise.all([api.settings(), api.status()]).then(([s, st]) => {
        if (!s.ai.provider || setup.el.querySelector(".provider.is-active")) return;
        const fresh = aiSetup((ok) => { next.disabled = !ok; }, s, st.aiReady);
        setup.el.replaceWith(fresh.el); Object.assign(setup, fresh);
        next.disabled = !st.aiReady;
      }).catch(() => {});
      return view("Choose your AI", "Duely uses one AI of your choice to answer questions and read announcements. Only you and your AI provider ever see your key.",
        [setup.el], [back(), next], "3. Your AI");
    },
    // 4. More context (optional)
    () => {
      const inp = h("textarea", { class: "input input-multi", attrs: { rows: "3", "aria-label": "Announcements links", placeholder: "https://…/d2l/le/news/rss/…\nhttps://…/d2l/le/news/rss/…" } });
      const e = err();
      const next = h("button", { class: "btn btn-primary" }, "Continue");
      next.addEventListener("click", async () => {
        e.textContent = "";
        if (inp.value.trim()) {
          const s = await api.settings();
          const { links, rest } = splitLinks(inp.value, s.announcementFeeds);
          if (rest.length) { e.textContent = `Not a link: ${rest.slice(0, 2).join(", ")}${rest.length > 2 ? "…" : ""}. Copy the RSS links from each course's Announcements page.`; inp.classList.add("is-invalid"); return; }
          try { if (links.length) await api.saveSettings({ announcementFeeds: [...s.announcementFeeds, ...links] }); }
          catch (x) { e.textContent = (x as Error).message; inp.classList.add("is-invalid"); return; }
        }
        await go(4);
      });
      return view("Add more context", "Both are optional. You can add more later in Settings.",
        [h("div", { class: "field" }, h("label", { class: "field-label" }, "Announcements links ", h("span", { class: "optional" }, "Optional")), inp,
          h("p", { class: "help" }, "On each course's Announcements page, copy the RSS link. Paste them all here, one per line.")),
          e,
          timetableField()],
        [back(), h("button", { class: "btn btn-ghost", on: { click: () => void go(4) } }, "Skip for now"), next], "4. Course announcements");
    },
    // 5. Notifications (step 4's timetable field is below)
    () => {
      const finish = h("button", { class: "btn btn-primary" }, h("span", { class: "btn-label" }, "Start using Duely"));
      const e = err();
      finish.addEventListener("click", async () => {
        spinnerButton(finish, true);
        try {
          await api.saveSettings({ notifications: notif.notifications, importantAnnouncements: notif.important });
          await celebrate();
          await api.finishOnboarding();
          done();
        } catch (x) { e.textContent = (x as Error).message; spinnerButton(finish, false); }
      });
      return view("Stay in the loop", "Duely works in the background and lets you know when something needs you.",
        [h("div", { class: "ob-toggles" },
          h("div", { class: "setting" }, h("div", { class: "setting-label" }, h("div", { class: "setting-name" }, "Desktop notifications"), h("div", { class: "setting-desc" }, "Changes, digests and sync problems.")),
            toggle(true, (v) => { notif.notifications = v; }, { label: "Desktop notifications" })),
          h("div", { class: "setting" }, h("div", { class: "setting-label" }, h("div", { class: "setting-name" }, "Important announcements"), h("div", { class: "setting-desc" }, "When a prof posts a date or a change.")),
            toggle(true, (v) => { notif.important = v; }, { label: "Important announcements" })),
          h("div", { class: "setting is-stacked" }, h("div", { class: "setting-label" }, h("div", { class: "setting-name" }, "Alerts on your phone ", h("span", { class: "optional" }, "Optional")),
            h("div", { class: "setting-desc" }, "The same alerts as Discord DMs from the Duely bot.")),
            discordControl(null, () => {}, { compact: true }))), e],
        [back(), finish]);
    },
  ];

  /** A short check-and-spark, then on into the app. No confetti. */
  async function celebrate() {
    const old = stage.firstElementChild as HTMLElement;
    await leave(old, { y: -6, dur: 140 }); old.remove();
    const m = h("div", { class: "ob-done" }, h("div", { class: "ob-done-mark" }, mark(44), h("i", { class: "spark s1" }), h("i", { class: "spark s2" }), h("i", { class: "spark s3" })),
      h("p", { class: "ob-title" }, "You're all set"));
    stage.append(m);
    m.animate([{ opacity: 0, transform: reduced() ? "none" : "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    await wait(900);
    await leave(root, { dur: 160 });
  }

  void go(0);
  return root;
}
