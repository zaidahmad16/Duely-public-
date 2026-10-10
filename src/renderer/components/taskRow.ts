// A task row: checkbox · course · title · type · when. The title leads; due time next; course and
// type are quiet. Ticking it plays the done sequence (fill → check draws → strike → muted), then
// the caller may collapse it away. Only work you hand in or sit gets a checkbox.
import type { Row } from "../../shared/types.ts";
import { api } from "../ui/api.ts";
import { when } from "../ui/format.ts";
import { h } from "../ui/h.ts";
import { collapseOut, wait } from "../ui/motion.ts";
import { toast } from "./toast.ts";

const NS = "http://www.w3.org/2000/svg";

/** A muted, stable colour per course (hue from the code; low saturation so nothing shouts). */
export function courseHue(code: string): number {
  let x = 0;
  for (const ch of code) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return [18, 42, 95, 150, 190, 215, 255, 325][x % 8];
}

function checkSvg(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "check-svg");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M3.8 8.3l2.7 2.6 5.7-6"); p.setAttribute("pathLength", "1");
  svg.append(p);
  return svg;
}

const canTick = (r: Row) => r.deadline || r.category === "test" || r.category === "quiz";

export type RowOpts = { tz: string; now: number; collapseOnDone?: boolean; onDone?: (r: Row, done: boolean) => void;
  /** under a day heading already: show the time only */
  timeOnly?: boolean };

export function taskRow(r: Row, o: RowOpts): HTMLElement {
  const w = when(r, o.tz, o.now, o.timeOnly);
  const name = `${r.course ? r.course + " " : ""}${r.title}`;
  const box = canTick(r)
    ? h("button", { class: "check", attrs: { role: "checkbox", "aria-checked": String(r.done), "aria-label": `Mark ${name} done` } }, checkSvg())
    : h("span", { class: "check check-none", attrs: { "aria-hidden": "true" } });
  const el = h("li", { class: ["row", `cat-${r.category}`, r.done && "is-done"], data: { key: r.key },
    attrs: { title: r.url ? "Open in Brightspace" : undefined } },
    box,
    h("span", { class: "row-course" }, r.course && h("i", { class: "course-dot", style: { "--h": String(courseHue(r.course)) } }), r.course),
    h("span", { class: "row-title" }, h("span", { class: "row-title-text" }, r.title),
      r.announced && h("span", { class: "row-flag", attrs: { title: "Read from an announcement by AI. Double-check it." } }, "from announcement")),
    h("span", { class: "row-type" }, r.label),
    h("span", { class: ["row-when", w.urgent && "is-urgent"] }, w.text));

  if (r.url) el.addEventListener("click", (e) => { if (!(e.target as Element).closest(".check")) void api.openLink(r.url!); });
  if (box instanceof HTMLButtonElement) {
    box.addEventListener("click", async (e) => {
      e.stopPropagation();
      const done = box.getAttribute("aria-checked") !== "true";
      setDone(el, box, done);
      try {
        await api.setDone(r.uid, name, done);
      } catch (err) {
        setDone(el, box, !done);
        toast((err as Error).message);
        return;
      }
      o.onDone?.(r, done);
      if (done) {
        toast(`Marked done: ${r.title}`, { label: "Undo", run: () => void undo(r, name, o) });
        if (o.collapseOnDone) { await wait(900); if (el.isConnected && el.classList.contains("is-done")) await collapseOut(el, 240); }
      }
    });
  }
  return el;
}

function setDone(el: HTMLElement, box: HTMLElement, done: boolean) {
  box.setAttribute("aria-checked", String(done));
  el.classList.toggle("is-done", done);
}

async function undo(r: Row, name: string, o: RowOpts) {
  try { await api.setDone(r.uid, name, false); o.onDone?.(r, false); } catch (e) { toast((e as Error).message); }
}
