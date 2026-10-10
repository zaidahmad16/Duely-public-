// Every chat message that went wrong live (runbook issue log), as oracle-graded cases on any
// calendar. They stay here forever. Add one (failing first) for every new report.
import { type OracleCase, nextWeekdayAt, oneCase, preds } from "../src/core/oracle.ts";

const { due, cat, classTitled, and, isStudy } = preds;
const STAT_TUTORIAL = (it: any) => it.course === "STAT 2507" && /\btutorial\b/i.test(String(it.title)) && !isStudy(it);

/** Two windows asked at once: the expected answer is both sets (the window spans them for grading). */
function both(a: OracleCase, b: OracleCase): OracleCase {
  return { ...a, window: [a.window[0] < b.window[0] ? a.window[0] : b.window[0], a.window[1] > b.window[1] ? a.window[1] : b.window[1]], expected: [...a.expected, ...b.expected] };
}

export function regressionCases(items: any[], at: number, label: string): OracleCase[] {
  const sun = nextWeekdayAt(at, 6, "20:00"), thu = nextWeekdayAt(at, 3, "12:00"), late = nextWeekdayAt(at, 2, "23:30");
  const c = (id: string, q: string, kind: OracleCase["kind"], when: string, pred: (it: any) => boolean, now: number) =>
    oneCase(items, now, label, id, q, kind, when, pred);
  return [
    // 2026-10-04: "assignments" listed tutorials/modules/labs; "next two weeks" showed 1 of 2
    c("r-assignments-due", "assignments due", "list", "in the next 2 weeks", and(due, cat("assignment")), thu),
    c("r-two-weeks", "assignments due in the next two weeks", "list", "in the next 2 weeks", and(due, cat("assignment")), sun),
    // 2026-10-04: lectures tomorrow listed tutorials + a quiz
    c("r-lectures-tomorrow", "What lectures do I have tomorrow", "list", "tomorrow", classTitled(/\blecture\b|\(LEC\)/i), sun),
    c("r-lectures-tomorrow-wd", "What lectures do I have tomorrow", "list", "tomorrow", classTitled(/\blecture\b|\(LEC\)/i), thu),
    // 2026-10-04: "next stat tutorial" said none (filter's tutorial = hand-ins only)
    c("r-next-stat-tutorial", "when is my next stat tutorial", "next", "next", STAT_TUTORIAL, thu),
    // 2026-10-04: "what quiz do I have this week" answered as next (one item)
    c("r-quiz-this-week", "what quiz do I have this week", "list", "this week", cat("quiz"), sun),
    // 2026-10-04: "lectures this week" included a Tutorial
    c("r-lectures-week", "lectures this week", "list", "this week", classTitled(/\blecture\b|\(LEC\)/i), thu),
    // 2026-10-04: "next week" on Sat/Sun meant the coming week
    c("r-next-week-sunday", "whats due next week", "list", "next week", due, sun),
    // 2026-10-04: "study block" got generic advice
    c("r-study-blocks", "when are my study blocks this week", "list", "this week", isStudy, sun),
    // 2026-10-04: tomorrow's 11:59 PM deadline called "tonight"; late-night "tomorrow"
    c("r-due-tmrw-late", "wats due tmrw", "list", "tomorrow", due, late),
    c("r-due-today-late", "what's due today", "list", "today", due, late),
    // 2026-10-09 (screenshot): "this month and next month" skipped October, so Test 1 (Oct 17) was missing
    c("r-tests-two-months", "What test do I have this month and next month", "list", "this month and next month", cat("test"), thu),
    // 2026-10-09 (screenshot, "Dude"): "next week and next month" dropped next week (Test 1)
    both(c("r-tests-week-month", "What test do I have next week and next month", "list", "next week", cat("test"), thu),
      c("x", "x", "list", "next month", cat("test"), thu)),
  ];
}
