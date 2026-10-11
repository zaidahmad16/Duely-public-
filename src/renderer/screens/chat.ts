// Chat: talking to an assistant, not a chat clone. Duely's answers sit on the page (no bubble),
// the student's messages get a soft container, listed items are real rows, a proposal gets its
// buttons right under the message. The chat is saved on this computer (the last 200 messages, 30 days)
// and comes back after a restart with today's ticks and where each question stands; old messages never
// re-animate. "Clear chat" forgets it.
import type { ChatMessage, ChatReply, Question } from "../../shared/types.ts";
import { outcome, proposalCard, settle } from "../components/proposal.ts";
import { taskRow } from "../components/taskRow.ts";
import { toast } from "../components/toast.ts";
import { api } from "../ui/api.ts";
import { dayLong, isoDay, rich } from "../ui/format.ts";
import { clear, h } from "../ui/h.ts";
import { assistant, icon, mark } from "../ui/icons.ts";
import { enter, expandIn, stagger } from "../ui/motion.ts";
import { SLOW, slowHint } from "../ui/slow.ts";
import type { AppCtx, Screen } from "./types.ts";

const SUGGESTIONS = ["What's due tomorrow?", "What do I have this week?", "When is my next test?"];

type Shown = Pick<ChatMessage, "text" | "rows" | "questions" | "resolved">;

export function chatScreen(_app: AppCtx): Screen {
  const thread = h("div", { class: "thread", attrs: { "aria-live": "polite" } });
  const input = h("textarea", { class: "composer-input", rows: 1, placeholder: "Ask Duely what's coming up…", attrs: { "aria-label": "Message Duely" } });
  const send = h("button", { class: "composer-send", attrs: { "aria-label": "Send" }, disabled: true }, icon("arrowUp", 16));
  const composer = h("form", { class: "composer" }, input, send);
  const clearBtn = h("button", { class: "btn btn-ghost btn-sm chat-clear", hidden: true }, "Clear chat");
  const bar = h("div", { class: "chat-bar" }, clearBtn);
  const scroller = h("div", { class: "chat-scroll" }, bar, thread);
  const root = h("div", { class: "page page-chat" }, scroller, h("div", { class: "composer-wrap" }, composer));
  let tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let busy = false, loaded = false, lastDay = "";
  /** question cards on screen, by id: answered elsewhere, they settle in place */
  const cards = new Map<string, HTMLElement>();

  function intro() {
    const pick = (q: string) => () => { input.value = q; void submit(); };
    return h("div", { class: "chat-intro" }, mark(28),
      h("h1", { class: "chat-intro-title" }, "Ask Duely"),
      h("p", { class: "muted" }, "About deadlines, tests, classes, or what your profs posted."),
      h("div", { class: "chat-suggest" }, SUGGESTIONS.map((q) => h("button", { class: "suggest", on: { click: pick(q) } }, q))));
  }

  const toBottom = (smooth = true) => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });

  /** A day separator when a message starts a new day ("Today", "Yesterday", "Mon Oct 5"). */
  function dayMark(at: number): HTMLElement | null {
    const day = isoDay(at, tz);
    if (day === lastDay) return null;
    lastDay = day;
    return h("div", { class: "chat-day", attrs: { role: "separator" } }, h("span", null, dayLong(day, tz, Date.now())));
  }

  function mine(text: string, at: number, animate: boolean): HTMLElement[] {
    const sep = dayMark(at);
    const el = h("div", { class: "msg msg-me" }, text);
    if (animate) enter(el, { y: 6, dur: 180 });
    return sep ? [sep, el] : [el];
  }

  function duely(r: Shown, at: number, animate: boolean): HTMLElement[] {
    const sep = dayMark(at);
    const byDay = new Map<string, typeof r.rows>();
    for (const row of r.rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
    const now = Date.now();
    const qcards = r.questions.map((q) => card(q, !animate));
    const el = h("div", { class: "msg msg-duely" },
      h("span", { class: "msg-mark" }, assistant(20)),
      h("div", { class: "msg-body" },
        r.text && h("div", { class: "rich" }, rich(r.text, (u) => void api.openLink(u))),
        r.rows.length ? h("div", { class: "msg-rows" }, [...byDay].map(([day, rows]) =>
          h("div", { class: "msg-day" }, h("h3", { class: "msg-day-head" }, dayLong(day, tz, now)),
            h("ul", { class: "rows" }, rows.map((row) => taskRow(row, { tz, now, timeOnly: true })))))) : null,
        ...qcards,
        ...r.resolved.map((x) => outcome(x.word))));
    if (animate) { enter(el, { y: 6, dur: 200 }); stagger(el.querySelectorAll(".row"), 40, { y: 4, dur: 180, start: 60 }); }
    return sep ? [sep, el] : [el];
  }

  function card(q: Question, quiet: boolean): HTMLElement {
    const c = proposalCard(q, { tz, inline: true, quiet, onResolved: () => cards.delete(q.id) });
    cards.set(q.id, c);
    return c;
  }

  /** Answers that came from somewhere else settle their cards. */
  function settleAll(list: { id: string; word: string }[] | undefined) {
    for (const x of list ?? []) { const c = cards.get(x.id); if (c) { settle(c, x.word); cards.delete(x.id); } }
  }

  async function load() {
    let log: ChatMessage[] = [];
    try { log = await api.chatHistory(); } catch { /* start empty */ }
    clear(thread); cards.clear(); lastDay = "";
    if (!log.length) { thread.append(intro()); clearBtn.hidden = true; return; }
    for (const m of log) thread.append(...(m.who === "me" ? mine(m.text, m.at, false) : duely(m, m.at, false)));
    clearBtn.hidden = false;
    requestAnimationFrame(() => toBottom(false));
  }

  /** Where each question on screen stands now (after a sync, or an answer in Upcoming). */
  async function recheck() {
    if (!cards.size) return;
    try {
      const log = await api.chatHistory();
      settleAll(log.flatMap((m) => m.resolved).filter((x) => cards.has(x.id)));
    } catch { /* next time */ }
  }

  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    send.disabled = busy || !input.value.trim();
  }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } });
  composer.addEventListener("submit", (e) => { e.preventDefault(); void submit(); });

  clearBtn.addEventListener("click", () => {
    if (bar.querySelector(".confirm-line")) return;
    const yes = h("button", { class: "btn btn-danger btn-sm" }, "Clear"), no = h("button", { class: "btn btn-ghost btn-sm" }, "Keep");
    const line = h("div", { class: "confirm-line" }, h("span", null, "Clear the whole chat? Duely also forgets what you were talking about."), yes, no);
    bar.append(line); expandIn(line);
    no.addEventListener("click", () => line.remove());
    yes.addEventListener("click", async () => {
      try { await api.chatClear(); line.remove(); await load(); toast("Chat cleared"); } catch (e) { toast((e as Error).message); }
    });
  });

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = ""; grow();
    thread.querySelector(".chat-intro")?.remove();
    clearBtn.hidden = false;
    thread.append(...mine(text, Date.now(), true));
    const thinking = h("div", { class: "msg msg-duely thinking", attrs: { "aria-label": "Duely is thinking" } },
      h("span", { class: "msg-mark" }, assistant(20)), h("span", { class: "dots" }, h("i"), h("i"), h("i")));
    thread.append(thinking);
    enter(thinking, { y: 4, dur: 160, delay: 80 });
    toBottom();
    let reply: ChatReply;
    const stopHint = slowHint(thinking.querySelector(".dots")!, SLOW.chat);
    try {
      reply = await api.chat(text);
    } catch (e) {
      reply = { text: `I couldn't answer that just now. ${(e as Error).message}`, rows: [] };
    }
    stopHint();
    thinking.remove();
    settleAll(reply.resolved);                                         // "yes" answers the card above
    const qs = [...(reply.question ? [reply.question] : []), ...(reply.questions ?? [])];
    thread.append(...duely({ text: reply.text, rows: reply.rows, questions: qs, resolved: [] }, Date.now(), true));
    busy = false; grow();
    toBottom();
    input.focus();
  }

  return {
    el: root,
    mount: () => {
      void api.upcoming().then((u) => { tz = u.tz; }).catch(() => {}).finally(() => { if (!loaded) { loaded = true; void load(); } else void recheck(); });
      setTimeout(() => input.focus(), 50);
    },
    refresh: () => { if (loaded) void recheck(); },
    status: () => {},
    destroy: () => {},
  };
}
