# Progress (resume here)

Plan: see the approved plan (milestones P0–P7). Updated 2026-10-09.

- **P0 done** (main, ad8667d): Electron + TypeScript scaffold, CI green on Windows/macOS/Linux.
- **P1 done**: engine port and one-provider AI layer.
  - `src/llm/`: provider-neutral types; OpenAI-compatible / Anthropic / Gemini adapters; JSON helper with one
    repair round; capability probe ("Test connection").
  - `src/core/`: 25 engine modules copied from the personal Worker (no personal data); `core/llm.ts` reading AI
    with a daily cap; `actions`, `agent`, `ask`, `slackui` trimmed to the public features.
  - `src/node/store.ts`: atomic, validated JSON key-value store with `.bak` fallback.
  - `src/cli.ts`: headless `sync` / `test-ai` (verified live with Mistral via the OpenAI-compatible adapter).
  - Tests: 114 pass (ported engine suites, chaos with a fake LLM, oracle, adapters, store).
- **P2 code done** (on main, CI green). The live Google test (the done-criterion) is postponed by the user.
  - `src/google/oauth.ts`: the student's "Desktop app" client JSON, loopback redirect on 127.0.0.1 + PKCE,
    scope `calendar.app.created` (Duely only sees the calendar it creates), cached access tokens.
  - `src/node/secrets.ts`: secrets encrypted through an injected cipher (Electron `safeStorage`); refuses
    to save without a keychain; Linux `basic_text` backend is flagged (`weakKeychain`) for the UI to warn.
  - `src/node/runner.ts`: the Worker's cron flow for one computer: full sync every 10 min, announcement
    feeds every 3 min, health alerts (fail once / recovered / feed broken / AI failing), digests and test-eve
    briefings with wider windows so they catch up after sleep, 300 calendar writes per run cap.
  - `src/main/`: `services.ts` (deps: store, secrets, LLM, Google, notifications), `jobs.ts` (1-min tick,
    wake on resume/unlock or a long tick gap), `tray.ts` (Open / Sync now / Start at login / Quit; Linux
    autostart file), `index.ts` (single instance, close hides to tray, IPC). Renderer = temporary setup
    panel until P3.
  - Fixed on the way: the sandboxed preload was built as ESM and never loaded (P0 bug); smoke now checks
    the bridge works. Linux without a notification daemon froze the app ~25 s per notification (libnotify);
    now checked over D-Bus first (`gdbus`, async).
  - Defaults: `tz: ""` (computer's zone, was hardcoded Toronto), `phone_alerts: true` (important
    announcements notify), `notifications` (unset = on).
  - Tests: 129 pass (runner against an in-memory Google Calendar, OAuth loopback round trip, secrets).
- **For P7 docs**: a Google client left in "Testing" gets refresh tokens that expire after 7 days. The
  guide must have students publish the consent screen ("In production"; unverified is fine for themselves).
- **P3 UI built** (branch `p3-ui`), from the owner's design spec (calm/premium, Linear / Notion Calendar feel,
  strict motion rules). Plan: `~/.claude/plans/rippling-greeting-kitten.md`.
  - Vanilla TS + CSS (no framework), Inter bundled, Lucide icons; teal accent from the app icon; warm neutrals;
    light/dark from the OS; dates/times in the computer's locale (Chromium's UI locale can differ: en-GB for en-CA).
  - `src/main/api.ts` (IPC, `{ok,value}|{ok,error}`), `src/node/view.ts` (Upcoming groups, questions, chat
    rows), `src/node/settings.ts` (settings <-> config, validation, plain-language AI errors), `src/shared/types.ts`.
  - Screens: onboarding (5 steps, compact window), Upcoming (questions capped at 2 + "N more", Today / This week /
    Next week rows on a subgrid, done animation + Undo toast, Filtered out), Chat (wired to the real chat engine,
    listed items as rows, proposal buttons), Settings (Sources, AI + Test connection, Notifications, Study &
    digests, Google). Banners for Google / sync / weak keyring.
  - Engine fixes found on the way: `serial()` crashed on a saved item missing a date field (broke every sync);
    "Midterm Review Session" / "Final Project - Due" were classed as exams; a quiz whose description mentions the
    midterm became an exam (the title decides first now).
  - Dev: `scripts/demo-data.ts` makes a demo data folder dated around today; `DUELY_SHOT` / `DUELY_SHOT_JS` /
    `DUELY_SHOT_SIZE` / `DUELY_THEME` env vars capture screenshots (xvfb only).
  - AI is required: onboarding step 3 can't be skipped (Continue after a passing Test connection); later, if the
    provider/model/URL/key change without a new passing test, Upcoming and Chat show "Finish setting up your AI".
    A passing test stores a fingerprint (`ai_verified`, a hash, not the key); `aiReady` in status.
  - Linux without a working keyring: start with `--password-store=basic` (+ plain-text encryption allowed) so keys
    can be saved at all; the weak-keyring banner warns. Checked by calling the Secret Service (`main/keyring.ts`).
  - Terms of Service + Privacy Policy (`docs/TERMS.md`, `docs/PRIVACY.md`), bundled in the app (sheet viewer),
    agreed at onboarding step 1 (`terms_accepted` {version, at}; `TERMS_VERSION` in components/doc.ts), linked in
    Settings → About. The owner wanted explicit no-responsibility for API key leaks and billing (Terms §3).
    Governing law / jurisdiction intentionally left out (owner's call).
  - Not yet: Slack (P6), screenshot import (P5), chat history persistence, the live Google test.

## Plan change: P6 is Discord alerts by DM from a hosted Duely bot (was Slack)
Owner's call (twice): alerts only, no chat; Discord, not Slack; and as **DMs from one Duely bot**, so students
create nothing (option 1, chosen over a student-made webhook or a student-made bot).
Discord rules that shape it: only a bot can DM, and only someone it shares a server with (and who allows DMs from
that server's members). A bot token can't ship inside the app, so this needs a relay.
- **Connect:** Settings → Notifications → Connect Discord opens Discord OAuth (scopes `identify` + `guilds.join`)
  in the browser (loopback, like Google). The relay exchanges the code (it holds the client secret), adds the user
  to the official Duely server (so a DM is allowed), and returns a random device token to the app.
- **Relay:** a Cloudflare Worker (the owner already has an account; free tier). Holds the bot token and the client
  secret. Stores only {sha256(device token) -> Discord user id}. `POST /alert` {token, text}: opens a DM and sends it;
  the text is never stored. Per-token rate limit and size cap; split at 2000 chars. `DELETE /link` to disconnect.
- **App:** device token kept as the `discord_link` secret; the same alerts as desktop notifications; "Send test
  alert"; clear errors when the DM is refused (DMs from server members turned off, left the Duely server).
- **Privacy Policy rewrite when it ships:** alert text passes through the relay (not stored); the relay keeps the
  Discord user id and the hashed token; how to disconnect and have the link deleted.
- **Owner must do:** create the Discord application + bot and the Duely server, put their ids/secrets in the Worker,
  approve the deploy.
- **Duely Discord server created** (owner's account, via Chrome): name "Duely", app icon, server id
  `1558321208481685534` (the relay's `guilds.join` target). Still to do: @everyone read-only (no Send Messages,
  threads, attachments, reactions, voice, invites), default notifications = mentions only, remove the voice
  channel, a welcome note in #general. The browser tab stopped responding mid-way; nothing was saved there.
- **Members = verified app users only** (owner's requirement). Enforced: (1) no invites at all; the only way into
  the server is the relay's `guilds.join` during the app's Connect Discord sign-in; (2) hourly relay sweep removes
  any member not in the link table (needs the bot's Server Members intent); (3) each app checks in daily
  (`POST /seen` with its token); links unseen for 30 days are deleted and the member removed; Disconnect removes at
  once; (4) Connect Discord only shows when `aiReady` (connection test passed); (5) Discord verification level
  "verified email" + explicit content filter. Not enforceable without collecting keys: proof that a working API
  key exists (the app is open source and local); deliberately not done, since keys must never reach the relay.
  The Privacy Policy rewrite must mention the daily check-in and the 30-day removal.

## P3.5 cloud engine (plan approved; `~/.claude/plans/rippling-greeting-kitten.md`, `docs/PLAN-cloud-engine.md`)
Phase 0, offline half, done:
- Host features made swappable in the engine, no desktop behaviour change: UTC offsets (`setOffsetSource`, the one
  source for all zone math; `ask.ts` dstShift now uses it), SHA-1 (`setSha1Source`), query strings (`qs`), host time
  zone (`Deps.defaultTz`).
- `src/gas/main.ts`: UrlFetchApp fetch, Utilities offsets/SHA-1, chunked script-properties store (9 KB values,
  old chunks removed), `duelyTick` (10-min trigger; schedule kept in properties), `duelySetup`, `duelyStop`;
  alerts go to an `outbox` (desktop shows them) and email when `email_alerts`.
- `scripts/build-gas.ts` (`npm run build:gas`): one `out/gas/Code.js` (~130 KB) + `appsscript.json` (scopes:
  calendar.app.created, external_request, scriptapp, send_mail, userinfo.email).
- `test/gas.test.ts`: the bundle in a sandbox WITHOUT Intl/fetch/URL/crypto/timers and with Apps Script's property
  limits syncs the sample feed to exactly the same events/hashes as the desktop engine; trigger setup/stop;
  chunking; AI requests for all three provider types well-formed through UrlFetchApp. Mutation-checked.
Phase 0, live half (needs the owner: a test Google account + approving Google's screens): install via the Apps
Script API, the one-time approval, the shared channel (web app first), Sync now, real run times vs the 6-min limit,
and confirming Apps Script's V8 settles the engine's promises (UrlFetchApp is synchronous) as the sandbox does.
Note: with calendar.app.created the script can only manage calendars IT made, so the script owns the calendar
(single writer); the desktop's own calendar is only for the no-script fallback.

Phase 0, live half, in the throwaway test account (zaidahmad181818@gmail.com, Cloud project duely-511212):
- 1 install via the Apps Script API from the student-style sign-in ✓ (script.projects/deployments/processes scopes)
- 2 one-time approval: the student clicks Run on duelySetup and approves Google's screens ✓
- 5 engine inside Apps Script ✓: promises settle (the trigger awaits them), no Intl needed (offsets from
  Utilities.formatDate), first full sync 5.8 s, unchanged syncs ~2 s. Calendar MUST go through the Calendar
  advanced service (manifest dependency); the REST API from the script failed 403 (hidden default Cloud project).
- 3 channel ✓: a web app with "Execute as me" + "Only myself" returns 401 to an OAuth call unless the token has a
  Drive scope (too much to ask students), so: access ANYONE_ANONYMOUS + a 256-bit channel key (script property,
  set by duelySetup from the uploaded Config file; constant-time check). No key / wrong key -> "not allowed".
- 4 Sync now ✓: doPost op "sync" queues a one-off trigger, ran ~1.5 min later, removed itself; desktop sees it.
- Found live and fixed (tests added): a Node-only `process` reference crashed the error path in Apps Script.
- Setup-guide findings: the Audience "Add users" Save needed a second click; "Publish app" stays disabled until
  the Branding page is complete (check what it needs before telling students to publish).
- 10-min timer ✓: duelyTick ran by itself (TIME_DRIVEN) at 12:56:55 UTC, 1.3 s.
- AI live ✓ (free Gemini key from AI Studio, test account): inside Apps Script the AI read a test announcement
  ("midterm moved to Mon Oct 21 2030, 6-8 PM, SA 302") into "[COMP 2401] Midterm exam (from announcement), 6-8pm,
  Southam Hall SA 302" in the calendar; a no-date post gave nothing. The feed-sorting call got Gemini 503 (model
  overloaded): rules took over, the sync finished (26.6 s), and the "AI reading isn't working" alert was queued.
  Follow-up for Phase 1: retry 503s once with a short backoff (Utilities.sleep) and/or fall back to
  gemini-flash-latest. Default Gemini model suggestion is now `gemini-flash-latest` (always current).
- Still open: email alerts live (needs a key in the
  test script); laptop-off test over hours.
