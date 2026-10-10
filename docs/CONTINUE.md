# Continue here (handoff for a fresh session)

Read this, then `docs/PROGRESS.md`, then the plan at
`~/.claude/plans/open-in-documents-github-syllabus-and-virtual-popcorn.md` (milestones P0–P7).

## What this repo is
Public, multi-student version of Duely (`github.com/zaidahmad16/Duely-public-`, local `~/Documents/GitHub/Duely-public`).
Desktop-only Electron + TypeScript app: Brightspace calendar feed → Google Calendar, with ONE LLM API of any type
(OpenAI-compatible / Anthropic / Gemini). The personal version (`~/Documents/GitHub/Syllabus`, Cloudflare Worker)
is separate and must stay untouched; code is copied from it, never personal data.

## Decisions already made (don't re-ask)
- Desktop only, no Cloudflare. Windows + Mac + Linux. Electron + TypeScript.
- One LLM API "any type with requirements": tools → chat agent, JSON → reading, vision → screenshots.
  Missing capability = that feature falls back (rules lists / typed-in form / reading off).
- Desktop notifications + optional Slack via Socket Mode (P6).
- Each student brings their own Google OAuth client (with a guide).
- Keep: chat, announcement reading, timetable + exam screenshots, study blocks + digests + briefings.
- Cut: email reading, reminders, self-test/sweep harness, learner/memory, watchdog.
- Secrets (LLM key, Google/Slack tokens) via Electron `safeStorage`, never plain JSON.

## Standing rules
- No AI attribution / Co-Authored-By lines in commits.
- Ask before anything that changes the student's calendar/data (propose → wait for yes).
- Never simulate input on the user's desktop; GUI tests run in xvfb.
- Nothing school-specific hardcoded (course-code pattern, academic-dates URL, tz from OS).
- Atomic, validated writes; verify live before telling the user something works; fix the class of bug.
- Never print or commit API keys. For live LLM tests, the personal Mistral key can be passed via env:
  `DUELY_API_KEY=$(python3 -c "import json;print(json.load(open('/home/zaid/.config/syllabus/config.json'))['mistral_key'])") DUELY_PROVIDER=openai DUELY_BASE_URL=https://api.mistral.ai/v1 DUELY_MODEL=ministral-14b-latest`

## State (2026-10-09)
- `main`: P0 scaffold (ad8667d), CI green on 3 OSes.
- Branch `p1-engine-port` (pushed, d39179a): P1 complete. 114 tests pass, `tsc --noEmit` clean.
  Live: `cli.ts test-ai` (Chat ✓ Reading ✓ Screenshots ✗ on ministral) and `cli.ts sync --feed test/fixture.ics` work.
- TODO first: check CI on `p1-engine-port` (`gh run list -b p1-engine-port`), then merge to main.

## Commands
- `npm test` · `npm run typecheck` · `npm run build` · `npm run smoke` (xvfb on Linux)
- Headless: `node --experimental-strip-types --no-warnings src/cli.ts sync --feed test/fixture.ics --dir <tmpdir>`
  and `... src/cli.ts test-ai`
- Stack notes: electron-vite 5 needs vite 7; tests use node:test with `--experimental-strip-types`, `.ts` imports.

## Layout
- `src/llm/` types, adapters (`makeLLM`), json (`askJSON`), probe (`probe`, `describeCaps`)
- `src/core/` engine copied from the Worker; `core/llm.ts` = `AICtx {store,cfg,tz,fetch,llm?}`, `llmJSON` with daily cap
- `src/node/store.ts` `fileStore(dir)` (same `Store` get/put interface as KV)
- `src/cli.ts` headless runner; `src/main|preload|renderer` Electron shell (still the P0 empty window)
- `test/helpers.ts` `llmFromRun` / `llmOverFetch` fakes; `test/fixture.ics` sample feed (no personal data)

## Next: P2
Google OAuth (loopback redirect + PKCE, student's own client JSON) in `src/google/`; Calendar push using
`core/gcal.ts`; `src/main/jobs.ts` scheduler (sync, announcements, digests, briefings) with catch-up after
sleep/wake (`powerMonitor`); tray (Sync now / Open / Quit, start at login optional); desktop notifications;
`safeStorage` secrets. Done when a test account's calendar fills from the sample feed (needs the user's
Google OAuth client + a throwaway test calendar — ask for those).
Then P3 UI, P4 chat, P5 announcements + screenshots, P6 Slack, P7 packaging.
