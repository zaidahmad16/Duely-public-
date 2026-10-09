// Messy text -> plain text before the AI or the rules see it: slang and typos ("wats due tmrw"),
// number words, and course nicknames ("stats", "3106", "the AI course") turned into course codes.
// Course nicknames come from the user's own calendar (codes and course names), never a fixed list.

const SLANG: [RegExp, string][] = [
  [/\b(tmrw|tmrow|tmrrw|tmr|tmw|tom|2moro|2morrow|tomorow|tommorow|tommorrow|tomorrrow)\b/g, "tomorrow"],
  [/\b(2day|tdy|todai)\b/g, "today"],
  [/\b(tonite|2nite|tonigt|tnight)\b/g, "tonight"],
  [/\b(wats|whats|wat's|wuts|whts|wht's)\b/g, "what's"],
  [/\b(wat|wut|wht)\b/g, "what"],
  [/\b(rn)\b/g, "right now"],
  [/\b(wk|wek|weeek)\b/g, "week"],
  [/\b(wks)\b/g, "weeks"],
  [/\b(nxt|nex)\b/g, "next"],
  [/\b(b4)\b/g, "before"],
  [/\b(hmwk|hwk|homewrk)\b/g, "homework"],
  [/\b(assignmnt|assigment|assignemnt|asignment|assingment|assgnment|asgn|assgn|assn)\b/g, "assignment"],
  [/\b(assignmnts|assigments|assignemnts|asignments|assingments|asgns|assgns|assns)\b/g, "assignments"],
  [/\b(quizes|quizzs|quizs)\b/g, "quizzes"],
  [/\b(quizz)\b/g, "quiz"],
  [/\bmid[\s-]+terms?\b/g, "midterm"],
  [/\b(midterm|mid)s\b/g, "midterms"],
  [/\b(exm|examm)\b/g, "exam"],
  [/\b(tut|tutt|tutorail|tutoral)\b(?!\s?\d)/g, "tutorial"],
  [/\b(u)\b/g, "you"],
  [/\b(r)\b/g, "are"],
  [/\b(ur)\b/g, "your"],
  [/\b(pls|plz|plez)\b/g, "please"],
  [/\b(abt|abut)\b/g, "about"],
  [/\b(sth|smth)\b/g, "something"],
  [/\b(anythin|anyting)\b/g, "anything"],
  [/\b(thx|thnx|thanx|tysm)\b/g, "thanks"],
  [/\b(dis)\b/g, "this"],
  [/\b(fri|frid)\b(?!day)/g, "friday"],
  [/\b(lec|lect)\b/g, "lecture"],
  [/\b(sched|schedual|schedul)\b/g, "schedule"],
  [/\b(prof's|profs)\b/g, "prof"],
  [/\b(due date|deadline date)\b/g, "deadline"],
];

/** Common subject nicknames -> subject code. General (any university), not personal. */
const SUBJECT: Record<string, string[]> = {
  STAT: ["stat", "stats", "statistics"], MATH: ["math", "maths"], PHYS: ["phys", "physics"], CHEM: ["chem", "chemistry"],
  BIOL: ["bio", "biol", "biology"], COMP: ["comp", "comp sci", "compsci", "cs", "computer science"], FILM: ["film", "films"],
  ECON: ["econ", "economics"], PSYC: ["psyc", "psych", "psychology"], ENGL: ["engl", "english"], HIST: ["hist", "history"],
  PHIL: ["phil", "philosophy"], SOCI: ["soc", "soci", "sociology"], BUSI: ["busi", "business"], ECOR: ["ecor"],
  GEOG: ["geog", "geography"], LAWS: ["law", "laws"], POLI: ["poli", "poli sci", "polisci", "political science"],
  ARTH: ["art history"], MUSI: ["music", "musi"], LING: ["ling", "linguistics"], COMS: ["coms", "communications"],
};
const NAME_STOP = new Set(["introduction", "intro", "fundamentals", "foundations", "principles", "topics", "special", "the", "of", "to", "and", "in", "for", "with", "a", "an", "i", "ii", "iii", "iv", "course", "studies", "studies:", "lec", "tut", "lab", "sem"]);

/** Everyday words that also appear in course names ("Physics Behind Everyday Life"): never nicknames alone. */
const COMMON = new Set(["behind", "everyday", "life", "world", "people", "modern", "society", "global", "today", "current",
  "issues", "general", "applied", "advanced", "basic", "practice", "methods", "systems", "theory", "analysis", "design",
  "culture", "health", "human", "media", "change", "power", "games", "language", "writing", "research", "problem",
  "problems", "models", "structures", "concepts", "skills", "ideas", "thinking", "things", "science", "sciences"]);

export type CourseInfo = { code: string; name: string };

/** Course codes and names from the calendar items (names come from class locations like
 *  "COMP 3106A Introduction to Artificial Intelligence (LEC)"). */
export function coursesOf(items: any[]): CourseInfo[] {
  const names = new Map<string, string>();
  for (const it of items) {
    if (!it.course || names.get(it.course)) continue;
    const m = /^[A-Z]{3,4}\s?\d{4}[A-Z]?\s+(.+?)\s*\((?:LEC|TUT|LAB|SEM)\)/.exec(String(it.location ?? ""));
    names.set(it.course, m ? m[1] : "");
  }
  return [...names].sort().map(([code, name]) => ({ code, name }));
}

/** Nickname -> course code, only where it points at exactly one of the user's courses. */
export function courseAliases(courses: CourseInfo[]): Map<string, string> {
  const cand = new Map<string, Set<string>>();
  const add = (alias: string, code: string) => {
    const a = alias.toLowerCase().trim();
    if (!a) return;
    if (!cand.has(a)) cand.set(a, new Set());
    cand.get(a)!.add(code);
  };
  for (const { code, name } of courses) {
    const [subj, num] = code.split(" ");
    add(num, code);                                                   // "3106"
    add(subj, code);                                                  // "stat" (if only one STAT course)
    for (const nick of SUBJECT[subj] ?? []) add(nick, code);          // "stats"
    const words = name.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter((w) => w && !NAME_STOP.has(w));
    if (words.length >= 2) add(words.map((w) => w[0]).join(""), code); // "artificial intelligence" -> "ai"
    for (const w of name.match(/\b[A-Z]{2,5}\b/g) ?? []) add(w, code); // "Intro to AI" -> "ai"
    for (const w of words) if (w.length >= 6 && !COMMON.has(w)) add(w, code);   // "intelligence", "modelling"
    if (words.length >= 2) add(words.join(" "), code);
  }
  const out = new Map<string, string>();
  for (const [a, codes] of cand) if (codes.size === 1) out.set(a, [...codes][0]);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Clean a message. `aliases` from courseAliases(); pass an empty map to skip courses. */
export function normalize(text: string, aliases: Map<string, string> = new Map()): string {
  let t = ` ${text} `.toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, " ")
    .replace(/([?!.])\1+/g, "$1")
    .replace(/\b(\w)\1{2,}\b/g, "$1")                                  // "sooo" stays, "zzz" -> "z"
    .replace(/(\w)\1{3,}/g, "$1$1");                                   // "pleeeease" -> "pleease"
  for (const [re, rep] of SLANG) t = t.replace(re, rep);
  // course codes written oddly: "comp3106", "comp-3106" -> "COMP 3106"
  t = t.replace(/\b([a-z]{4})\s?-?\s?(\d{4})\b/g, (_m, s, n) => `${s.toUpperCase()} ${n}`);
  if (aliases.size) {
    // longest aliases first so "computer science" wins over "science"; skip ones already inside a code
    const keys = [...aliases.keys()].sort((a, b) => b.length - a.length);
    for (const a of keys) {
      const code = aliases.get(a)!;
      const re = new RegExp(`(?<![A-Z]{4} )(?<![\\w-])${escape(a)}(?![\\w-])(?! ?\\d{4})`, "g");
      if (/^\d{4}$/.test(a)) t = t.replace(new RegExp(`(?<![A-Z]{4} )(?<![\\w#])${a}(?!\\w)`, "g"), code);
      else if (a.length <= 2) t = t.replace(new RegExp(`(?<![\\w-])${escape(a)}(?= (course|class|prof|professor|lecture|tutorial|test|midterm|exam|assignment|quiz|lab)s?\\b)`, "g"), code);
      else t = t.replace(re, code);
    }
  }
  return t.replace(/\s+/g, " ").trim();
}
