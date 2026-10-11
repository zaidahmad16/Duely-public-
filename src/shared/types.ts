// What crosses the bridge between the main process and the UI. Plain data only: no secrets, ever.

export type Category = "assignment" | "tutorial" | "lab" | "module" | "quiz" | "test" | "other" | "event" | "class" | "study";

/** One occurrence of a calendar item, as a row in Upcoming or in a chat answer. */
export type Row = {
  key: string;            // uid@day: unique per occurrence
  uid: string;
  course: string;
  title: string;
  category: Category;
  label: string;          // "Assignment", "Quiz", "Test", "Event", "Class", "Study"
  t: number;              // when it's due / starts (ms)
  end?: number;           // events: when it ends
  allDay: boolean;
  day: string;            // local YYYY-MM-DD
  deadline: boolean;      // due at t (vs. happens at t)
  done: boolean;
  location?: string;
  url?: string;
  announced: boolean;     // read from an announcement by AI
};

export type Button = "keep" | "remove" | "add" | "notnow" | "change" | "yes" | "no";

/** Something Duely is asking the student (an open proposal). */
export type Question = {
  id: string;
  kind: "vanished" | "study" | "keep_study" | "done";
  title: string;
  body: string;
  buttons: Button[];
  /** study: the suggested blocks and the deadline they must end before */
  blocks?: { s: number; e: number }[];
  due?: number;
};

export type Upcoming = {
  tz: string;
  now: number;
  today: Row[];
  thisWeek: Row[];
  nextWeek: Row[];
  filtered: { uid: string; course: string; title: string; reason: string }[];
  questions: Question[];
};

export type Status = {
  /** the computer's locale (Chromium's own UI locale can differ, e.g. en-GB for en-CA) */
  locale: string;
  version: string;
  /** updates (packaged app only): what's new, downloading, ready to restart, or a download link */
  update: { state: string; version: string; percent: number; lastChecked: number; canInstall: boolean; url: string; auto: boolean } | null;
  onboarded: boolean;
  feedSet: boolean;
  google: boolean;
  /** connected, but Google's sign-in expired (a client in "Testing" expires every 7 days); one click reconnects */
  googleExpired: boolean;
  /** a Google client file was given before (reconnecting doesn't need it again) */
  googleClient: boolean;
  /** the AI is set up and its connection test passed (required to use the app) */
  aiReady: boolean;
  weakKeychain: boolean;
  startAtLogin: { can: boolean; on: boolean };
  sync: { time: number; error: string; needsGoogle: boolean; items: number; running: boolean };
  /** where the engine runs: "cloud" = the script in the student's Google account (P3.5) */
  engine: "cloud" | "local";
  cloud: { readAt: number; version: string; running: boolean; emailAlerts: boolean; needsApproval: boolean; editor: string } | null;
};

export type Provider = "openai" | "anthropic" | "gemini";

export type Settings = {
  feedUrl: string;
  announcementFeeds: string[];
  ai: { provider: Provider | ""; model: string; /** Duely picks the model (the student left Model empty) */ auto: boolean; baseUrl: string; keySet: boolean; dailyLimit: number };
  notifications: boolean;
  importantAnnouncements: boolean;
  studyBlocks: boolean;
  studyDay: [string, string];
  studyBlockHours: number;
  digestDaily: boolean;
  digestTime: string;
  digestWeekly: boolean;
  briefings: boolean;
  calendarName: string;
  /** imported timetables (src/core/timetableImport.ts), newest term last */
  terms: { key: string; name: string; start: string; end: string; classes: number; courses: string[] }[];
  exams: { key: string; course: string; title: string; date: string; start: string; end: string; room: string }[];
  /** the school's academic dates page, read when importing a timetable (optional) */
  academicDatesUrl: string;
  /** Discord alerts (P6): who's connected, and the last problem sending (in words), if any */
  discord: { name: string; error: string } | null;
};

/** A partial settings change; `aiKey` is write-only (the key never comes back). */
export type SettingsPatch = Partial<Omit<Settings, "ai" | "terms" | "exams" | "discord">> & { ai?: Partial<Omit<Settings["ai"], "keySet" | "auto">>; aiKey?: string };

/** One term read from timetable screenshots, for review (same shape as src/core/timetableImport.ts Term). */
export type TermDraft = { name: string; start: string; end: string; no_class: [string, string][]; day_swaps: Record<string, string>;
  classes: { course: string; section: string; kind: string; days: string[]; start: string; end: string; room: string; crn: string }[];
  dates_source?: string; tba: string[]; notes: string[] };
export type ExamDraft = { course: string; title: string; date: string; start: string; end: string; room: string };

export type CapResult = { ok: boolean; message: string; caps?: { label: string; ok: boolean; note: string }[]; /** the model tested, and whether Duely chose it */ model?: string; auto?: boolean };

export type ChatReply = {
  text: string; rows: Row[]; question?: Question;
  /** "what do you need from me?": Duely's open questions, as cards */
  questions?: Question[];
  /** questions this message answered (typed "yes", "undo"…): earlier cards show the outcome */
  resolved?: { id: string; word: string }[];
};

/** One message of the saved chat (Duely's replies rebuilt with today's rows and question states). */
export type ChatMessage = {
  id: string; at: number; who: "me" | "duely"; text: string; rows: Row[];
  /** still waiting: live cards; answered: the outcome word per question id */
  questions: Question[]; resolved: { id: string; word: string }[];
};

export type Result<T = undefined> = { ok: true; value?: T } | { ok: false; error: string };
