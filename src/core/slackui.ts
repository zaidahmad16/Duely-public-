// Slack messages for proposals: the question with [Yes] [No] buttons (Block Kit), and what the
// message turns into once answered. Typing "yes" / "no" works too (ask.ts), so nothing depends on
// the buttons.
import type { Action, ActionType } from "./actions.ts";

const LABELS: Record<ActionType, [string, string]> = {
  add_study_blocks: ["Add to calendar", "Not now"],
  keep_study_blocks: ["Keep them", "Remove them"],
  mark_done: ["Yes, it's done", "No"],
  undo_done: ["Yes, undo", "No"],
  keep_vanished: ["Keep it", "Remove it"],
};

export function proposalBlocks(a: Action): any[] {
  let [yes, no] = LABELS[a.type];
  if (a.type === "keep_vanished" && a.args.items.length > 1) [yes, no] = ["Keep them", "Remove them"];
  return [
    { type: "section", text: { type: "mrkdwn", text: a.summary.slice(0, 2900) } },
    { type: "actions", block_id: `act:${a.id}`, elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: yes }, action_id: "act_yes", value: a.id },
      ...(a.type === "add_study_blocks" ? [{ type: "button", text: { type: "plain_text", text: "Change times" }, action_id: "act_change", value: a.id }] : []),
      { type: "button", text: { type: "plain_text", text: no }, action_id: "act_no", value: a.id },
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: "Or reply *yes* or *no*. Nothing changes until you answer." }] },
  ];
}

/** The proposal after it's answered: the question stays, the buttons become the outcome. */
export function decidedBlocks(a: Action | null, outcome: string): any[] {
  return [
    ...(a ? [{ type: "section", text: { type: "mrkdwn", text: a.summary.slice(0, 2900) } }] : []),
    { type: "context", elements: [{ type: "mrkdwn", text: outcome.slice(0, 2900) }] },
  ];
}

/** Post a proposal as a bot DM. */
export async function postProposal(token: string, channel: string, a: Action, f: typeof fetch = fetch): Promise<void> {
  const r = await f("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text: a.summary.slice(0, 3000), blocks: proposalBlocks(a), unfurl_links: false }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Slack: ${body.error ?? `HTTP ${r.status}`}`);
}

const sections = (text: string) => {
  // a section holds 3000 chars: split long replies at line breaks
  const out: any[] = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    if ((chunk + "\n" + line).length > 2900 && chunk) { out.push(chunk); chunk = line; } else chunk = chunk ? chunk + "\n" + line : line;
  }
  if (chunk) out.push(chunk);
  return out.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } }));
};

/** A chat reply: the text, checkboxes for the numbered work + [Mark done], and 👎 That's wrong.
 *  `flag` = what the button carries (the question), so a report needs no lookup. */
export function replyBlocks(text: string, picks: { uid: string; label: string }[], question: string, opts: { flag?: boolean } = {}): any[] {
  const blocks: any[] = sections(text);
  const elements: any[] = [];
  if (picks.length) {
    elements.push({
      type: "checkboxes", action_id: "pick",
      options: picks.slice(0, 10).map((p) => ({ text: { type: "plain_text", text: p.label.slice(0, 75) }, value: p.uid.slice(0, 150) })),
    });
    elements.push({ type: "button", style: "primary", text: { type: "plain_text", text: "Mark done" }, action_id: "done_selected", value: "x" });
    elements.push({ type: "button", text: { type: "plain_text", text: "Dismiss" }, action_id: "dismiss", value: "x" });
  }
  if (opts.flag !== false) elements.push({ type: "button", text: { type: "plain_text", text: "👎 That's wrong" }, action_id: "flag", value: question.slice(0, 1900) });
  if (elements.length) blocks.push({ type: "actions", block_id: "reply_actions", elements });
  return blocks;
}

/** The same reply after a press: its text stays, the controls become a note. */
export function settledBlocks(original: any[], note: string): any[] {
  return [...(original ?? []).filter((b) => b.type === "section"), { type: "context", elements: [{ type: "mrkdwn", text: note.slice(0, 2900) }] }];
}

/** "What should it have said?" (optional), opened by 👎. */
export function flagModal(flagId: string): any {
  return {
    type: "modal", callback_id: "flag_note", private_metadata: flagId,
    title: { type: "plain_text", text: "Thanks for flagging" },
    submit: { type: "plain_text", text: "Save" }, close: { type: "plain_text", text: "Skip" },
    blocks: [{
      type: "input", block_id: "note", optional: true, label: { type: "plain_text", text: "What should Duely have said? (optional)" },
      element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 1000 },
    }],
  };
}

/** "Dismiss": the done controls go, the answer and 👎 stay. Nothing is marked. */
export function dismissedBlocks(original: any[]): any[] {
  const out: any[] = [];
  for (const b of original ?? []) {
    if (b.type !== "actions") { out.push(b); continue; }
    const keep = (b.elements ?? []).filter((e: any) => e.action_id === "flag");
    if (keep.length) out.push({ ...b, elements: keep });
  }
  return out;
}

/** A plain bot DM in Slack mrkdwn (links and bold kept; alerts escape their text). */
export async function postDM(token: string, channel: string, text: string, f: typeof fetch = fetch): Promise<void> {
  const r = await f("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text: text.slice(0, 3900), unfurl_links: false, unfurl_media: false }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Slack: ${body.error ?? `HTTP ${r.status}`}`);
}

/** "Change times" for a study-block suggestion: a date + time picker per block, pre-filled.
 *  `meta` carries the action id and where the question message is (to update it after saving). */
export function studyChangeModal(a: Action, tz: string, meta: string): any {
  const plan = a.args.plan;
  const local = (t: number) => new Date(t).toLocaleString("sv-SE", { timeZone: tz });   // "YYYY-MM-DD HH:MM:SS"
  const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text: `*${a.args.name}*: pick when to do each ${Math.round((plan.blocks[0].e - plan.blocks[0].s) / 36e5)}-hour block.` } }];
  plan.blocks.forEach((b: any, i: number) => {
    const [d, t] = local(b.s).split(" ");
    blocks.push({ type: "input", block_id: `day${i}`, label: { type: "plain_text", text: `Block ${i + 1}: day` }, element: { type: "datepicker", action_id: "v", initial_date: d } });
    blocks.push({ type: "input", block_id: `time${i}`, label: { type: "plain_text", text: `Block ${i + 1}: start time` }, element: { type: "timepicker", action_id: "v", initial_time: t.slice(0, 5) } });
  });
  return { type: "modal", callback_id: "study_change", private_metadata: meta, title: { type: "plain_text", text: "Change study times" },
    submit: { type: "plain_text", text: "Add to calendar" }, close: { type: "plain_text", text: "Back" }, blocks };
}
