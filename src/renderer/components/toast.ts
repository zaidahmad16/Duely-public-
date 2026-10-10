// Small confirmations, bottom-right: fade + 6px up, ~2.5 s, then fade out. One at a time.
import { h } from "../ui/h.ts";
import { enter, leave } from "../ui/motion.ts";
import { icon } from "../ui/icons.ts";

let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function toast(text: string, action?: { label: string; run: () => void }, ms = 2600): void {
  const host = document.getElementById("toasts")!;
  if (current) { const old = current; void leave(old, { y: 4, dur: 120 }).then(() => old.remove()); }
  if (timer) clearTimeout(timer);
  const el = h("div", { class: "toast", attrs: { role: "status" } },
    icon("check", 15, "toast-icon"), h("span", null, text),
    action && h("button", { class: "toast-action", on: { click: () => { action.run(); dismiss(el); } } }, action.label));
  host.append(el);
  current = el;
  enter(el, { y: 6, dur: 180 });
  const arm = () => { timer = setTimeout(() => dismiss(el), ms); };
  el.addEventListener("mouseenter", () => { if (timer) clearTimeout(timer); });   // hovering keeps it
  el.addEventListener("mouseleave", arm);
  arm();
}

function dismiss(el: HTMLElement) {
  if (current === el) current = null;
  void leave(el, { y: 4, dur: 140 }).then(() => el.remove());
}
