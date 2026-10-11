// A tiny element builder. Text is always added as text nodes, never parsed as HTML.
type Child = Node | string | number | false | null | undefined | Child[];
type Props = {
  class?: string | (string | false | null | undefined)[];
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  data?: Record<string, string>;
  attrs?: Record<string, string | boolean | number | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
  [prop: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === "class") el.className = (Array.isArray(v) ? v.filter(Boolean) : [v]).join(" ");
      else if (k === "style") {
        for (const [sk, sv] of Object.entries(v as object)) {
          if (sk.startsWith("--")) el.style.setProperty(sk, String(sv)); else (el.style as any)[sk] = sv;
        }
      }
      else if (k === "data") for (const [dk, dv] of Object.entries(v as object)) el.dataset[dk] = String(dv);
      else if (k === "attrs") {
        for (const [ak, av] of Object.entries(v as object)) {
          if (av === false || av === undefined) continue;
          el.setAttribute(ak, av === true ? "" : String(av));
        }
      } else if (k === "on") for (const [ev, fn] of Object.entries(v as object)) el.addEventListener(ev, fn as EventListener);
      else (el as any)[k] = v;
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }
