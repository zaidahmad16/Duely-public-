// What kind of thing a calendar item is, from its title. Brightspace types every deliverable
// "assignment" (tutorials, labs, modules, lab reports…), so chat, digests and study blocks use this.

export const CATEGORIES = ["assignment", "tutorial", "lab", "module", "quiz", "test", "other", "event", "class", "study"] as const;
export type Category = (typeof CATEGORIES)[number];

const TEST_RE = /\b(tests?|midterms?|exams?|finals?)\b/i;
const NOT_TEST_RE = /\b(review|session|prep|practice|office hours?|reminder|study)\b/i;

export function category(it: any): Category {
  const title = String(it.title ?? "");
  if (it.type === "study" || it.source === "study") return "study";   // Duely's own planned study blocks
  if (it.type === "class" || !!it.meetings?.length || (!!it.rrule && it.role !== "deadline")) return "class";
  if (it.type === "exam" || (TEST_RE.test(title) && !NOT_TEST_RE.test(title))) return "test";
  if (it.type === "quiz" || /\bquiz(zes)?\b/i.test(title)) return "quiz";
  if (/\bassignment\b|\b(a|asg|assgn)\s?\d+\b/i.test(title)) return "assignment";
  if (/\btutorial\b/i.test(title)) return "tutorial";
  if (/\blab\b|\blab reports?\b/i.test(title)) return "lab";
  if (/\bmodule\b/i.test(title)) return "module";
  return it.role === "deadline" ? "other" : "event";
}

/** Things to hand in or sit (not classes, plain events or Duely's own study blocks). */
export const isWork = (it: any) => it.source !== "study" && it.type !== "study"
  && (it.role === "deadline" || category(it) === "test");
