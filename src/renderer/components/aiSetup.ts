// Choosing and testing the AI: provider cards, key (and base URL for OpenAI-compatible), then Test
// connection, which picks a model that works with the key. Choosing the model yourself is under Advanced. Duely needs a working AI, so `onReady` only becomes possible after a test passes;
// changing anything afterwards needs a new test.
import type { Provider, Settings } from "../../shared/types.ts";
import { PROVIDERS, capList, spinnerButton } from "../screens/settings.ts";
import { api } from "../ui/api.ts";
import { clear, h } from "../ui/h.ts";
import { icon } from "../ui/icons.ts";
import { enter } from "../ui/motion.ts";
import { SLOW, slowHint } from "../ui/slow.ts";

export type AiSetup = { el: HTMLElement; /** true once a test passed for what's entered */ ready(): boolean };

/** `verified`: the saved settings already passed a test (nothing to redo unless they're changed). */
export function aiSetup(onChange: (ready: boolean) => void, saved?: Settings, verified = false): AiSetup {
  let provider: Provider | "" = saved?.ai.provider ?? "";
  let passed = verified;
  const opts = h("div", { class: "provider-grid", attrs: { role: "radiogroup", "aria-label": "AI provider" } });
  const key = h("input", { class: "input", type: "password", placeholder: saved?.ai.keySet ? "•••••••••••• saved" : "Paste your API key", attrs: { "aria-label": "API key", autocomplete: "off" } });
  const custom = !!saved && !saved.ai.auto && !!saved.ai.model;
  const model = h("input", { class: "input", placeholder: "Automatic", value: custom ? saved!.ai.model : "", attrs: { "aria-label": "Model", list: "ai-models" } });
  const modelList = h("datalist", { attrs: { id: "ai-models" } });
  const base = h("input", { class: "input", placeholder: "https://api.openai.com/v1", value: saved?.ai.baseUrl ?? "", attrs: { "aria-label": "Base URL" } });
  const baseWrap = h("div", { class: "field", hidden: provider !== "openai" }, h("label", { class: "field-label" }, "Base URL ", h("span", { class: "faint" }, "(only if not OpenAI)")), base);
  const details = h("div", { class: "ai-details", hidden: !provider },
    h("div", { class: "field" }, h("label", { class: "field-label" }, "API key"), key,
      h("p", { class: "help" }, "Your provider bills you for use, and you're responsible for this key and its charges. Set a spending limit with your provider.")),
    baseWrap, advanced());
  const results = h("div", { class: "test-results" });
  const err = h("p", { class: "field-error", attrs: { role: "alert" } });
  const test = h("button", { class: "btn btn-secondary", disabled: !provider }, icon("sparkles", 14, "btn-icon"), h("i", { class: "spinner" }), h("span", { class: "btn-label" }, "Test connection"));
  const hint = h("p", { class: "help", hidden: verified }, "Test the connection to continue. Duely needs a working AI.");

  // Advanced: the student's own model (empty = Duely picks), with the models their key can use
  function advanced(): HTMLElement {
    const more = h("div", { class: ["collapse", !custom && "is-closed"] }, h("div", { class: "collapse-inner" },
      h("div", { class: "field" }, h("label", { class: "field-label" }, "Model"), model, modelList,
        h("p", { class: "help" }, "Leave it empty and Duely picks one that works with your key."))));
    const toggle = h("button", { class: ["more-toggle", custom && "is-open"], type: "button", attrs: { "aria-expanded": String(custom) } }, icon("chevron", 13, "chev"), "Advanced");
    toggle.addEventListener("click", async () => {
      const open = more.classList.toggle("is-closed") === false;
      toggle.classList.toggle("is-open", open); toggle.setAttribute("aria-expanded", String(open));
      if (open && provider) void fillModels();
    });
    return h("div", { class: "ai-advanced" }, toggle, more);
  }
  async function fillModels() {
    try {
      // the list comes from the provider with the key: save what's typed first
      await api.saveSettings({ ai: { provider: provider as Provider, ...(provider === "openai" ? { baseUrl: base.value } : {}) }, ...(key.value.trim() ? { aiKey: key.value } : {}) });
      const names = await api.aiModels();
      clear(modelList); modelList.append(...names.map((n) => h("option", { value: n })));
    } catch { /* the list is only a convenience */ }
  }

  const set = (v: boolean) => { if (v !== passed) { passed = v; onChange(v); } hint.hidden = v; };
  // anything edited after a pass needs a new test
  for (const inp of [key, model, base]) inp.addEventListener("input", () => { if (passed) { set(false); clear(results); } });

  for (const p of PROVIDERS) {
    const b = h("button", { class: ["provider", provider === p.id && "is-active"], attrs: { role: "radio", "aria-checked": String(provider === p.id) } },
      h("span", { class: "provider-name" }, p.name), h("span", { class: "provider-hint" }, p.hint));
    b.addEventListener("click", () => {
      if (provider === p.id) return;
      provider = p.id;
      for (const x of opts.children) { x.classList.toggle("is-active", x === b); x.setAttribute("aria-checked", String(x === b)); }
      model.value = ""; clear(modelList);                              // names don't carry over; Duely picks again
      baseWrap.hidden = p.id !== "openai";
      if (details.hidden) { details.hidden = false; enter(details, { y: 6, dur: 200 }); }
      test.disabled = false;
      set(false); clear(results);
    });
    opts.append(b);
  }

  test.addEventListener("click", async () => {
    err.textContent = ""; clear(results);
    spinnerButton(test, true, "Testing…");
    const stopHint = slowHint(test.parentElement!, SLOW.test);
    try {
      await api.saveSettings({ ai: { provider: provider as Provider, model: model.value, baseUrl: provider === "openai" ? base.value : "" },
        ...(key.value.trim() ? { aiKey: key.value } : {}) });
      const r = await api.testAI();
      results.append(capList(r));
      set(r.ok);
    } catch (x) {
      err.textContent = (x as Error).message;
      set(false);
    }
    stopHint();
    spinnerButton(test, false, "Test connection");
  });

  return {
    el: h("div", { class: "ai-setup" }, opts, details, h("div", { class: "test-line" }, test), results, err, hint),
    ready: () => passed,
  };
}
