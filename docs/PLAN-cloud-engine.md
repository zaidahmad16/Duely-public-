# Plan: Duely's engine in the student's own Google account (Apps Script)

Status: **proposal, waiting for the owner's approval.** Nothing here is built yet.

## Why

Duely's main job is to keep Google Calendar in step with Brightspace and to catch new dates in course
announcements. Today that only happens while the student's computer is on, because the desktop app does all
the work. The owner wants syncing and announcement reading to run around the clock, for $0, without a server
we run.

## The idea

Every Google account includes **Apps Script**, Google's free scripting service. A script can run on a timer
on Google's servers, fetch web pages, call an AI provider, and write to Google Calendar, all with the laptop off.

Duely puts a script in **each student's own Google account** and makes it the engine:

| Runs in the student's Google account (Apps Script), 24/7 | Runs in the desktop app, when it's open |
|---|---|
| Brightspace → Google Calendar sync, every 10 minutes | Upcoming, Chat, Settings |
| Reading announcements with AI | Answering Duely's questions (keep it, add study blocks…) |
| Alerts while the laptop is off (via the Discord bot, or email as a fallback) | Ticking things done |
| Morning digest, Sunday preview, test-eve briefing | Screenshot import (P5) |
| Suggesting study blocks (adding them still waits for a yes) | Desktop notifications |

**One writer:** only the script changes the calendar. The desktop app sends its decisions (done marks,
answers, settings) to the script and shows what the script last did. That way the two can never undo each
other's changes. When the desktop can't reach Google (offline), it shows the last known state and queues its
decisions.

## Confirmed facts (Google's own documentation, checked)

Apps Script limits for a regular Gmail account:
- 90 min of timed-trigger runtime a day;
- 6 min per run;
- 20,000 URL fetches a day;
- 5,000 calendar events created a day;
- 20 triggers per user per script;
- properties up to 9 KB per value and 500 KB in total.

A sync every 10 minutes is about 144 runs a day. At a few seconds each that's roughly 10–20 min a day, inside
the 90.

Other confirmed facts:
- The Apps Script API can create and update script projects programmatically.
- It must be enabled in the Google Cloud project; each student already has one from the Google step.
- It doesn't work with service accounts. That's fine, since we use the student's own sign-in.

## Unknowns to prove first (Phase 0, a throwaway proof of concept)

Each must work end to end before Phase 1 starts. If one fails, the fallback is noted.

1. **Installing the script from the desktop app.** Duely creates the project and uploads the engine with the
   Apps Script API, using the student's Google sign-in. Expected extra step for students: switching on
   "Google Apps Script API" in their Apps Script user settings, once.
2. **Authorizing the script once.** A script needs the owner's approval for its own permissions (calendar,
   web fetch). Find the smoothest path: Duely opens the script and the student clicks Run on "setup" once, or
   an API call does it. The setup function then creates its own 10-minute trigger.
3. **A shared channel between the desktop app and the script.** Each Google permission belongs to one
   client, and the script and the desktop app may count as different clients. Candidates, in order:
   (a) the script deployed as a private web app only the student can call, so the desktop reads and writes
   through it; (b) a Drive file both can open, which may need the script tied to the student's Cloud project;
   (c) data kept in the Duely calendar's own events.
4. **Sync now.** The desktop asks the script to run immediately, through the same channel as 3 (a web app
   call is the most likely). Fallback: the desktop runs one sync itself, under a lock the script respects.
5. **The engine running inside Apps Script.** `src/core` is plain TypeScript. Bundle it into one script file
   with small adapters: `fetch` → `UrlFetchApp`, the Calendar client → the Calendar advanced service, the
   store → PropertiesService or a Drive file. Measure a full sync of a real-sized feed against the 6-minute
   run limit.
6. **AI from the script.** Call each provider type (OpenAI-compatible, Anthropic, Gemini) with
   `UrlFetchApp`, using the same adapters.

Phase 0 is done when a test Google account gets its calendar filled by the script with the laptop off,
announcements are read with AI, and Sync now from the desktop triggers a run.

## Phase 1: build

1. **Engine bundle:** a build step that turns `src/core` + `src/llm` + the Apps Script adapters into one
   file. Tests run the same engine with fake Apps Script services, so the bundle and the desktop never drift
   apart.
2. **Script runtime:** the timer handler (sync every 10 min, quick announcement checks between them, the
   digest, briefing and alert timing ported from `src/node/runner.ts`); a daily AI cap; error health
   tracking; the setup function.
3. **Shared state:** the channel from Phase 0, holding settings, done marks, answers to questions, the last
   sync result, items for Upcoming, open questions, and health. Writes are validated, and the previous good
   copy is kept, as in the desktop store today.
4. **Desktop changes:**
   - Upcoming, Chat and the question cards read from the shared state;
   - decisions are written there;
   - Sync now calls the script;
   - the local engine stays only as the offline fallback and for chat;
   - status shows "Updated by Duely in the cloud 4 min ago".
5. **Setup flow:** the onboarding Google step grows to: connect Google → switch on the Apps Script API
   (with a direct link and a check that it's on) → Duely installs the script → approve it once → done. The
   setup guide is updated to match.
6. **Updates:** when a new app version ships a new engine, the desktop updates the script automatically
   (Apps Script API), keeping the student's data.
7. **Alerts while the laptop is off:** the script sends them through the Discord relay (P6) when connected,
   otherwise by email to the student's own address (`MailApp`, free, about 100 a day), and otherwise they
   wait for the desktop.

## Keys and privacy (what changes for students)

- **The AI key** is also stored in the student's own Google account, in the script's private properties,
  so announcements can be read 24/7. It's still never sent to us or any Duely server.
- **The Brightspace links** (calendar and announcements) are stored there too.
- **New Google permissions:** managing Duely's own Apps Script project, plus whatever the shared channel
  needs (decided in Phase 0). The script itself asks for calendar access and permission to call web
  services. Both show on Google's approval screens.
- **The Privacy Policy and Terms get rewritten before release:**
  - what lives in the student's Google account;
  - that AI requests continue while the laptop is off, within the daily cap;
  - how to remove everything: delete the Duely script and calendar, and revoke access.
- **Disconnect / uninstall:** Duely removes the script's triggers and, if the student wants, deletes the
  script project.

## Cost

- **The student:** $0 on Google's side. AI use as now, capped daily; Gemini's free tier is $0.
- **Us:** $0. No server, apart from the optional Discord relay on Cloudflare's free tier.

## Risks

- **Google changes Apps Script quotas or the API.** The desktop sync stays as a working fallback.
- **The two setup clicks confuse students.** Duely checks each one, explains it, and the guide has
  screenshots.
- **Engine drift between desktop and script.** It's one shared source, bundled, with tests run against both.
- **A school blocks Apps Script on student Google accounts.** That's only possible for school-managed
  Google accounts, and Duely uses the student's personal one. Duely detects it and falls back to desktop
  sync.

## How it changes the milestones

- **P3.5 (new, next after the owner's UI review):** cloud engine. Phase 0, then Phase 1.
- **P2's live Google test** becomes part of P3.5 Phase 0, done with the same test account.
- **P4 chat polish and P5 screenshots** follow. P5's announcement warning moves into the script.
- **P6 Discord:** the relay also accepts alerts from the student's script.
- **P7 release:** unchanged.

## Waiting on the owner

- Approve this plan, or change it.
- For Phase 0: a throwaway Google account, or a test calendar on the existing one, to try the script on.
