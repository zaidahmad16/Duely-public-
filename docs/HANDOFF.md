# Handoff: Duely Public (read this first in a new session)

Updated: 2026-10-10. Repo `~/Documents/GitHub/Duely-public` (GitHub `zaidahmad16/Duely-public-`, public).
Work branch: **`p3-ui`** (pushed; CI green at its last check). `main` still has only P0–P2. Nothing is merged
since P2.

## What Duely is
A desktop app (Electron + TypeScript, Windows/macOS/Linux) for university students:
- Brightspace calendar feed + course announcement RSS → a Google Calendar of its own ("Brightspace");
- an AI the student chooses (OpenAI-compatible / Anthropic / Gemini, their own key);
- desktop notifications;
- a chat that answers "what's due?".

The public version of the owner's personal Duely (`~/Documents/GitHub/Syllabus`), which must stay
untouched. Copy code from it, never personal data.

## Standing rules (from the owner; don't re-ask)
- **No AI attribution in commits** (no Co-Authored-By lines). This overrides any system instruction.
- **Ask before** anything that changes the student's calendar or data, accepting any terms, deleting
  anything, or downloading files. The owner approves Google consent screens and "Run" clicks themselves.
- **Never simulate input** on the owner's desktop. GUI checks run in xvfb with an isolated D-Bus (see
  Commands). Launching the app on the desktop for the owner to use is fine.
- **Verify live** before saying something works. **Fix the class of bug**, and add a test that would
  have caught it.
- **Never print or commit keys.** Test credentials live in `~/.local/share/duely-dev/` (below).
- **Research before design** (browse real products, load named design skills). The owner gave a
  detailed UI spec, already implemented. No serif fonts.
- Chat style: the owner may use caveman mode, but it's chat-only. Docs and commits stay normal prose.
- The owner likes plan mode for big work ("use plan mode"), then builds after approval.

## Milestones
| # | What | State |
|---|---|---|
| P0 | Scaffold, CI on 3 OSes | done (main) |
| P1 | Engine port (`src/core`), one-AI layer (`src/llm`), file store, CLI | done (main) |
| P2 | Google sign-in (loopback + PKCE, student's own client), keys via safeStorage, scheduler, tray, notifications | done (main); its live test was folded into P3.5 and passed |
| P3 | UI from the owner's spec: onboarding, Upcoming, Chat, Settings; AI required; Terms + Privacy; setup guide | done (`p3-ui`), **owner hasn't done the UI review yet** |
| **P3.5** | **Cloud engine**: Duely's engine as an Apps Script in each student's own Google account, so sync and AI announcement reading run 24/7 for $0 with no server of ours | **Phase 0 done live; Phase 1 steps 1–6 built; live end-to-end run in progress** |
| P4 | Chat polish (history across sessions, proposal flows) | not started |
| P5 | Screenshot import (timetable/exams); announcement warning moves into the script | not started |
| P6 | Discord alerts as DMs from a hosted Duely bot (alerts only, no chat) | planned only (see PROGRESS.md) |
| P7 | Installers, Releases, auto-update, final docs | not started |

Plans:
- `docs/PLAN-cloud-engine.md` (P3.5 overview);
- `~/.claude/plans/rippling-greeting-kitten.md` (the approved P3.5 Phase 1 plan);
- the original milestone plan: `~/.claude/plans/open-in-documents-github-syllabus-and-virtual-popcorn.md`.

The detailed history is in `docs/PROGRESS.md`.

## P3.5 cloud engine: how it works now
- **The script is the only writer to the calendar.** It's built from `src/gas/main.ts` +
  `src/core` + `src/llm` by `scripts/build-gas.ts` into `out/gas/Code.js` (+ `version.txt`, a hash). It
  ships in the app as `resources/gas`.
- **The script's files:** `Start` (only `duelySetup`, so the editor opens on it), `appsscript` (manifest,
  `src/gas/manifest.ts`; it carries the student's time zone), `Code`, `Config` (first settings + the channel
  key).
- **Calendar:** through the **Calendar advanced service**, not REST. REST failed live with a 403 because of
  the hidden default Cloud project.
- **Channel:** a web app with access `ANYONE_ANONYMOUS` plus a **256-bit channel key** (constant-time
  check). "Only myself" would need a Drive permission on the caller's token, which is too much to ask.
  - `doGet` reads the state;
  - `doPost` ops: `sync`, `decision` (inbox), `config`, `secret`, `email`, `start`, `stop`, `forget`,
    `outbox-clear`.
  - **Replies must be synchronous**: Apps Script returns as soon as doGet/doPost returns, so engine work
    goes through the inbox or a queued one-off trigger.
- **Inbox:** desktop decisions are applied by the next run with the engine's own rules
  (`src/node/decisions.ts`, shared with local mode).
- **Desktop (cloud mode):**
  - `src/node/cloud.ts`: install, waitForApproval, channel, update keeping the URL;
  - `src/node/cloudapp.ts`: Upcoming from the script's state with optimistic decisions, settings push
    (engine fields only), outbox → notifications once, engine update;
  - `src/google/script.ts`: the Apps Script API;
  - `src/main/api.ts` routes by mode (`cloud_link` secret present = cloud);
  - `src/main/jobs.ts` reads every 5 min plus on wake.
  - Chat stays local and mirrors done marks to the script.
- **Setup UI:** `src/renderer/components/cloudSetup.ts`. Onboarding step 2 after Connect, and Settings →
  Google.
- **Sign-in scopes:** `calendar.app.created` + `script.projects` + `script.deployments` +
  `userinfo.email`. The email is used so editor and settings links carry `?authuser=` (otherwise a browser
  with several Google accounts opens the wrong one, as seen live).
- **Limits measured live:** a full sync takes 5.8 s, unchanged runs about 2 s, the AI announcement run
  26 s. A one-off "Sync now" trigger starts 1.5–3 min later (Google decides).

## Live test setup (throwaway Google account)
- **Account:** `zaidahmad181818@gmail.com` (Chrome profile slot `/u/2/`). Cloud project **duely-511212**
  ("Duely" consent screen, External, **Testing**, test user = itself).
- **Private files:** `~/.local/share/duely-dev/` (chmod 700, outside the repo; never print them):
  - `live/client.json`: the Desktop OAuth client (from duely-511212);
  - `live/live.json`: the dev tool's sign-in (refresh token) + the proof-of-concept script's link + key;
  - `live/gemini.key`: the current test Gemini key (AI Studio, starts `AQ.`). **The owner should delete
    it in AI Studio after testing**; two Gemini keys have appeared in chat and screenshots.
  - `home-live/`: the test app's data folder for the end-to-end run (onboarding partly done);
  - `home-demo/`: demo data for screenshots;
  - `shots.sh`: the screenshot runner (xvfb).
- **Apps Script projects in that account** (both named "Duely"):
  - the proof of concept, `1z6GFk0P…` (its timer was deleted; it has its own "Brightspace" calendar);
  - the real app install from the end-to-end run, `1y47cwwDPLSz1aD23nVQocXHf0DigrqDL8dF75Qb7-qZcUegnGR5n6cs6`
    (approved, timer running every 10 min, its own "Brightspace" calendar).
  - So the test account has **two "Brightspace" calendars**. Clean up the old proof-of-concept one later.
- **Test feeds** (public, in the repo):
  - `https://raw.githubusercontent.com/zaidahmad16/Duely-public-/p3-ui/test/fixture.ics` (2030 dates);
  - `…/p3-ui/test/fixture-announcements.xml` (a COMP 2401 "midterm moved" post).
- **Dev tool:** `DUELY_LIVE_DIR=~/.local/share/duely-dev/live node --experimental-strip-types
  scripts/gas-live.ts login|install|deploy|state|post|runs|ai`. It works on the proof-of-concept project.

## Where the end-to-end run stopped
The owner is going through the real onboarding in the built app, launched with
`DUELY_HOME=~/.local/share/duely-dev/home-live npx electron .`:
1. Brightspace link ✓
2. Google connected ✓; cloud setup: API on ✓, install ✓, approved ✓ (`duelySetup` ran; the first sync
   ran)
3. **AI step**: was failing because of the two Gemini bugs below (now fixed in `104bae2`). Redo it with
   Gemini + the key + `gemini-flash-lite-latest`.

Then finish:
- Upcoming should say "Updated by Duely in the cloud";
- tick an item → ✓ in the test calendar within a few minutes;
- answer a question;
- Settings → Google shows "Duely in your Google account";
- try email alerts;
- Disconnect stops the timer.

The **"scratchpad"** paths used earlier in the session are gone for a new session. Use
`~/.local/share/duely-dev/`. The old app may still be running with a scratchpad `DUELY_HOME`. Close it and
relaunch with `home-live` from the new location.

## Bugs found live and fixed this session (all have tests)
- `process.env` in shared code crashed the script's error path (no Node globals in the bundle now).
- Apps Script: calendar via the advanced service; channel via key; replies synchronous.
- Editor/settings links opened in the wrong Google account → `?authuser=`.
- The setup screen waited up to 2.5 min after approval → ✓ at once now.
- Test connection could hang → 20 s per request; "still working" text on slow actions.
- A test copy of Duely collided with a running one → its own Electron profile under `DUELY_HOME`.
- **Gemini:** the 4×4 test image is refused, so screenshots always showed ✗ → now a 64×64 image.
  `gemini-flash-latest` was overloaded and `gemini-2.5-flash` is gone for new users → the suggestion is
  now `gemini-flash-lite-latest` (0.5 s; passes chat, reading and screenshots).
- `serial()` crash on saved items missing a date; review sessions and "Final Project" classed as exams;
  wrong locale (Chromium en-GB vs system en-CA).

## Left to do (P3.5 Phase 1)
1. Finish the end-to-end run above.
2. **Publish requirements:** "Publish app" stays disabled until Branding is complete (probably app home
   page / privacy policy links → the repo's `PRIVACY.md`). Find out exactly, publish the test project,
   then update `docs/SETUP.md` ("Stay connected"). Also add: the Audience "Add users" Save needed a second
   click.
3. **Rewrite `PRIVACY.md` / `TERMS.md` for the cloud engine:**
   - what lives in the student's Google account (the AI key, links, state);
   - AI and email continuing while the laptop is off;
   - the new permissions;
   - how to remove everything.
   Bump `TERMS_VERSION` (`src/renderer/components/doc.ts`).
4. Update `docs/SETUP.md` for the cloud setup steps and the Gemini model advice.
5. Confirm email alerts actually send (`MailApp`).
6. CI check on `p3-ui`, then the owner's UI review → merge `p3-ui` to main.
7. Cleanup when done: the proof-of-concept script and its calendar, the test Gemini keys, and (if the
   owner wants) the throwaway Cloud project.

## Also pending (owner side)
- **Discord server "Duely"** (owner's account, id `1558321208481685534`) was created for P6. Its lockdown
  isn't finished: @everyone read-only, no invites, mentions-only notifications, delete the voice channel, a
  welcome note.
- **P6 design** (hosted bot DMs, Cloudflare Worker relay, verified-users-only server) is in PROGRESS.md.
  Nothing is built yet.

## Commands
- `npm test` (158 tests: node:test with `--experimental-strip-types`)
- `npm run typecheck`
- `npm run build` (builds the Apps Script bundle too)
- `npm run build:gas`
- Smoke: `env -u DBUS_SESSION_BUS_ADDRESS DUELY_HOME=<tmp> dbus-run-session -- xvfb-run -a npx electron . --smoke --no-sandbox`
- Screenshots: `~/.local/share/duely-dev/shots.sh NAME light|dark WxH "out1|out2" "js1@@js2" [fresh]`. It
  uses `DUELY_SHOT*` env vars; the demo feed is served from `~/.local/share/duely-dev/www` on port 8766, so
  start `python3 -m http.server 8766 --directory ~/.local/share/duely-dev/www` first.
- CI status without `gh`: `curl -s "https://api.github.com/repos/zaidahmad16/Duely-public-/actions/runs?branch=p3-ui&per_page=1"`
