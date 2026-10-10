// Upcoming: what matters, in a few seconds. Questions from Duely first, then Today / This week /
// Next week as quiet rows, then a collapsed "Filtered out". Data refreshes in place without
// re-animating anything that was already on screen.
import type { Question, Row, Upcoming } from "../../shared/types.ts";
import { proposalCard } from "../components/proposal.ts";
import { taskRow } from "../components/taskRow.ts";
import { api } from "../ui/api.ts";
import { ago } from "../ui/format.ts";
import { clear, h } from "../ui/h.ts";
import { icon, mark } from "../ui/icons.ts";
import { collapseOut, enter, stagger } from "../ui/motion.ts";
import type { AppCtx, Screen } from "./types.ts";

export function upcomingScreen(app: AppCtx): Screen {
  const statusLine = h("span", { class: "status-text" });
  const syncBtn = h("button", { class: "btn btn-secondary btn-sm sync-btn" }, icon("sync", 14, "sync-icon"), h("span", { class: "btn-label" }, "Sync now"));
  const questions = h("div", { class: "questions" });
  const more = h("button", { class: "more-questions", hidden: true }, icon("chevron", 13, "chev"), h("span"));
  const groups = h("div", { class: "groups" });
  const filtered = h("div", { class: "filtered" });
  const root = h("div", { class: "page page-upcoming" },
    h("header", { class: "page-head" },
      h("h1", { class: "page-title" }, "Upcoming"),
      h("div", { class: "page-sub" }, statusLine, syncBtn)),
    questions, more, groups, filtered);

  let data: Upcoming | null = null;
  let filteredOpen = false;
  let confirmUntil = 0;

  // ---- status line + sync button
  function paintStatus() {
    const s = app.status;
    root.classList.toggle("is-syncing", app.syncing);
    syncBtn.disabled = app.syncing;
    (syncBtn.querySelector(".btn-label") as HTMLElement).textContent = app.syncing ? "Syncing…" : "Sync now";
    if (app.syncing) { statusLine.textContent = "Syncing…"; statusLine.className = "status-text"; return; }
    if (Date.now() < confirmUntil) return;                          // "✓ Synced just now" is showing
    if (!s || !s.sync.time) { statusLine.textContent = "Not synced yet"; statusLine.className = "status-text"; return; }
    // Google not being connected is the banner's job; here only a real sync problem shows
    const problem = s.sync.error && !s.sync.needsGoogle;
    statusLine.className = ["status-text", problem ? "is-warn" : ""].join(" ");
    statusLine.textContent = problem
      ? `Last sync didn't finish · ${ago(s.sync.time * 1000)}`
      : `${s.sync.needsGoogle ? "Read from Brightspace" : "Synced"} ${ago(s.sync.time * 1000)} · ${s.sync.items} item${s.sync.items === 1 ? "" : "s"}`;
  }

  syncBtn.addEventListener("click", async () => {
    const ok = await app.sync();
    if (!ok) return;
    confirmUntil = Date.now() + 1600;
    statusLine.className = "status-text is-ok";
    statusLine.replaceChildren(icon("check", 13), " Synced just now");
    setTimeout(() => {
      statusLine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in" }).onfinish = () => {
        confirmUntil = 0; paintStatus();
        statusLine.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      };
    }, 1600);
  });

  // ---- questions (kept by id: new ones slide in, answered ones collapse themselves). At most two
  // show; the rest wait behind a quiet "N more" so the schedule stays in view.
  const SHOWN = 2;
  let showAll = false;
  more.addEventListener("click", () => { showAll = !showAll; more.classList.toggle("is-open", showAll); paintMore(); });
  function paintMore() {
    const cards = [...questions.children].filter((el) => !el.querySelector(".is-resolved")) as HTMLElement[];
    cards.forEach((el, i) => {
      const hide = !showAll && i >= SHOWN;
      if (el.hidden && !hide) { el.hidden = false; enter(el, { y: 4, dur: 180 }); } else el.hidden = hide;
    });
    const extra = cards.length - SHOWN;
    more.hidden = extra <= 0;
    (more.lastElementChild as HTMLElement).textContent = showAll ? "Show fewer" : `${extra} more suggestion${extra === 1 ? "" : "s"}`;
  }
  function paintQuestions(qs: Question[], tz: string) {
    const order = (q: Question) => (q.kind === "study" ? 1 : 0);   // "disappeared" questions first
    qs = [...qs].sort((a, b) => order(a) - order(b));
    const have = new Map([...questions.children].map((el) => [(el as HTMLElement).dataset.id!, el as HTMLElement]));
    const want = new Set(qs.map((q) => q.id));
    for (const [id, el] of have) if (!want.has(id) && !el.querySelector(".is-resolved")) void collapseOut(el, 220);
    for (const q of qs) {
      if (have.has(q.id)) continue;
      const card = proposalCard(q, { tz, onResolved: () => setTimeout(paintMore, 800) });
      const i = qs.indexOf(q);
      const before = qs.slice(i + 1).map((x) => have.get(x.id)).find(Boolean);
      if (before) questions.insertBefore(card, before); else questions.append(card);
    }
    paintMore();
  }

  // ---- the three groups
  function group(title: string, rows: Row[], empty: string, d: Upcoming): HTMLElement {
    return h("section", { class: "group" },
      h("h2", { class: "group-head" }, h("span", { class: "section-title" }, title), rows.length ? h("span", { class: "group-count" }, String(rows.length)) : null),
      rows.length
        ? h("ul", { class: "rows" }, rows.map((r) => taskRow(r, { tz: d.tz, now: Date.now(), collapseOnDone: true, onDone: () => void refresh() })))
        : h("p", { class: "group-empty" }, empty));
  }

  function paintGroups(d: Upcoming) {
    clear(groups);
    const nothing = !d.today.length && !d.thisWeek.length && !d.nextWeek.length;
    if (nothing && (!app.status?.sync.time)) {
      groups.append(h("div", { class: "empty" }, h("div", { class: "empty-mark breathe" }, mark(28)),
        h("p", { class: "empty-title" }, "Duely is reading Brightspace…"),
        h("p", { class: "muted" }, "Your deadlines, tests and classes will show up here in a moment.")));
      return;
    }
    if (nothing) {
      groups.append(h("div", { class: "empty" }, h("div", { class: "empty-mark" }, mark(28)),
        h("p", { class: "empty-title" }, "You're clear for today."),
        h("p", { class: "muted" }, "Nothing else is due in the next two weeks.")));
      return;
    }
    groups.append(
      group("Today", d.today, d.thisWeek.length ? "You're clear for today." : "You're clear for today. Nothing else is due this week.", d),
      group("This week", d.thisWeek, "Nothing else this week.", d),
      group("Next week", d.nextWeek, "Nothing due yet.", d));
  }

  function paintFiltered(d: Upcoming) {
    clear(filtered);
    if (!d.filtered.length) return;
    const body = h("div", { class: ["collapse", !filteredOpen && "is-closed"] },
      h("div", { class: "collapse-inner" },
        h("ul", { class: "filtered-list" }, d.filtered.map((f) =>
          h("li", null, h("span", { class: "filtered-title" }, `${f.course ? f.course + " " : ""}${f.title}`), f.reason && h("span", { class: "faint" }, f.reason))))));
    const btn = h("button", { class: ["filtered-toggle", filteredOpen && "is-open"], attrs: { "aria-expanded": String(filteredOpen) } },
      icon("chevron", 14, "chev"), `Filtered out · ${d.filtered.length}`);
    btn.addEventListener("click", () => {
      filteredOpen = !filteredOpen;
      btn.classList.toggle("is-open", filteredOpen);
      btn.setAttribute("aria-expanded", String(filteredOpen));
      body.classList.toggle("is-closed", !filteredOpen);
      if (filteredOpen) stagger(body.querySelectorAll("li"), 20, { y: 3, dur: 160, start: 40 });
    });
    filtered.append(btn, body);
  }

  async function refresh(first = false) {
    // a row is mid "done" animation: let it finish first
    if (groups.querySelector(".row.is-done")) { setTimeout(() => void refresh(), 1200); return; }
    try { data = await api.upcoming(); } catch { return; }
    paintQuestions(data.questions, data.tz);
    paintGroups(data);
    paintFiltered(data);
    paintStatus();
    if (first) stagger([root.querySelector(".page-head")!, questions, ...groups.children, filtered], 40, { y: 6, dur: 200 });
  }

  // relative times ("2 min ago", "Due in 2h") stay current
  const clock = setInterval(() => { paintStatus(); if (data && !groups.querySelector(".row.is-done")) paintGroups(data); }, 60e3);

  return {
    el: root,
    mount: () => void refresh(true),
    refresh: () => void refresh(),
    status: paintStatus,
    destroy: () => clearInterval(clock),
  };
}
