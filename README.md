# Duely

Your course assistant for Brightspace (D2L) schools. Duely puts your deadlines, tests and classes in Google
Calendar, reads course announcements for new dates, and answers "what's due this week?" with an AI provider you
choose (OpenAI-compatible, Anthropic or Google Gemini; local models through Ollama or LM Studio work too).

It runs on **Windows, macOS and Linux**, and it's free and open source. There's no Duely account: your data stays
on your computer and in your own Google account.

> **Beta.** Duely is new. Always check important dates against your course outline and Brightspace.

## What it does
- Your Brightspace calendar in a Google Calendar of its own: assignments, quizzes, tests and events, updated
  every 10 minutes, even when your computer is off (with Duely in your Google account).
- Your weekly classes and final exams, from screenshots of your timetable.
- Course announcements read for new dates ("the midterm moved to…"), and an alert for the important ones.
- A chat: "what's due tomorrow?", "when is my next test?", "done lab report 2".
- Suggested study time before deadlines (nothing is added until you say yes), a morning digest and a briefing the
  evening before a test.
- Alerts on your desktop, by email, or as Discord messages on your phone.

## Download
Get the latest version from the **[Releases page](https://github.com/zaidahmad16/Duely-public-/releases)**:

| Your computer | Download |
|---|---|
| Windows | `Duely-Setup-….exe` |
| Mac with Apple silicon (M1 and later) | `Duely-…-arm64.dmg` |
| Mac with an Intel processor | `Duely-…-x64.dmg` |
| Linux | `Duely-…-x86_64.AppImage` (updates itself), or `Duely-…-amd64.deb` |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple silicon.

### The first time you open it
Duely isn't signed with a paid Apple or Microsoft certificate, so your computer asks once whether you trust it:

- **Windows:** "Windows protected your PC" → click **More info** → **Run anyway**.
- **macOS:** open the `.dmg` and drag Duely to **Applications**. Open it; if macOS says it can't check it, open
  **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to Duely, and confirm.
- **Linux (AppImage):** right-click the file → **Properties → Permissions → Allow executing**, then open it. Or run
  `chmod +x Duely-*.AppImage`. The `.deb` installs with your software center or `sudo apt install ./Duely-*.deb`.

Then follow the **[setup guide](docs/SETUP.md)**. It's also inside the app, on every setup step.

## Updates
Duely checks for new versions in the background. On Windows and with the AppImage, it downloads them and installs
them when you restart it (Settings → About → **Restart now**, or the tray menu). On macOS and with the `.deb`,
Settings → About shows **Download** when there's a new version.

## Terms and privacy
- [Terms of Service](docs/TERMS.md)
- [Privacy Policy](docs/PRIVACY.md)

You bring your own AI provider and key: the provider bills you, and you're responsible for the key and its charges
(see the Terms).

## Developers
See [docs/DEVELOPING.md](docs/DEVELOPING.md) to build Duely, run the tests, and make a release.

## License
MIT
