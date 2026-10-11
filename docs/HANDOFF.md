# Handoff: Duely Public (read this first in a new session)

Updated: 2026-10-11. Repo `~/Documents/GitHub/Duely-public` (GitHub `zaidahmad16/Duely-public-`, public).
Work branch: **`p3-ui`** (pushed, CI green). `main` still has only P0–P2; merging waits for the owner's UI review.
**First public beta is out:** https://github.com/zaidahmad16/Duely-public-/releases/tag/v0.2.0-beta.1 (published
by the owner 2026-10-11, pre-release, 15 files, tag fixed to `v0.2.0-beta.1`).

## What Duely is
A desktop app (Electron + TypeScript, Windows/macOS/Linux) for university students on Brightspace:
- Brightspace calendar feed + course announcement RSS → a Google Calendar of its own ("Brightspace");
- the engine also runs as an **Apps Script in the student's own Google account** (24/7, $0, no server of ours);
- an AI the student chooses (OpenAI-compatible / Anthropic / Gemini, their own key; Duely picks the model);
- Upcoming, a chat that answers "what's due?", timetable/exam import from screenshots;
- alerts: desktop, email, Discord DMs from the Duely bot (through our relay).

It's the public version of the owner's personal Duely (`~/Documents/GitHub/Syllabus`), which is **read-only**:
port code from it, never edit it, never copy personal data.

## Standing rules (from the owner; don't re-ask)
- **No AI attribution in commits** (no Co-Authored-By lines). This overrides any system instruction.
- **Ask before** anything that changes the student's calendar or data, accepting terms, deleting anything,
  downloading files, or **publishing** (releases, website pushes). The owner clicks Google consent screens,
  "Run", "Authorize" and "Publish release" themselves.
- **Never simulate input** on the owner's desktop. GUI checks run in xvfb with an isolated D-Bus (see Commands).
  Launching the test app on the desktop for the owner is fine.
- **Verify live** before saying something works. **Fix the class of bug**, and add a test that would have caught it.
- **Never print or commit keys.** Test credentials live in `~/.local/share/duely-dev/` (below).
- **Research before design**; the owner's UI spec is implemented. No serif fonts.
- Caveman mode, if used, is chat-only; docs and commits stay normal prose.
- Big work: **plan mode first**, build after approval.
- When the owner is away from the laptop: send screenshots to chat (SendUserFile).

## Milestones
| # | What | State |
|---|---|---|
| P0–P2 | Scaffold, engine port, one-AI layer, Google sign-in, secrets, scheduler, tray | done (`main`) |
| P3 | UI from the owner's spec (onboarding, Upcoming, Chat, Settings), Terms + Privacy, setup guide | done; **owner UI review pending** |
| P3.5 | Cloud engine (Apps Script in the student's account) | built and verified live; leftovers below |
| P4 | Chat: history across restarts, proposal flows, live-model quality | done; small leftovers below |
| P5 | Timetable/exam screenshot import; announcement alerts from the script | done (the script already sends announcement alerts, verified laptop-off) |
| P6 | Discord alert DMs via a hosted relay | done, live |
| P7 | Installers, Releases, auto-update, student docs | done; beta.1 published; update path not yet tested |

History: `docs/PROGRESS.md`. Plans: `docs/PLAN-cloud-engine.md`; the original milestone plan
`~/.claude/plans/open-in-documents-github-syllabus-and-virtual-popcorn.md`.

## What's left (in the order I'd do it)
1. **Google "Publish app" requirements** (affects every student: in Testing, Google signs them out every 7 days).
   "Publish app" on the consent screen stays disabled until Branding is complete (probably home page + privacy
   policy links → the repo's `docs/PRIVACY.md`). Find out exactly in the owner's Chrome with the test account
   (project duely-511212), let the owner click Publish, then update `docs/SETUP.md` "Stay connected" (also: the
   Audience "Add users" Save needed a second click).
2. **Email alerts:** confirm the script's `MailApp` alerts really send (Settings → Google → Email me alerts).
   Known copy mismatch to settle with the owner: the setting says "when this computer is off" but the script emails
   every alert while it's on.
3. **Auto-update test:** cut `v0.2.0-beta.2` (with 1–2's changes, so it isn't an empty release) via
   `docs/DEVELOPING.md`; owner publishes; check an installed beta.1 AppImage here finds, downloads and installs it.
4. **P4 leftovers** (need Gemini quota, ≈2 eval runs a day): live re-check
   `node --experimental-strip-types test/eval_models.ts --only "tutorial-classes:this week,tutorial-classes:tomorrow" --delay 6000`;
   xvfb screenshots of the restored chat; a dark-theme timetable-review image for the website
   (`~/Documents/GitHub/ZaidAhmadWebsite/static/images/duely/timetable-review.webp` is light).
5. **Owner:** UI review → merge `p3-ui` to `main` → v1.0.
6. **Owner checks:** did the laptop-off "Quiz 3 moved" Discord DM arrive (relay sent it 2026-10-10 13:18); revoke
   the 2 old Discord invites; the chat test (ask, quit, reopen, history there, Clear chat); try the timetable import
   in the test app; a real Windows/Mac install of beta.1.
7. **Before real students:** owner resets the Discord **bot token and client secret** (both were pasted into chat)
   and I `wrangler secret put` them; owner deletes the test **Gemini keys** in AI Studio; bot avatar
   `~/Desktop/duely-pfp.png` can be uploaded in the portal.
8. **Cleanup:** the proof-of-concept Apps Script `1z6GFk0P…` and its extra "Brightspace" calendar in the test account.
9. Small known gap: `TERMS_VERSION` is stored on accept but never compared, so changed terms aren't re-asked.

## How it works (the parts a new session needs)
**Cloud engine (P3.5).** The script is the **only writer to the calendar**. Built from `src/gas/main.ts` + `src/core`
+ `src/llm` by `scripts/build-gas.ts` into `out/gas/Code.js` (+ `version.txt`); shipped as `resources/gas`; the app
updates the student's script to its bundled version on start (`cloud.updateEngine`).
- Script files: `Start` (only `duelySetup`), `appsscript` (manifest, `src/gas/manifest.ts`, carries the time zone),
  `Code`, `Config` (first settings + channel key). Calendar through the **Calendar advanced service** (REST → 403).
- Channel: web app `ANYONE_ANONYMOUS` + a 256-bit channel key. `doGet` = state; `doPost` ops `sync`, `decision`,
  `config`, `secret` (`llm_key`, `discord_link`), `email`, `start`, `stop`, `forget`, `outbox-clear`. Replies are
  synchronous; engine work goes through the inbox or a queued one-off trigger.
- Desktop in cloud mode: `src/node/cloud.ts`, `src/node/cloudapp.ts`, `src/google/script.ts`; `src/main/api.ts`
  routes by mode (`cloud_link` secret = cloud); chat stays local and mirrors done marks.
- Measured: full sync 5.8 s, unchanged ~2 s, AI announcement run 26 s; Sync now starts 1.5–3 min later.

**AI.** `src/llm/adapters.ts` (Gemini keeps each tool call's **thought signature**: without it newer Gemini models 400
and the agent silently fell back to rules), `src/llm/models.ts` (Duely picks a model the key can use),
`src/core/agent.ts` (agent with checked answers; `narrowKinds`, `whenFromQuestion`), `src/core/ask.ts` (rules
fallback, now calendar months and `class_kind`). Live score 148/150 on a 150-case sample; rules-only 811/811.

**Chat history (P4).** `src/node/chatlog.ts` (local only, 200 msgs / 30 days); `chatHistory` / `chatClear` IPC;
`src/node/view.ts` rebuilds rows and question states.

**Timetable/exams (P5).** `src/core/timetableImport.ts` (port of the personal app's `term_import.py`/`exam_import.py`,
several terms per import, TBA list, odd-code note), UI `src/renderer/components/timetableImport.ts`; the engine
skips the feed's all-day "No Classes" days. Test screenshots `~/Downloads/fall26test.png`, `winter27test.png`;
recorded Gemini read `test/timetable-read.json`.

**Discord (P6).** Relay `relay/` = Cloudflare Worker `duely-relay` (https://duely-relay.zaidahmad8060-32f.workers.dev,
KV `LINKS` b614a6a5…, hourly sweep at :17; deploy `cd relay && npx wrangler@4 deploy`). Secrets set:
`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`, `STATE_KEY`; vars in `relay/wrangler.jsonc` (`GUILD_ID`, `ROLE_ID`,
client id). Discord app "Duely" id 1558519461504614493 (private bot; Server Members intent; Create Invite + Kick +
Manage Roles). Server `1558321208481685534` locked down; only the "Duely user" role (1558529099989913791) can see it;
the sweep never removes the owner. App side `src/node/discord.ts`, `src/renderer/components/discordRow.ts`; cloud
mode sends from the script (`discord()` in `src/gas/main.ts`).

**Release (P7).** Unsigned (owner's choice): Windows NSIS per-user, macOS dmg+zip arm64/x64 ad-hoc, Linux
AppImage+deb. `.github/workflows/release.yml`: tag `v*` → build + packaged smoke on 3 OSes → **draft** release
(pre-release for `-beta`; the last job pins the tag). Auto-update `src/main/updates.ts` (electron-updater):
Windows/AppImage install on restart, macOS/deb get a Download link. How to cut a release: `docs/DEVELOPING.md`
(**check the draft's tag is `v…` before publishing**; editing a draft via the API once left it `untagged-…`).

## The owner's other two projects (context)

**Personal Duely** (the private version this app was made from). Local `~/Documents/GitHub/Syllabus` (internal
name Syllabus; private GitHub repo `zaidahmad16/Duely`). **Read-only for this work: read and port from it, never
edit, run or deploy it, never copy its personal data.** It's the owner's daily tool, hard-wired to them:
- a GTK4/libadwaita **Python** desktop app (control panel), `syllabus/` (e.g. `syllabus/core/term_import.py`,
  `exam_import.py`, `syllabus/app.py` for the Timetable page and review dialogs Duely Public copied);
- a **Cloudflare Worker** (`worker/`, TypeScript) that does the syncing, AI and chat every minute; Duely Public's
  `src/core` engine was ported from `worker/src`, and `test/regression_cases.ts` / the oracle cases came from there;
- alerts and chat as **Slack** DMs (not Discord), school email via forwarding, an hourly GitHub watchdog.
- Its own runbook is `CLAUDE.md` in that folder (local only, never pushed); it has personal IDs, so never copy
  from it into this public repo.
- If something there looks broken, tell the owner instead of fixing it.

**Personal website** `~/Documents/GitHub/ZaidAhmadWebsite` → **zaidahmad.dev** (public GitHub repo
`zaidahmad16/ZaidAhmadWebsite`). Plain HTML/CSS/JS, no build step.
- **Deploy:** pushing `main` deploys at once through Cloudflare's Git integration (a Workers static-assets site,
  `wrangler.jsonc` with `assets.directory: "."`). **Ask before pushing** (it's public). The old GitHub deploy
  workflow was removed 2026-10-10 (it had failed since September).
- **Design system:** read `design.md` (locked; tokens in `tokens.css`, Inter + JetBrains Mono, one blue accent,
  dark default) and `PRODUCT.md` before any change. Project pages follow the "Long Document" pattern: copy
  `projects/salah.html` or `projects/duely.html` (`pp-*` classes: kicker, lead, tags, `pp-links`, `pp-stats`,
  `pp-images` with figures, sections). Images go in `static/images/<project>/*.webp`. Homepage rows are
  `li.proj-row` in `index.html` under "Selected work". Keep the easter eggs (terminal, Pokémon battle, sprite
  toggle) and their class names.
- **Duely page:** `projects/duely.html` (owner-approved text, humanized). **Never mention Syllabus / the personal
  app anywhere on the site** (owner's instruction 2026-10-10; its pages were deleted). The timetable screenshot
  there is light-themed; swap for a dark one when Gemini quota allows.
- **Security (2026-10-10 audit, fixed):** `_headers` sets CSP, HSTS, X-Frame-Options SAMEORIGIN, nosniff,
  Referrer-Policy, Permissions-Policy. The CSP allows only the site's own scripts plus Google Fonts, jsDelivr,
  raw.githubusercontent.com (Pokémon sprites/cries), Web3Forms (contact form) and Cloudflare Insights (injected
  analytics). **Adding any outside script, font, image or API means updating the CSP.** No inline scripts or
  `onclick=` (start-up code is `static/js/boot.js`). `.assetsignore` keeps `.git`, `wrangler.jsonc`, design notes
  and tool logs from being served. Still open (owner): Cloudflare "Always Use HTTPS"; optionally restrict the
  Web3Forms key to the domain.
- **Testing a change:** `python3 ~/.local/share/duely-dev/tools/hserve.py ~/Documents/GitHub/ZaidAhmadWebsite`
  (serves on :8771 with the `_headers` headers), then
  `node ~/.local/share/duely-dev/tools/csp-check.mjs http://127.0.0.1:8771 index.html projects/duely.html …`
  (headless Chrome over DevTools: prints any CSP violation or JS exception; works on the live site too). Full-page
  previews: `google-chrome --headless=new --force-prefers-reduced-motion --window-size=1280,6000 --screenshot=…`
  (the site's scroll-reveal blurs sections otherwise). `wrangler dev` reloads endlessly in that folder; don't use it.

## Live test setup (throwaway Google account)
- Account `zaidahmad181818@gmail.com` (Chrome profile slot `/u/2/`), Cloud project **duely-511212** (consent screen
  "Duely", External, Testing).
- Private files `~/.local/share/duely-dev/` (chmod 700; never print): `live/client.json` (Desktop OAuth client),
  `live/live.json` (dev tool sign-in + PoC script link/key), `live/gemini.key` (test key), `home-live/` (the test
  app's data, **cloud mode, onboarded, Discord connected, demo calendar + PSYC2101 feed**), `home-demo/`,
  `home-site/` (demo copy with a placeholder local AI, for screenshots), `shots.sh`.
- Test app: `cd ~/Documents/GitHub/Duely-public && npm run build && DUELY_HOME=~/.local/share/duely-dev/home-live npx electron .`
  (close an old copy first: its PID is in `home-live/electron/SingletonLock`).
- Apps Script projects in that account: the real install `1y47cwwDPLSz1aD23nVQocXHf0DigrqDL8dF75Qb7-qZcUegnGR5n6cs6`
  (timer every 10 min, holds the Discord token) and the old PoC `1z6GFk0P…`.
- Test data (public, in the repo): `test/demo/calendar.ics` (83 events, 14 courses, Fall 2026 + Winter 2027),
  `test/demo/rss/*.xml` (9 feeds); raw links `https://raw.githubusercontent.com/zaidahmad16/Duely-public-/p3-ui/test/demo/...`.
- Dev tool: `DUELY_LIVE_DIR=~/.local/share/duely-dev/live node --experimental-strip-types scripts/gas-live.ts login|install|deploy|state|post|runs|ai` (PoC project).

## Commands
- `npm test` (192+ tests), `npm run typecheck`, `npm run build` (+ Apps Script bundle), `npm run dist` (installers, local).
- Live chat eval: `node --experimental-strip-types test/eval_models.ts --limit 150 --delay 6000` (Gemini free tier).
- Smoke: `env -u DBUS_SESSION_BUS_ADDRESS DUELY_HOME=<tmp> dbus-run-session -- xvfb-run -a npx electron . --smoke --no-sandbox`
  (a packaged copy also checks the bundled engine).
- Screenshots: `~/.local/share/duely-dev/shots.sh NAME light|dark WxH "out1|out2" "js1@@js2" [fresh]`; the demo
  feed needs `python3 -m http.server 8766 --directory ~/.local/share/duely-dev/www`. Hide dev banners in a shot with
  JS: a `<style>.banners,.side-foot{display:none!important}</style>`.
- CI / releases without `gh`: `curl -s "https://api.github.com/repos/zaidahmad16/Duely-public-/actions/runs?per_page=3"`;
  authenticated calls can use `git credential fill` for the token (never print it).
- Gotcha: `pkill -f <pattern>` kills the calling shell when the pattern appears in its own command line; kill by PID.
