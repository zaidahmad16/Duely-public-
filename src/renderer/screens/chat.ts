// Chat: talking to an assistant, not a chat clone. Duely's answers sit on the page (no bubble),
// the student's messages get a soft container, listed items are real rows, a proposal gets its
// buttons right under the message. History lives for this session; old messages never re-animate.
import type { ChatReply } from "../../shared/types.ts";
import { proposalCard } from "../components/proposal.ts";
import { taskRow } from "../components/taskRow.ts";
import { api } from "../ui/api.ts";
import { dayLong, rich } from "../ui/format.ts";
import { h } from "../ui/h.ts";
import { assistant, icon, mark } from "../ui/icons.ts";
import { enter, stagger } from "../ui/motion.ts";
import type { AppCtx, Screen } from "./types.ts";

const SUGGESTIONS = ["What's due tomorrow?", "What do I have this week?", "When is my next test?"];

export function chatScreen(_app: AppCtx): Screen {
  const thread = h("div", { class: "thread", attrs: { "aria-live": "polite" } });
  const input = h("textarea", { class: "composer-input", rows: 1, placeholder: "Ask Duely what's coming up…", attrs: { "aria-label": "Message Duely" } });
  const send = h("button", { class: "composer-send", attrs: { "aria-label": "Send" }, disabled: true }, icon("arrowUp", 16));
  const composer = h("form", { class: "composer" }, input, send);
  const scroller = h("div", { class: "chat-scroll" }, thread);
  const root = h("div", { class: "page page-chat" }, scroller, h("div", { class: "composer-wrap" }, composer));
  let tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let busy = false;

  function intro() {
    const pick = (q: string) => () => { input.value = q; void submit(); };
    return h("div", { class: "chat-intro" }, mark(28),
      h("h1", { class: "chat-intro-title" }, "Ask Duely"),
      h("p", { class: "muted" }, "About deadlines, tests, classes, or what your profs posted."),
      h("div", { class: "chat-suggest" }, SUGGESTIONS.map((q) => h("button", { class: "suggest", on: { click: pick(q) } }, q))));
  }
  thread.append(intro());

  const toBottom = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });

  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    send.disabled = busy || !input.value.trim();
  }
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } });
  composer.addEventListener("submit", (e) => { e.preventDefault(); void submit(); });

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = ""; grow();
    thread.querySelector(".chat-intro")?.remove();
    const mine = h("div", { class: "msg msg-me" }, text);
    thread.append(mine);
    enter(mine, { y: 6, dur: 180 });
    const thinking = h("div", { class: "msg msg-duely thinking", attrs: { "aria-label": "Duely is thinking" } },
      h("span", { class: "msg-mark" }, assistant(20)), h("span", { class: "dots" }, h("i"), h("i"), h("i")));
    thread.append(thinking);
    enter(thinking, { y: 4, dur: 160, delay: 80 });
    toBottom();
    let reply: ChatReply;
    try {
      reply = await api.chat(text);
    } catch (e) {
      reply = { text: `I couldn't answer that just now. ${(e as Error).message}`, rows: [] };
    }
    thinking.remove();
    const msg = answer(reply);
    thread.append(msg);
    enter(msg, { y: 6, dur: 200 });
    stagger(msg.querySelectorAll(".row"), 40, { y: 4, dur: 180, start: 60 });
    busy = false; grow();
    toBottom();
    input.focus();
  }

  function answer(r: ChatReply): HTMLElement {
    const byDay = new Map<string, typeof r.rows>();
    for (const row of r.rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
    const now = Date.now();
    return h("div", { class: "msg msg-duely" },
      h("span", { class: "msg-mark" }, assistant(20)),
      h("div", { class: "msg-body" },
        r.text && h("div", { class: "rich" }, rich(r.text, (u) => void api.openLink(u))),
        r.rows.length ? h("div", { class: "msg-rows" }, [...byDay].map(([day, rows]) =>
          h("div", { class: "msg-day" }, h("h3", { class: "msg-day-head" }, dayLong(day, tz, now)),
            h("ul", { class: "rows" }, rows.map((row) => taskRow(row, { tz, now, timeOnly: true })))))) : null,
        r.question && proposalCard(r.question, { tz, inline: true })));
  }

  return {
    el: root,
    mount: () => { void api.upcoming().then((u) => { tz = u.tz; }).catch(() => {}); setTimeout(() => input.focus(), 50); },
    refresh: () => {},
    status: () => {},
    destroy: () => {},
  };
}
