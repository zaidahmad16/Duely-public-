// Shown instead of Upcoming and Chat while the AI isn't set up (or its settings changed and weren't
// tested again). Duely needs a working AI; Settings stays reachable.
import { aiSetup } from "../components/aiSetup.ts";
import { api } from "../ui/api.ts";
import { h } from "../ui/h.ts";
import { assistant } from "../ui/icons.ts";
import type { AppCtx, Screen } from "./types.ts";

export function aiGate(app: AppCtx): Screen {
  const body = h("div");
  const root = h("div", { class: "page page-gate" },
    h("header", { class: "page-head gate-head" }, assistant(28),
      h("h1", { class: "page-title" }, "Finish setting up your AI"),
      h("p", { class: "muted" }, "Duely needs a working AI connection to answer questions and read your courses. Pick a provider, add your key, and test it.")),
    body);
  return {
    el: root,
    mount: () => {
      void api.settings().then((s) => {
        body.replaceChildren(aiSetup(async (ok) => { if (ok) await app.refreshStatus(); }, s).el);
      });
    },
    refresh: () => {},
    status: () => {},
    destroy: () => {},
  };
}
