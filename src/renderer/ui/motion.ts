// Motion helpers (Web Animations API: off the main thread, interruptible). Entering: ease-out.
// Leaving: ease-in, short. State changes: ease-in-out. Reduced motion keeps fades, drops movement.
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN = "cubic-bezier(0.55, 0, 0.9, 0.4)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

/** Fade in from `y` px below (negative: above), or from `x` px to the side. */
export function enter(el: Element, o: { y?: number; x?: number; dur?: number; delay?: number } = {}): Animation {
  const dx = reduced() ? 0 : o.x ?? 0, dy = reduced() ? 0 : o.y ?? 6;
  return el.animate(
    [{ opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { opacity: 1, transform: "translate(0, 0)" }],
    { duration: o.dur ?? 200, delay: o.delay ?? 0, easing: EASE_OUT, fill: "backwards" },
  );
}

/** Fade out toward `x`/`y` (short, ease-in). Resolves when done. */
export function leave(el: Element, o: { y?: number; x?: number; dur?: number } = {}): Promise<void> {
  const dx = reduced() ? 0 : o.x ?? 0, dy = reduced() ? 0 : o.y ?? 0;
  const a = el.animate([{ opacity: 1, transform: "translate(0, 0)" }, { opacity: 0, transform: `translate(${dx}px, ${dy}px)` }],
    { duration: o.dur ?? 140, easing: EASE_IN, fill: "forwards" });
  return a.finished.then(() => undefined, () => undefined);
}

/** Collapse an element's height to nothing and remove it (rows, resolved cards, banners). */
export async function collapseOut(el: HTMLElement, dur = 220): Promise<void> {
  const h = el.getBoundingClientRect().height;
  const cs = getComputedStyle(el);
  el.style.overflow = "hidden";
  const a = el.animate([
    { height: `${h}px`, opacity: 1, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
    { height: "0px", opacity: 0, marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" },
  ], { duration: dur, easing: EASE_IN_OUT, fill: "forwards" });
  await a.finished.catch(() => undefined);
  el.remove();
}

/** Grow a freshly inserted element from zero height (banners, inline editors). */
export function expandIn(el: HTMLElement, dur = 200): void {
  const h = el.getBoundingClientRect().height;
  el.animate([{ height: "0px", opacity: 0, overflow: "hidden" }, { height: `${h}px`, opacity: 1, overflow: "hidden" }],
    { duration: dur, easing: EASE_OUT });
}

/** Staggered entrance for freshly generated content only. */
export function stagger(els: Iterable<Element>, step = 40, o: { y?: number; dur?: number; start?: number } = {}): void {
  let i = 0;
  for (const el of els) enter(el, { y: o.y ?? 4, dur: o.dur ?? 180, delay: (o.start ?? 0) + step * i++ });
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export { EASE_IN_OUT, EASE_OUT };
