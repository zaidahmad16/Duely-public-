// Thin full-width notices: icon · title · one line · action. Amber = recoverable, red = serious.
import { h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { collapseOut, enter } from "../ui/motion.ts";

export type BannerSpec = { id: string; tone: "warn" | "danger" | "info"; title: string; text: string; action?: { label: string; run: () => void } };

/** Shows exactly these banners: new ones slide in, gone ones collapse, unchanged ones stay put. */
export function setBanners(host: HTMLElement, specs: BannerSpec[]): void {
  const want = new Map(specs.map((s) => [s.id, s]));
  for (const el of [...host.children] as HTMLElement[]) {
    const s = want.get(el.dataset.id!);
    if (!s) void collapseOut(el, 200);
    else if (el.dataset.sig !== sig(s)) el.replaceWith(banner(s));
    want.delete(el.dataset.id!);
  }
  for (const s of want.values()) {
    const el = banner(s);
    host.append(el);
    enter(el, { y: -6, dur: 180 });
  }
}

const sig = (s: BannerSpec) => `${s.tone}|${s.title}|${s.text}|${s.action?.label ?? ""}`;

function banner(s: BannerSpec): HTMLElement {
  return h("div", { class: ["banner", `banner-${s.tone}`], data: { id: s.id, sig: sig(s) }, attrs: { role: s.tone === "info" ? "status" : "alert" } },
    icon(s.tone === "info" ? "info" : "warn", 15, "banner-icon"),
    h("div", { class: "banner-text" }, h("strong", null, s.title), h("span", null, s.text)),
    s.action && h("button", { class: "btn btn-secondary btn-sm", on: { click: s.action.run } }, s.action.label));
}
