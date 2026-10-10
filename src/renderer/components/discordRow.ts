// Discord alerts (P6): connect (Discord's sign-in in the browser, through Duely's relay), send a test,
// disconnect (asks first). Used in Settings → Notifications and onboarding's last step.
import type { Settings } from "../../shared/types.ts";
import { api } from "../ui/api.ts";
import { clear, h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { expandIn } from "../ui/motion.ts";
import { toast } from "./toast.ts";

const btn = (label: string, cls: string) => h("button", { class: cls }, h("i", { class: "spinner" }), h("span", { class: "btn-label" }, label));
function busy(b: HTMLButtonElement, on: boolean, label: string) {
  b.classList.toggle("is-busy", on); b.disabled = on;
  (b.querySelector(".btn-label") as HTMLElement).textContent = label;
}

/** The control part: Connect, or "Connected as …" with Send test alert / Disconnect. `changed` gets new settings. */
export function discordControl(discord: Settings["discord"], changed: (s: Settings) => void, o: { compact?: boolean } = {}): HTMLElement {
  const root = h("div", { class: "discord-control" });
  const paint = (d: Settings["discord"], err = "") => {
    clear(root);
    const problem = err || d?.error || "";
    if (!d) {
      const go = btn("Connect Discord", o.compact ? "btn btn-secondary" : "btn btn-secondary btn-sm");
      go.addEventListener("click", async () => {
        busy(go, true, "Waiting for Discord…");
        try { const s = await api.discordConnect(); changed(s); paint(s.discord); toast("Discord connected"); }
        catch (e) { paint(null, (e as Error).message); }
      });
      root.append(h("div", { class: "row-btns" }, go));
    } else {
      const test = btn("Send test alert", "btn btn-ghost btn-sm"), off = btn("Disconnect", "btn btn-ghost btn-sm");
      test.addEventListener("click", async () => {
        busy(test, true, "Sending…");
        try { await api.discordTest(); toast("Sent. Check Discord"); paint(d); } catch (e) { paint(d, (e as Error).message); }
      });
      off.addEventListener("click", () => {
        if (root.querySelector(".confirm-line")) return;
        const yes = h("button", { class: "btn btn-danger btn-sm" }, "Disconnect"), no = h("button", { class: "btn btn-ghost btn-sm" }, "Keep");
        const line = h("div", { class: "confirm-line" }, h("span", null, "Stop Discord alerts? You'll leave the Duely server."), yes, no);
        root.append(line); expandIn(line);
        no.addEventListener("click", () => line.remove());
        yes.addEventListener("click", async () => {
          yes.disabled = true;
          try { const s = await api.discordDisconnect(); changed(s); paint(s.discord); toast("Discord disconnected"); } catch (e) { paint(d, (e as Error).message); }
        });
      });
      root.append(h("div", { class: "inline-state" }, h("span", { class: "state-ok" }, icon("check", 14), `Connected as ${d.name || "you"}`), test, off));
    }
    if (problem) root.append(h("p", { class: "field-error discord-error" }, problem));
  };
  paint(discord);
  return root;
}
