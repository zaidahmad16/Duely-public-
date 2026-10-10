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
  onboarded: boolean;
  feedSet: boolean;
  google: boolean;
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
  ai: { provider: Provider | ""; model: string; baseUrl: string; keySet: boolean; dailyLimit: number };
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
};

/** A partial settings change; `aiKey` is write-only (the key never comes back). */
export type SettingsPatch = Partial<Omit<Settings, "ai">> & { ai?: Partial<Omit<Settings["ai"], "keySet">>; aiKey?: string };

export type CapResult = { ok: boolean; message: string; caps?: { label: string; ok: boolean; note: string }[] };

export type ChatReply = { text: string; rows: Row[]; question?: Question };

export type Result<T = undefined> = { ok: true; value?: T } | { ok: false; error: string };
