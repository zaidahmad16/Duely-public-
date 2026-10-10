// First run: five focused steps in a compact window. Each step: a clear title, one line of
// explanation, the one thing to do, Continue (and a quiet secondary action). Steps slide 8px
// (out to the left, in from the right); the progress bar fills to the next segment.
import type { Provider } from "../../shared/types.ts";
import { toggle } from "../components/toggle.ts";
import { api } from "../ui/api.ts";
import { clear, h } from "../ui/h.ts";
import { icon, mark } from "../ui/icons.ts";
import { enter, leave, reduced, wait } from "../ui/motion.ts";
import { PROVIDERS, capList, spinnerButton } from "./settings.ts";

const STEPS = 5;

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

  function view(title: string, text: string, body: Node[], actions: Node[]): HTMLElement {
    return h("section", { class: "ob-step" },
      h("h1", { class: "ob-title" }, title), h("p", { class: "ob-text" }, text),
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
        try { await api.saveSettings({ feedUrl: inp.value }); await go(1); } catch (x) { e.textContent = (x as Error).message; inp.classList.add("is-invalid"); }
        spinnerButton(next, false);
      };
      next.addEventListener("click", () => void submit());
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void submit(); });
      void api.settings().then((s) => { if (s.feedUrl && !inp.value) inp.value = s.feedUrl; }).catch(() => {});
      return view("Connect Brightspace", "Duely reads your course calendar to find deadlines, tests and classes.",
        [h("label", { class: "field-label" }, "Brightspace calendar link"), inp, e,
          h("p", { class: "help" }, "In Brightspace, open Calendar → Subscribe, and copy the link it shows.")],
        [next]);
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
      connect.addEventListener("click", async () => {
        e.textContent = "";
        spinnerButton(connect, true, "Finish in your browser…");
        try {
          await api.connectGoogle(text);
          connect.hidden = true; next.hidden = false;
          state.replaceChildren(h("span", { class: "connected" }, h("span", { class: "connected-icon" }, icon("check", 14)), "Google Calendar connected"));
          state.firstElementChild!.animate([{ opacity: 0, transform: reduced() ? "none" : "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 150, easing: "ease-out" });
          next.focus();
        } catch (x) {
          e.textContent = (x as Error).message;
          spinnerButton(connect, false, "Connect Google");
        }
      });
      void api.status().then((s) => { if (s.google) { connect.hidden = true; next.hidden = false; state.replaceChildren(h("span", { class: "connected" }, h("span", { class: "connected-icon" }, icon("check", 14)), "Google Calendar connected")); } }).catch(() => {});
      return view("Connect Google Calendar", "Duely puts everything in a calendar of its own. It can't see or change your other calendars.",
        [h("ol", { class: "checklist" },
          h("li", null, h("span", null, "Create a ", h("strong", null, "Desktop app"), " OAuth client in Google Cloud.")),
          h("li", null, h("span", null, "Download its JSON file.")),
          h("li", null, h("span", { class: "check-file" }, pick, chosen, file))),
          state, e],
        [back(), h("button", { class: "btn btn-ghost", on: { click: () => void go(2) } }, "Skip for now"), connect, next]);
    },
    // 3. AI
    () => {
      let provider: Provider | "" = "";
      const opts = h("div", { class: "provider-grid", attrs: { role: "radiogroup", "aria-label": "AI provider" } });
      const key = h("input", { class: "input", type: "password", placeholder: "Paste your API key", attrs: { "aria-label": "API key", autocomplete: "off" } });
      const model = h("input", { class: "input", placeholder: "Model", attrs: { "aria-label": "Model" } });
      const base = h("input", { class: "input", placeholder: "https://api.openai.com/v1", attrs: { "aria-label": "Base URL" } });
      const baseWrap = h("div", { class: "field", hidden: true }, h("label", { class: "field-label" }, "Base URL ", h("span", { class: "faint" }, "(only if not OpenAI)")), base);
      const details = h("div", { class: "ai-details", hidden: true },
        h("div", { class: "field" }, h("label", { class: "field-label" }, "API key"), key),
        h("div", { class: "field" }, h("label", { class: "field-label" }, "Model"), model), baseWrap);
      const results = h("div", { class: "test-results" });
      const e = err();
      const test = h("button", { class: "btn btn-secondary", disabled: true }, icon("sparkles", 14, "btn-icon"), h("i", { class: "spinner" }), h("span", { class: "btn-label" }, "Test connection"));
      for (const p of PROVIDERS) {
        const b = h("button", { class: "provider", attrs: { role: "radio", "aria-checked": "false" } },
          h("span", { class: "provider-name" }, p.name), h("span", { class: "provider-hint" }, p.hint));
        b.addEventListener("click", () => {
          provider = p.id;
          for (const x of opts.children) { x.classList.toggle("is-active", x === b); x.setAttribute("aria-checked", String(x === b)); }
          model.placeholder = p.model; if (!model.value) model.value = p.model;
          baseWrap.hidden = p.id !== "openai";
          if (details.hidden) { details.hidden = false; enter(details, { y: 6, dur: 200 }); }
          test.disabled = false;
        });
        opts.append(b);
      }
      const persist = async () => {
        await api.saveSettings({ ai: { provider: provider as Provider, model: model.value, baseUrl: base.value }, ...(key.value.trim() ? { aiKey: key.value } : {}) });
      };
      test.addEventListener("click", async () => {
        e.textContent = ""; clear(results);
        spinnerButton(test, true, "Testing…");
        try {
          await persist();
          results.append(capList(await api.testAI()));
        } catch (x) { e.textContent = (x as Error).message; }
        spinnerButton(test, false, "Test connection");
      });
      const next = h("button", { class: "btn btn-primary" }, "Continue");
      next.addEventListener("click", async () => {
        if (provider) { try { await persist(); } catch (x) { e.textContent = (x as Error).message; return; } }
        await go(3);
      });
      return view("Choose your AI", "Duely uses one AI of your choice to answer questions and read announcements. Your key stays on this computer.",
        [opts, details, h("div", { class: "test-line" }, test), results, e],
        [back(), h("button", { class: "btn btn-ghost", on: { click: () => void go(3) } }, "Skip for now"), next]);
    },
    // 4. More context (optional)
    () => {
      const inp = h("input", { class: "input", placeholder: "https://…/d2l/le/news/rss/…", attrs: { "aria-label": "Announcements link" } });
      const e = err();
      const next = h("button", { class: "btn btn-primary" }, "Continue");
      next.addEventListener("click", async () => {
        e.textContent = "";
        if (inp.value.trim()) {
          try { const s = await api.settings(); await api.saveSettings({ announcementFeeds: [...s.announcementFeeds, inp.value.trim()] }); }
          catch (x) { e.textContent = (x as Error).message; inp.classList.add("is-invalid"); return; }
        }
        await go(4);
      });
      return view("Add more context", "Both are optional. You can add more later in Settings.",
        [h("div", { class: "field" }, h("label", { class: "field-label" }, "Announcements link ", h("span", { class: "optional" }, "Optional")), inp,
          h("p", { class: "help" }, "On a course's Announcements page, copy the RSS link. Add the rest in Settings.")),
          e,
          h("div", { class: "field is-muted" }, h("label", { class: "field-label" }, "Timetable screenshot ", h("span", { class: "optional" }, "Optional")),
            h("div", { class: "dropzone" }, icon("upload", 16, "faint"), h("span", null, "Screenshot import is coming soon")))],
        [back(), h("button", { class: "btn btn-ghost", on: { click: () => void go(4) } }, "Skip for now"), next]);
    },
    // 5. Notifications
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
            toggle(true, (v) => { notif.important = v; }, { label: "Important announcements" }))), e],
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
