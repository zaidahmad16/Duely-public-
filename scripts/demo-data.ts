// Development only: a demo data folder with a Brightspace-like feed dated around today, so the UI can
// be looked at (and screenshotted) with realistic data. Nothing personal; courses are made up.
//   node --experimental-strip-types scripts/demo-data.ts <DATA_DIR> <FEED_URL>
// Writes <DATA_DIR>/demo-feed.ics (serve it at FEED_URL), config.json (onboarded, study blocks on, so
// the engine suggests some) and one "disappeared" question.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, feedUrl] = process.argv.slice(2);
if (!dir || !feedUrl) { console.log("usage: demo-data.ts DATA_DIR FEED_URL"); process.exit(1); }
mkdirSync(dir, { recursive: true });
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, "0");
function local(dayOffset: number, hm: string): string {
  const d = new Date(); d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${hm.replace(":", "")}00`;
}
const now = new Date();
const inHours = (h: number) => { const d = new Date(now.getTime() + h * 3600e3); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

let n = 0;
const ev = (title: string, course: string, day: number, hm: string, end?: string, extra = "") =>
  `BEGIN:VEVENT\nUID:demo_${++n}@brightspace.example.ca\nDTSTART;TZID=${tz}:${local(day, hm)}\nDTEND;TZID=${tz}:${local(day, end ?? hm)}\nSUMMARY:${title}\nLOCATION:${course}\nDESCRIPTION:\nURL:https://brightspace.example.ca/d2l/home/${n}\n${extra}END:VEVENT`;

const C = {
  comp: "COMP 3005A Database Management Systems (Fall)", biol: "BIOL 2200B Cell Biology (Fall)", econ: "ECON 3001A Intermediate Macroeconomics (Fall)",
  stat: "STAT 2507A Introduction to Statistical Modeling (Fall)", hist: "HIST 2101 Modern Europe (Fall)",
};
const events = [
  ev("Assignment 2 - Due", C.comp, 0, now.getHours() < 21 ? inHours(2.5) : "23:59"),
  ev("Reading Response 4 - Due", C.hist, 0, "23:59"),
  ev("Quiz 4 - Availability Ends", C.biol, 1, "10:00"),
  ev("Problem Set 5 - Due", C.econ, 2, "23:59"),
  ev("Lab 3 Report - Due", C.biol, 3, "17:00"),
  ev("Midterm Review Session", C.stat, 4, "13:00", "14:30"),
  ev("Assignment 3 - Due", C.stat, 8, "23:59"),
  ev("Midterm Exam", C.econ, 9, "18:00", "20:00"),
  ev("Essay Proposal - Due", C.hist, 10, "23:59"),
  ev("Quiz 5 - Availability Ends", C.biol, 11, "10:00"),
  ev("Week 7 Content - Availability Starts", C.comp, 1, "08:00"),
  ev("Lecture", C.comp, -7, "11:35", "12:55", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=60\n"),
];
writeFileSync(join(dir, "demo-feed.ics"),
  `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Desire2Learn Inc//D2L Calendar//EN\nX-WR-TIMEZONE:${tz}\n${events.join("\n")}\nEND:VCALENDAR\n`);

writeFileSync(join(dir, "config.json"), JSON.stringify({ feed_url: feedUrl, use_ai: false, onboarded: true, study_blocks: true }, null, 2));
const t = Date.now();
const day = (d: number, h: number) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.getTime(); };
writeFileSync(join(dir, "actions.json"), JSON.stringify({
  demo1: { id: "demo1", type: "keep_vanished", key: "vanished:demo", status: "proposed", created: t, summary: "",
    args: { items: [{ uid: "demo-q2", course: "COMP 3005", title: "Quiz 2", type: "quiz", role: "deadline", start: new Date(day(5, 23)).toISOString(), end: new Date(day(5, 23)).toISOString(), keep: true }] } },
}, null, 2));
console.log(`demo data in ${dir}`);
