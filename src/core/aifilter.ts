// AI junk filter: which feed items are real (deliverables, assessments, class events), with clean
// titles. Verdicts are cached per item fingerprint, so an unchanged item is only asked about once;
// any failure leaves the rule-based verdicts in place (port of core/aifilter.py).
import { type Item, head } from "./classify.ts";
import { type AICtx, aiReady, llmJSON } from "./llm.ts";
import { plain, sha1hex } from "./util.ts";

const BATCH = 30;

const PROMPT = `You clean up a university student's Brightspace (D2L) calendar feed before it is
copied into Google Calendar. For each item decide:

keep: true for things the student must act on or attend: assignments, labs, projects,
  reports, quizzes, tests, midterms, exams, presentations, and real scheduled class
  events (e.g. "Midterm review session", "No class - reading week" is useful too).
  false for noise: content/module/unit availability, checklists, "availability starts"
  notices without a deadline, course start/end dates, duplicates of another item,
  placeholders, and anything with no action or attendance for the student.
  A deadline whose description asks the student to complete, submit, take or finish
  something is ALWAYS keep, even if it's called a "module" (e.g. "To complete the
  Green Energy module you must take the quiz…" is a real deadline). When unsure, keep.
type: one of assignment, quiz, exam, event.
title: short clean title WITHOUT the course code and without words like "Due",
  "Availability Ends" (e.g. "Assignment 3", "Quiz 2: Pointers", "Midterm").
reason: a few words, only when keep is false.

Each item has: id, raw (original title), course, role (deadline = has a due/close time,
opens = only an opening date, event = plain calendar event), guess (rule-based type),
repeats (a recurring lecture/tutorial/office hours: keep these),
desc (description excerpt).

Return {"verdicts": [...]} with one entry per item id.

Items:
`;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, keep: { type: "boolean" },
          type: { type: "string", enum: ["assignment", "quiz", "exam", "event"] },
          title: { type: "string" }, reason: { type: "string" },
        },
        required: ["id", "keep", "type", "title", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

export type Ctx = AICtx;

export async function fingerprint(it: Item): Promise<string> {
  const raw = [it.uid, it.raw_title, it.role, it.course, it.rrule ?? "", head(it.description, 500), it.location].join("|");
  return (await sha1hex(raw)).slice(0, 16);
}

type Verdict = { keep: boolean; type: string; title: string; reason: string };
export type Ask = (items: Item[]) => Promise<Record<string, Verdict>>;

async function parseResponse(answer: any, items: Item[]): Promise<Record<string, Verdict>> {
  const out: Record<string, Verdict> = {};
  for (const v of Array.isArray(answer) ? answer : answer?.verdicts ?? []) {
    const it = items[parseInt(String(v.id ?? "").replace(/^i+/, ""))];
    if (!it || !["assignment", "quiz", "exam", "event"].includes(v.type)) continue;
    out[await fingerprint(it)] = {
      keep: v.keep === undefined ? true : !!v.keep, type: v.type,
      title: String(v.title || it.title).trim().slice(0, 120), reason: String(v.reason || "").trim().slice(0, 80),
    };
  }
  return out;
}

function defaultAsk(ctx: Ctx): Ask {
  return async (items) => {
    const payload = items.map((it, n) => ({
      id: `i${n}`, raw: it.raw_title, course: it.course, role: it.role, guess: it.type,
      repeats: !!it.rrule, desc: head(plain(it.description), 400),
    }));
    return parseResponse(await llmJSON(ctx, PROMPT + JSON.stringify(payload), SCHEMA, { maxTokens: 4000 }), items);
  };
}

/** Overlay AI verdicts on items in place. Returns a status line. */
export async function apply(items: Item[], ctx: Ctx, ask?: Ask): Promise<string> {
  if (ctx.cfg.use_ai === false) return "AI off: using built-in rules";
  if (!ask && !aiReady(ctx)) return "No AI set up: using built-in rules";
  ask ??= defaultAsk(ctx);
  // "gemini-cache" is where verdicts lived before 2026-10-04; they're still valid
  const cache = (await ctx.store.get<Record<string, Verdict>>("ai-cache")) ?? (await ctx.store.get<Record<string, Verdict>>("gemini-cache")) ?? {};
  const fps = await Promise.all(items.map(fingerprint));
  const todo = items.filter((_, i) => !(fps[i] in cache));
  let status = "", asked = 0;
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      Object.assign(cache, await ask(chunk));
      asked += chunk.length;
    }
  } catch (e) {
    status = `AI failed (${(e as Error).message}); rules used for ${todo.length - asked} item(s)`;
  }
  const live = new Set(fps);
  const kept: Record<string, Verdict> = {};
  for (const [k, v] of Object.entries(cache)) if (live.has(k)) kept[k] = v;
  await ctx.store.put("ai-cache", kept);
  items.forEach((it, i) => {
    const v = kept[fps[i]];
    if (v) Object.assign(it, { keep: v.keep, type: v.type, title: v.title, reason: v.keep ? "" : v.reason, source: "ai" });
  });
  return status || (asked ? `AI sorted ${asked} new item(s)` : "AI: all items cached");
}
