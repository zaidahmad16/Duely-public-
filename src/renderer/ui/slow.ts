// "Still working" text for actions that can take a while (a slow AI provider, Google starting the
// script's run). Nothing shows for quick actions; after a few seconds a calm line appears under the
// control, and changes if it keeps going. Returns a stop function.
import { h } from "./h.ts";
import { enter } from "./motion.ts";

export function slowHint(after: Element, steps: [ms: number, text: string][]): () => void {
  const line = h("p", { class: "slow-hint", attrs: { role: "status", "aria-live": "polite" } });
  const timers = steps.map(([ms, text]) => setTimeout(() => {
    line.textContent = text;
    if (!line.isConnected) { after.after(line); enter(line, { y: 3, dur: 180 }); }
  }, ms));
  return () => { timers.forEach(clearTimeout); line.remove(); };
}

export const SLOW = {
  test: [[5000, "Still testing. Some providers take a little while to answer…"], [20000, "Almost there. A slow provider can take up to a minute."]] as [number, string][],
  sync: [[4000, "Google is starting Duely's run. This can take a few minutes, and you can keep using Duely."]] as [number, string][],
  install: [[5000, "Still setting up in your Google account…"]] as [number, string][],
  chat: [[8000, "Still thinking…"], [25000, "Still working. Your AI provider is slow right now."]] as [number, string][],
};
