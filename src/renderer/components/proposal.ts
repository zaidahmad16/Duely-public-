// Duely asking something: a suggestion from an assistant, not a warning. Accent-tinted, Duely's
// mark, the choices underneath. A choice morphs its button ("Add" → "✓ Added"), then the card
// collapses away after a beat. "Change times" opens the times inline (no modal).
import type { Button, Question } from "../../shared/types.ts";
import { api } from "../ui/api.ts";
import { dateShort, isoDay, range } from "../ui/format.ts";
import { h } from "../ui/h.ts";
import { assistant } from "../ui/icons.ts";
import { collapseOut, enter, expandIn, wait } from "../ui/motion.ts";

const LABEL: Record<Button, string> = { keep: "Keep it", remove: "Remove it", add: "Add", notnow: "Not now", change: "Change times", yes: "Yes", no: "No" };
const DONE: Record<Button, string> = { keep: "Kept", remove: "Removed", add: "Added", notnow: "Skipped", change: "Saved", yes: "Done", no: "OK" };
const PRIMARY: Button[] = ["keep", "add", "yes"];

export type CardOpts = { tz: string; inline?: boolean; onResolved?: (q: Question, b: Button) => void };

export function proposalCard(q: Question, o: CardOpts): HTMLElement {
  const many = q.kind === "vanished" && /items disappeared/.test(q.title);
  const labels = { ...LABEL, ...(many ? { keep: "Keep them", remove: "Remove them" } : {}) };
  const blocks = q.blocks?.length
    ? h("ul", { class: "proposal-blocks" }, [...q.blocks].sort((a, b) => a.s - b.s).map((b) => h("li", null, h("span", null, dateShort(b.s, o.tz)), h("span", { class: "muted" }, range(b.s, b.e, o.tz)))))
    : null;
  const err = h("p", { class: "proposal-error", attrs: { role: "alert" } });
  const row = h("div", { class: "proposal-actions" });
  const card = h("section", { class: ["proposal", o.inline && "proposal-inline"], data: { id: q.id } },
    o.inline ? null : h("div", { class: "proposal-mark" }, assistant(22)),
    h("div", { class: "proposal-body" },
      o.inline ? null : h("h3", { class: "proposal-title" }, q.title),
      q.body && h("p", { class: "proposal-text" }, q.body),
      blocks, row, err));

  const buttons = q.buttons.map((b) => {
    const btn = h("button", { class: ["btn", "btn-sm", PRIMARY.includes(b) ? "btn-primary" : "btn-secondary"], data: { b } },
      h("span", { class: "btn-label" }, labels[b]));
    btn.addEventListener("click", () => (b === "change" ? openTimes() : choose(b, btn)));
    return btn;
  });
  row.append(...buttons);

  async function choose(b: Button, btn: HTMLButtonElement, times?: { day: string; time: string }[]) {
    err.textContent = "";
    for (const x of buttons) x.disabled = true;
    btn.classList.add("is-busy");
    try {
      await api.decide(q.id, b, times);
    } catch (e) {
      err.textContent = (e as Error).message;
      for (const x of buttons) x.disabled = false;
      btn.classList.remove("is-busy");
      return false;
    }
    btn.classList.remove("is-busy");
    morph(btn, PRIMARY.includes(b) || b === "change" ? `✓ ${DONE[b]}` : DONE[b]);
    o.onResolved?.(q, b);
    await wait(550);
    if (!o.inline) await collapseOut(card, 240);
    return true;
  }

  function openTimes() {
    if (card.querySelector(".proposal-times") || !q.blocks) return;
    // shown in time order; saved back in the plan's own order (the engine matches them by index)
    const order = q.blocks.map((_, i) => i).sort((a, b) => q.blocks![a].s - q.blocks![b].s);
    const fields = order.map((i, shown) => {
      const b = q.blocks![i];
      const t = new Intl.DateTimeFormat("en-GB", { timeZone: o.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(b.s);
      return h("div", { class: "time-field" },
        h("label", { class: "meta", attrs: { for: `d-${q.id}-${i}` } }, `Block ${shown + 1}`),
        h("input", { class: "input input-sm", type: "date", id: `d-${q.id}-${i}`, value: isoDay(b.s, o.tz) }),
        h("input", { class: "input input-sm", type: "time", value: t, step: "900" }));
    });
    const save = h("button", { class: "btn btn-primary btn-sm" }, h("span", { class: "btn-label" }, "Save times"));
    const cancel = h("button", { class: "btn btn-ghost btn-sm" }, "Cancel");
    const box = h("div", { class: "proposal-times" }, ...fields, h("div", { class: "proposal-actions" }, save, cancel));
    row.after(box);
    row.hidden = true;
    expandIn(box);
    cancel.addEventListener("click", () => { box.remove(); row.hidden = false; err.textContent = ""; });
    save.addEventListener("click", async () => {
      const times: { day: string; time: string }[] = [];
      fields.forEach((f, k) => { const [d, t] = f.querySelectorAll("input"); times[order[k]] = { day: d.value, time: t.value }; });
      save.disabled = true;
      const ok = await choose("change", save, times);
      if (!ok) save.disabled = false;
    });
  }

  enter(card, { y: 6, dur: 200 });
  return card;
}

/** Button label changes by crossfading (with a touch of blur so it reads as one morph). */
export function morph(btn: HTMLElement, text: string) {
  const label = btn.querySelector(".btn-label") as HTMLElement;
  const a = label.animate([{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(2px)" }], { duration: 90, easing: "ease-in" });
  a.onfinish = () => {
    label.textContent = text;
    btn.classList.add("is-resolved");
    label.animate([{ opacity: 0, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 120, easing: "ease-out" });
  };
}

