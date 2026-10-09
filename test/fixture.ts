// Shared sample calendar (state.json shape), mirroring the real one around 2026-10-04.
const dl = (course: string, title: string, when: string, type = "assignment") =>
  ({ uid: `${course}/${title}`, course, title, type, role: "deadline", start: when, end: when, keep: true });
export const ITEMS = [
  dl("PHYS 1905", "Quiz - Sports Module", "2026-10-05T23:59:00-04:00", "quiz"),
  dl("COMP 2406", "Assignment 1 - Client-side Programming", "2026-10-08T23:59:00-04:00"),
  dl("COMP 2406", "Tutorial 3", "2026-10-09T10:00:00-04:00"),
  dl("COMP 2406", "Tutorial 4", "2026-10-09T10:00:00-04:00"),
  dl("FILM 1101", "Optional Quiz 3", "2026-10-09T23:59:00-04:00", "quiz"),
  dl("COMP 3106", "Assignment 1", "2026-10-09T23:59:00-04:00"),
  { uid: "rev", course: "STAT 2507", title: "Test 1 Review Session", type: "event", role: "event", start: "2026-10-11T13:00:00-04:00", end: "2026-10-11T14:00:00-04:00", keep: true },
  { uid: "t1", course: "STAT 2507", title: "Test 1", type: "exam", role: "event", start: "2026-10-12T10:00:00-04:00", end: "2026-10-12T11:30:00-04:00", keep: true },
  { uid: "lec", course: "STAT 2507", title: "Lecture", type: "class", role: "event", start: "2026-09-07T08:35:00-04:00", end: "2026-09-07T09:55:00-04:00",
    rrule: "FREQ=WEEKLY;UNTIL=20261210T173000Z;INTERVAL=1;BYDAY=MO", location: "LA C164", keep: true },
];
