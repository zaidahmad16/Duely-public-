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
- **P2 code done** (branch `p2-google-sync`); waiting on the live Google test (the done-criterion).
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
- **For P3**: proposals (vanished items, study blocks) are stored but not shown anywhere yet.
