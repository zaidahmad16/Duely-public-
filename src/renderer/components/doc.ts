// Duely's Terms of Service and Privacy Policy, bundled with the app (the version you agreed to,
// readable offline), shown in a sheet over the current screen.
import privacy from "../../../docs/PRIVACY.md?raw";
import terms from "../../../docs/TERMS.md?raw";
import { api } from "../ui/api.ts";
import { h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { markdown } from "../ui/markdown.ts";
import { enter, leave } from "../ui/motion.ts";

/** Changes when TERMS.md changes; stored when the student agrees. */
export const TERMS_VERSION = "2026-10-09";

const DOCS = { terms: { title: "Terms of Service", md: terms }, privacy: { title: "Privacy Policy", md: privacy } };
const REPO = "https://github.com/zaidahmad16/Duely-public-/blob/main/docs/";

export function openDoc(which: keyof typeof DOCS): void {
  const d = DOCS[which];
  const open = (url: string) => {
    // links between the two documents open here; everything else in the browser
    if (/^(PRIVACY|TERMS)\.md$/.test(url)) { void close().then(() => openDoc(url.startsWith("PRIVACY") ? "privacy" : "terms")); return; }
    void api.openLink(/^https?:/.test(url) ? url : REPO + url);
  };
  const body = h("div", { class: "doc-body" }, markdown(d.md.replace(/^# .*\n/, ""), open));
  const closeBtn = h("button", { class: "icon-btn", attrs: { "aria-label": "Close" } }, icon("x", 16));
  const sheet = h("div", { class: "sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": d.title } },
    h("header", { class: "sheet-head" }, h("h2", { class: "section-title" }, d.title), closeBtn), body);
  const backdrop = h("div", { class: "sheet-backdrop" }, sheet);
  const close = async () => {
    document.removeEventListener("keydown", onKey);
    await Promise.all([leave(sheet, { y: 6, dur: 140 }), leave(backdrop, { dur: 140 })]);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") void close(); };
  closeBtn.addEventListener("click", () => void close());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) void close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  enter(backdrop, { y: 0, dur: 160 });
  enter(sheet, { y: 8, dur: 220 });
  closeBtn.focus();
}

/** "By continuing, you agree to the Terms of Service and Privacy Policy." */
export function legalLine(prefix = "By continuing, you agree to Duely's"): HTMLElement {
  const link = (label: string, which: keyof typeof DOCS) =>
    h("a", { href: "#", on: { click: (e) => { e.preventDefault(); openDoc(which); } } }, label);
  return h("p", { class: "legal" }, `${prefix} `, link("Terms of Service", "terms"), " and ", link("Privacy Policy", "privacy"), ".");
}
