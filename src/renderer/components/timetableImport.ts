// Timetable and exam schedule from screenshots, like the personal Duely's: pick screenshots → the AI reads
// them → review (one term at a time: dates, no-class days, each class with a tick and its details) →
// "Add to calendar". Nothing is saved before that. Used by Settings → Sources and onboarding.
import type { ExamDraft, Settings, TermDraft } from "../../shared/types.ts";
import { api } from "../ui/api.ts";
import { dayText } from "../ui/format.ts";
import { clear, h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { enter, expandIn, leave } from "../ui/motion.ts";
import { SLOW, slowHint } from "../ui/slow.ts";
import { toast } from "./toast.ts";
import { toggle } from "./toggle.ts";

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_NAME: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
/** Long side, in pixels: enough to read a timetable, small enough for every provider's image limit. */
const MAX_SIDE = 2000;

type Shot = { mime: string; b64: string };

/** The student's screenshots, downscaled if huge. Read here, sent to the AI once, never saved. */
function pickScreenshots(): Promise<Shot[]> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "sr-only", attrs: { multiple: "" } });
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      input.remove();
      resolve(await Promise.all(files.map(shrink)));
    }, { once: true });
    input.addEventListener("cancel", () => { input.remove(); resolve([]); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

async function shrink(file: File): Promise<Shot> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 4e6) {
    const b64 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1] ?? ""); fr.readAsDataURL(file); });
    return { mime: file.type || "image/png", b64 };
  }
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return { mime: "image/png", b64: c.toDataURL("image/png").split(",")[1] ?? "" };
}

/** A sheet over the app: a title, a scrolling body and a footer with the actions. */
function sheet(title: string) {
  const heading = h("h2", { class: "section-title" }, title);
  const closeBtn = h("button", { class: "icon-btn", attrs: { "aria-label": "Close" } }, icon("x", 16));
  const body = h("div", { class: "import-body" });
  const foot = h("div", { class: "import-foot" });
  const el = h("div", { class: "sheet import-sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": title } },
    h("header", { class: "sheet-head" }, heading, closeBtn), body, foot);
  const backdrop = h("div", { class: "sheet-backdrop" }, el);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey);
    await Promise.all([leave(el, { y: 6, dur: 140 }), leave(backdrop, { dur: 140 })]);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") void close(); };
  closeBtn.addEventListener("click", () => void close());
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  enter(backdrop, { y: 0, dur: 160 }); enter(el, { y: 8, dur: 220 });
  return { body, foot, close, setTitle: (t: string) => { heading.textContent = t; el.setAttribute("aria-label", t); }, scrollTop: () => { body.scrollTop = 0; } };
}

const btn = (label: string, cls = "btn btn-ghost") => h("button", { class: cls }, h("i", { class: "spinner" }), h("span", { class: "btn-label" }, label));
function busy(b: HTMLButtonElement, on: boolean, label?: string) {
  b.classList.toggle("is-busy", on); b.disabled = on;
  if (label) (b.querySelector(".btn-label") as HTMLElement).textContent = label;
}
const field = (label: string, input: HTMLElement, hint?: string) =>
  h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint ? h("span", { class: "help" }, hint) : null);
const text = (value: string, o: { type?: string; placeholder?: string; label?: string } = {}) =>
  h("input", { class: "input", type: o.type ?? "text", value, placeholder: o.placeholder ?? "", attrs: o.label ? { "aria-label": o.label } : {} });
const note = (kind: "info" | "warn", ...children: (Node | string)[]) =>
  h("p", { class: ["import-note", `is-${kind}`] }, icon(kind === "warn" ? "warn" : "info", 14), h("span", null, ...children));

/** "Reading your timetable with AI…" while the AI works. */
function reading(s: ReturnType<typeof sheet>, what: string): () => void {
  clear(s.body); clear(s.foot);
  const line = h("p", { class: "help import-reading" }, h("i", { class: "spinner is-on" }), ` Reading your ${what} with AI…`);
  s.body.append(line);
  return slowHint(line, SLOW.test);
}

function failed(s: ReturnType<typeof sheet>, message: string, retry: () => void) {
  clear(s.body); clear(s.foot);
  const noAI = /^Set up your AI/.test(message);                    // nothing to retry until the AI works
  s.body.append(h("p", { class: "cap-fail" }, icon("alert", 14), message));
  if (!noAI) s.body.append(h("p", { class: "help" }, "Tips: use clear, full-size screenshots of the whole week, and check Settings → AI shows ✓ for Screenshots."));
  const cancel = btn(noAI ? "Close" : "Cancel", noAI ? "btn btn-primary" : "btn btn-ghost");
  cancel.addEventListener("click", () => void s.close());
  s.foot.append(cancel);
  if (!noAI) { const again = btn("Choose other screenshots", "btn btn-primary"); again.addEventListener("click", retry); s.foot.append(again); }
}

// ---------------------------------------------------------------- timetable

/** Pick screenshots, read them, review each term found, add. `onSaved` gets the new settings after each add. */
export async function importTimetable(onSaved: (s: Settings) => void): Promise<void> {
  const shots = await pickScreenshots();
  if (!shots.length) return;
  const s = sheet("Add terms from screenshots");
  const stop = reading(s, "timetable");
  let read: { terms: TermDraft[] };
  try { read = await api.readTimetable(shots); } catch (e) {
    stop(); failed(s, (e as Error).message, () => { void s.close(); void importTimetable(onSaved); }); return;
  }
  stop();
  const terms = read.terms;
  const show = (i: number) => {
    if (i >= terms.length) { void s.close(); return; }
    reviewTerm(s, terms[i], i, terms.length, (settings) => { onSaved(settings); toast(`${terms[i].name} added; syncing to your calendar`); show(i + 1); }, () => show(i + 1));
  };
  show(0);
}

function reviewTerm(s: ReturnType<typeof sheet>, t: TermDraft, i: number, n: number, added: (st: Settings) => void, skip: () => void) {
  s.setTitle(n > 1 ? `Add ${t.name} (${i + 1} of ${n})` : `Add ${t.name}`);
  clear(s.body); clear(s.foot); s.scrollTop();
  s.body.append(h("p", { class: "help" }, "The AI read this from your screenshots. Check the classes and dates, fix anything that's off, then add it."
    + (t.dates_source === "academic calendar" ? "" : " The term dates come from the screenshot, and holidays aren't known, so add any days off under No classes.")));
  if (t.tba.length) s.body.append(note("info", `No meeting times, so nothing to add: ${t.tba.join(", ")}.`));
  for (const m of t.notes) s.body.append(note("warn", m));

  // the term
  const name = text(t.name, { label: "Name" });
  const start = text(t.start, { type: "date", label: "First day of classes" });
  const end = text(t.end, { type: "date", label: "Last day of classes" });
  const noClass = text(t.no_class.map(([a, b]) => (a === b ? a : `${a} to ${b}`)).join(", "), { placeholder: "YYYY-MM-DD, or YYYY-MM-DD to YYYY-MM-DD", label: "No classes" });
  const swaps = text(Object.entries(t.day_swaps).map(([d, c]) => `${d} ${c}`).join(", "), { placeholder: "YYYY-MM-DD MO", label: "Follows another day's schedule" });
  s.body.append(h("section", { class: "import-group" }, h("h3", { class: "import-h" }, "Term"),
    h("div", { class: "import-grid" }, field("Name", name), h("div", { class: "pair-fields" }, field("First day of classes", start), field("Last day of classes", end))),
    field("No classes", noClass, "Dates or ranges, comma separated. Breaks from Brightspace are already here."),
    field("Follows another day's schedule", swaps, "A date and the day it follows, e.g. when a Friday runs Monday's classes.")));

  // the classes
  const rows = t.classes.map((c) => classRow(c));
  const count = h("h3", { class: "import-h" }, `Classes (${t.classes.length})`);
  s.body.append(h("section", { class: "import-group" }, count, h("p", { class: "help" }, "Untick anything that shouldn't be added."),
    h("ul", { class: "import-list" }, rows.map((r) => r.el))));

  const err = h("p", { class: "field-error", attrs: { role: "alert" } });
  const cancel = btn(n > 1 ? "Skip this term" : "Cancel"), add = btn("Add to calendar", "btn btn-primary");
  cancel.addEventListener("click", () => (n > 1 ? skip() : void s.close()));
  add.addEventListener("click", async () => {
    err.textContent = "";
    const dates = (v: string) => v.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    const draft: TermDraft = {
      ...t, name: name.value.trim(), start: start.value, end: end.value,
      no_class: noClass.value.split(",").map(dates).filter((d) => d.length).map((d) => [d[0], d[d.length - 1]] as [string, string]),
      day_swaps: Object.fromEntries([...swaps.value.toUpperCase().matchAll(/(\d{4}-\d{2}-\d{2})\W+(MO|TU|WE|TH|FR|SA|SU)/g)].map((m) => [m[1], m[2]])),
      classes: rows.filter((r) => r.on()).map((r) => r.value()),
    };
    busy(add, true, "Adding…");
    try { added(await api.addTerm(draft)); } catch (e) { err.textContent = (e as Error).message; busy(add, false, "Add to calendar"); }
  });
  s.foot.append(err, cancel, add);
}

function classRow(c: TermDraft["classes"][number]) {
  let on = true;
  const sec = () => (section.value.trim() ? `-${section.value.trim().toUpperCase()}` : "");
  const course = text(c.course, { label: "Course" }), section = text(c.section, { label: "Section" }), kind = text(c.kind, { label: "Type" });
  const days = text(c.days.join(" "), { label: "Days" }), startT = text(c.start, { type: "time", label: "Start" }), endT = text(c.end, { type: "time", label: "End" });
  const room = text(c.room, { label: "Room" });
  const title = h("span", { class: "import-title" }), sub = h("span", { class: "import-sub" });
  const paint = () => {
    title.textContent = `${course.value.trim().toUpperCase()}${sec()} ${kind.value.trim() || "Class"}`;
    const ds = days.value.toUpperCase().split(/[\s,]+/).filter((d) => DAYS.includes(d)).map((d) => DAY_NAME[d]);
    sub.textContent = `${ds.join(", ") || "no days"}  ${startT.value}–${endT.value}  ·  ${room.value.trim() || "no room"}`;
  };
  paint();
  for (const x of [course, section, kind, days, startT, endT, room]) x.addEventListener("input", paint);
  const details = h("div", { class: "import-details", hidden: true },
    h("div", { class: "import-grid three" }, field("Course", course), field("Section", section), field("Type", kind)),
    h("div", { class: "import-grid three" }, field("Days", days, "MO TU WE TH FR"), field("Start", startT), field("End", endT)),
    field("Room", room));
  const more = h("button", { class: "icon-btn import-more", attrs: { "aria-label": "Details", "aria-expanded": "false" } }, icon("chevron", 14, "chev"));
  more.addEventListener("click", () => {
    const open = details.hidden === true;
    details.hidden = !open; more.classList.toggle("is-open", open); more.setAttribute("aria-expanded", String(open));
    if (open) expandIn(details);
  });
  const sw = toggle(true, (v) => { on = v; el.classList.toggle("is-off", !v); }, { label: "Add this class" });
  const el = h("li", { class: "import-row" }, h("div", { class: "import-row-head" }, sw, h("div", { class: "import-text" }, title, sub), more), details);
  return {
    el, on: () => on,
    value: () => ({ course: course.value, section: section.value, kind: kind.value, days: days.value.toUpperCase().split(/[\s,]+/).filter(Boolean),
      start: startT.value, end: endT.value, room: room.value, crn: c.crn }),
  };
}

// ---------------------------------------------------------------- final exams

export async function importExams(onSaved: (s: Settings) => void): Promise<void> {
  const shots = await pickScreenshots();
  if (!shots.length) return;
  const s = sheet("Add final exams");
  const stop = reading(s, "exam schedule");
  let exams: ExamDraft[];
  try { exams = await api.readExams(shots); } catch (e) {
    stop(); failed(s, (e as Error).message, () => { void s.close(); void importExams(onSaved); }); return;
  }
  stop();
  clear(s.body);
  s.body.append(h("p", { class: "help" }, "The AI read these from your screenshots. Untick any that are wrong, fix the details, then add them."));
  const rows = exams.map((e) => {
    let on = true;
    const date = text(e.date, { type: "date", label: "Date" }), start = text(e.start, { type: "time", label: "Start" }), end = text(e.end, { type: "time", label: "End" });
    const room = text(e.room, { label: "Room" });
    const sub = h("span", { class: "import-sub" });
    const paint = () => { sub.textContent = `${date.value}, ${start.value}–${end.value}${room.value.trim() ? `  ·  ${room.value.trim()}` : ""}`; };
    paint();
    for (const x of [date, start, end, room]) x.addEventListener("input", paint);
    const details = h("div", { class: "import-details", hidden: true }, h("div", { class: "import-grid four" }, field("Date", date), field("Start", start), field("End", end), field("Room", room)));
    const more = h("button", { class: "icon-btn import-more", attrs: { "aria-label": "Details", "aria-expanded": "false" } }, icon("chevron", 14, "chev"));
    more.addEventListener("click", () => { const open = details.hidden === true; details.hidden = !open; more.classList.toggle("is-open", open); more.setAttribute("aria-expanded", String(open)); if (open) expandIn(details); });
    const sw = toggle(true, (v) => { on = v; el.classList.toggle("is-off", !v); }, { label: "Add this exam" });
    const el = h("li", { class: "import-row" }, h("div", { class: "import-row-head" }, sw, h("div", { class: "import-text" }, h("span", { class: "import-title" }, `${e.course} ${e.title}`), sub), more), details);
    return { el, on: () => on, value: (): ExamDraft => ({ ...e, date: date.value, start: start.value, end: end.value, room: room.value }) };
  });
  s.body.append(h("section", { class: "import-group" }, h("h3", { class: "import-h" }, `Exams (${exams.length})`), h("ul", { class: "import-list" }, rows.map((r) => r.el))));
  const err = h("p", { class: "field-error", attrs: { role: "alert" } });
  const cancel = btn("Cancel"), add = btn("Add to calendar", "btn btn-primary");
  cancel.addEventListener("click", () => void s.close());
  add.addEventListener("click", async () => {
    err.textContent = "";
    const picked = rows.filter((r) => r.on()).map((r) => r.value());
    busy(add, true, "Adding…");
    try {
      onSaved(await api.addExams(picked));
      toast(`${picked.length} exam${picked.length === 1 ? "" : "s"} added; syncing to your calendar`);
      void s.close();
    } catch (e) { err.textContent = (e as Error).message; busy(add, false, "Add to calendar"); }
  });
  s.foot.append(err, cancel, add);
}

// ---------------------------------------------------------------- the lists in Settings

const fmt = dayText;

/** Saved terms and exams, each removable (asks first). `refresh` repaints with the new settings. */
export function savedList(st: Settings, which: "terms" | "exams", refresh: (s: Settings) => void): HTMLElement {
  const list = h("ul", { class: "saved-list" });
  const today = new Date().toISOString().slice(0, 10);
  const rows = which === "terms"
    ? st.terms.map((t) => ({ key: t.key, title: t.name, past: t.end < today, what: "this term's classes",
      sub: `${fmt(t.start, { month: "short", day: "numeric" })} – ${fmt(t.end, { month: "short", day: "numeric", year: "numeric" })}  ·  ${t.classes} class${t.classes === 1 ? "" : "es"}: ${t.courses.join(", ")}`,
      remove: () => api.removeTerm(t.key) }))
    : st.exams.map((e) => ({ key: e.key, title: `${e.course} ${e.title}`, past: e.date < today, what: "this exam",
      sub: `${fmt(e.date, { weekday: "short", month: "short", day: "numeric" })}, ${e.start}–${e.end}${e.room ? `  ·  ${e.room}` : ""}`,
      remove: () => api.removeExam(e.key) }));
  if (!rows.length) {
    list.append(h("li", { class: "saved-empty" }, which === "terms" ? "No terms yet. Take screenshots of your weekly timetable and add them here." : "No exams yet. The exam schedule usually comes out mid-term."));
    return list;
  }
  for (const r of rows) {
    const rm = h("button", { class: "icon-btn", attrs: { "aria-label": `Remove ${r.title}`, title: "Remove" } }, icon("x", 14));
    const li = h("li", { class: ["saved-row", r.past && "is-past"] }, h("div", { class: "import-text" }, h("span", { class: "import-title" }, r.title), h("span", { class: "import-sub" }, r.sub)), rm);
    rm.addEventListener("click", () => {
      if (li.querySelector(".confirm-line")) return;
      const yes = h("button", { class: "btn btn-danger btn-sm" }, "Remove"), no = h("button", { class: "btn btn-ghost btn-sm" }, "Keep");
      const line = h("div", { class: "confirm-line" }, h("span", null, `Remove ${r.what} from your calendar?`), yes, no);
      li.append(line); expandIn(line);
      no.addEventListener("click", () => line.remove());
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        try { refresh(await r.remove()); toast(`${r.title} removed; it leaves your calendar on the next sync`); } catch (e) { toast((e as Error).message); yes.disabled = false; }
      });
    });
    list.append(li);
  }
  return list;
}
