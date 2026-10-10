// Putting Duely's engine in the student's own Google account (P3.5), in three short steps: turn on the
// Apps Script API, install, approve once. Used in onboarding (after Connect Google) and in Settings.
import { api } from "../ui/api.ts";
import { h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { enter } from "../ui/motion.ts";
import { SLOW, slowHint } from "../ui/slow.ts";

const SETTINGS = "https://script.google.com/home/usersettings";

export function cloudSetup(onDone: () => void): HTMLElement {
  let account = "";   // the signed-in Google account: links must open in it, not the browser's default one
  const inAccount = (url: string) => (account ? `${url}?authuser=${encodeURIComponent(account)}` : url);
  const steps = h("ol", { class: "cloud-steps" });
  const err = h("p", { class: "field-error", attrs: { role: "alert" } });
  const root = h("div", { class: "cloud-setup" },
    h("p", { class: "help" }, "So your calendar stays up to date even when this computer is off, Duely runs in your own Google account. It's free, and nothing goes to us."),
    steps, err);

  const step = (n: number, title: string, body: Node | null, state: "todo" | "now" | "done") =>
    h("li", { class: ["cloud-step", `is-${state}`] },
      h("span", { class: "cloud-step-n" }, state === "done" ? icon("check", 13) : String(n)),
      h("div", { class: "cloud-step-body" }, h("div", { class: "cloud-step-title" }, title), body));

  const busy = (b: HTMLButtonElement, label: string) => { b.disabled = true; b.classList.add("is-busy"); (b.querySelector(".btn-label") as HTMLElement).textContent = label; };
  const btn = (label: string, cls = "btn btn-primary btn-sm") => h("button", { class: cls }, h("i", { class: "spinner" }), h("span", { class: "btn-label" }, label));

  async function paint(at: "api" | "install" | "approve" | "done") {
    err.textContent = "";
    const order = ["api", "install", "approve", "done"];
    const st = (k: string) => (order.indexOf(k) < order.indexOf(at) ? "done" : k === at ? "now" : "todo");
    // 1. the Apps Script API setting
    let b1: Node | null = null;
    if (at === "api") {
      const open = btn("Open Apps Script settings", "btn btn-secondary btn-sm");
      const check = btn("I turned it on");
      open.addEventListener("click", () => void api.openLink(inAccount(SETTINGS)));
      check.addEventListener("click", async () => {
        busy(check, "Checking…");
        try { (await api.cloudCheck()).apiEnabled ? void paint("install") : void paint("api").then(() => { err.textContent = "It's still off. Switch on \"Google Apps Script API\", then try again."; }); }
        catch (e) { err.textContent = (e as Error).message; void paint("api"); }
      });
      b1 = h("div", null, h("p", { class: "help" }, "In Apps Script settings, switch on \"Google Apps Script API\". This lets Duely set itself up in your account."), h("div", { class: "row-btns" }, open, check));
    }
    // 2. install
    let b2: Node | null = null;
    if (at === "install") {
      const go = btn("Install Duely in my Google account");
      go.addEventListener("click", async () => {
        busy(go, "Installing…");
        const stopHint = slowHint(go, SLOW.install);
        try { await api.cloudInstall(); stopHint(); void paint("approve"); } catch (e) { stopHint(); err.textContent = (e as Error).message; void paint("install"); }
      });
      b2 = h("div", null, h("p", { class: "help" }, "Duely adds a small script to your Google account. Only you can see it."), go);
    }
    // 3. approve once (the editor opened in the browser)
    let b3: Node | null = null;
    if (at === "approve") {
      const status = h("p", { class: "help waiting" }, h("i", { class: "spinner is-on" }), " Waiting for you to approve it…");
      const reopen = h("button", { class: "btn btn-ghost btn-sm" }, "Open it again");
      reopen.addEventListener("click", async () => { const s = await api.status(); if (s.cloud?.editor) void api.openLink(s.cloud.editor); });
      b3 = h("div", null,
        h("p", { class: "help" }, "In the browser tab that opened, click ", h("strong", null, "Run"), ", then allow Duely. Google says it isn't verified: that's expected for your own copy (choose Advanced, then continue)."),
        status, reopen);
      void api.cloudWait().then(() => void paint("done"), (e) => { err.textContent = (e as Error).message; });
    }
    steps.replaceChildren(
      step(1, "Turn on the Apps Script API", b1, st("api") as any),
      step(2, "Install Duely in your Google account", b2, st("install") as any),
      step(3, "Approve it once", b3, st("approve") as any));
    if (at === "done") {
      const ok = h("p", { class: "connected" }, h("span", { class: "connected-icon" }, icon("check", 14)), "Duely is running in your Google account");
      steps.after(ok);
      enter(ok, { y: 4, dur: 180 });
      onDone();
    }
  }

  void api.cloudCheck().then((c) => { account = c.account; return paint(c.installed ? (c.approved ? "done" : "approve") : c.apiEnabled ? "install" : "api"); }, (e) => { err.textContent = (e as Error).message; void paint("api"); });
  return root;
}
