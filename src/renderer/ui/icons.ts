// One icon set (Lucide, stroke icons), built as inline SVG from Lucide's icon data.
import {
  ArrowUp, CalendarDays, Check, ChevronRight, CircleAlert, Clock, Inbox, Info, KeyRound, Link, LoaderCircle,
  MessageCircle, Plus, RefreshCw, Settings, Sparkles, TriangleAlert, Upload, X, Bell, BookOpen, Calendar,
} from "lucide";

type Node = [string, Record<string, string | number>][];
const ICONS: Record<string, Node> = {
  arrowUp: ArrowUp, calendar: CalendarDays, calendarPlain: Calendar, check: Check, chevron: ChevronRight, alert: CircleAlert,
  clock: Clock, inbox: Inbox, info: Info, key: KeyRound, link: Link, loader: LoaderCircle, chat: MessageCircle, plus: Plus,
  sync: RefreshCw, settings: Settings, sparkles: Sparkles, warn: TriangleAlert, upload: Upload, x: X, bell: Bell, book: BookOpen,
} as unknown as Record<string, Node>;

export type IconName = keyof typeof ICONS;
const NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName, size = 16, cls = ""): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: `icon ${cls}`.trim() })) {
    svg.setAttribute(k, String(v));
  }
  for (const [tag, attrs] of ICONS[name]) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/** Duely's mark: the app icon's check in a rounded square, small (assistant cards, chat). */
export function mark(size = 22): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size)); svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "duely-mark"); svg.setAttribute("aria-hidden", "true");
  const r = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ x: 1, y: 1, width: 22, height: 22, rx: 6.5, fill: "var(--accent)" })) r.setAttribute(k, String(v));
  const p = document.createElementNS(NS, "path");
  for (const [k, v] of Object.entries({ d: "M7 12.4l3.3 3.2L17 8.8", fill: "none", stroke: "var(--on-accent)", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" })) p.setAttribute(k, String(v));
  svg.append(r, p);
  return svg;
}

/** Duely as an assistant (question cards, chat): a sparkle on a soft accent disc. The check logo
 *  is kept for the brand, so it's never mistaken for a ticked box. */
export function assistant(size = 22): HTMLElement {
  const el = document.createElement("span");
  el.className = "assistant";
  el.style.width = el.style.height = `${size}px`;
  el.append(icon("sparkles", Math.round(size * 0.62)));
  return el;
}
