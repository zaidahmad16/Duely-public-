// A switch: the thumb slides and the track tints (160 ms, ease-in-out), no bounce.
import { h } from "../ui/h.ts";

export function toggle(on: boolean, onChange: (on: boolean) => void | Promise<void>, o: { label: string; disabled?: boolean }): HTMLButtonElement {
  const el = h("button", { class: "toggle", attrs: { role: "switch", "aria-checked": String(on), "aria-label": o.label, disabled: !!o.disabled } },
    h("span", { class: "toggle-thumb" }));
  el.addEventListener("click", async () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(next));
    try { await onChange(next); } catch { el.setAttribute("aria-checked", String(!next)); }   // put it back if saving failed
  });
  return el;
}
