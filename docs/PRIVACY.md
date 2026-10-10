# Privacy Policy

**Effective:** October 9, 2026

Duely is a desktop app that puts your Brightspace deadlines, tests and classes in Google Calendar and answers questions about them with an AI provider you choose. This policy explains what Duely does with your information. The short version: **Duely runs on your computer. There is no Duely account, no Duely server, and nothing is sent to the people who make Duely.**

## What Duely does not do

- It doesn't have accounts, servers or a cloud backend run by its developers.
- It doesn't collect analytics, usage statistics, telemetry or crash reports.
- It doesn't sell, rent or share your information with anyone.
- It doesn't show ads.

## What Duely keeps on your computer

Duely stores its data in a folder on your computer:

- **Windows:** `%APPDATA%\Duely`
- **macOS:** `~/Library/Application Support/Duely`
- **Linux:** `~/.config/Duely`

That folder holds:

- your settings, including your Brightspace calendar link and announcement links (these links contain a private token from your school);
- the deadlines, tests, classes and events Duely read from Brightspace, and which ones you marked done;
- the questions Duely asked you (for example, whether to keep an item that disappeared) and your answers;
- for chat, your last few messages and Duely's replies, so follow-up questions make sense;
- a cache of announcements it has already read, a count of today's AI requests, and a short log of recent errors.

**Keys and sign-ins** (your AI API key, your Google sign-in, and later your Discord link) are encrypted with your operating system's keychain: Keychain on macOS, Data Protection (DPAPI) on Windows, and the Secret Service keyring on Linux. If a Linux computer has no keyring, Duely falls back to Electron's basic storage, which only lightly protects them, and tells you so in the app.

## Security

Duely protects what it stores as described above, but no software or storage is perfectly secure. Duely's developers are not responsible for any API key, sign-in, link or other information that is exposed, leaked or misused, or for any charges that result (see section 3 of the [Terms of Service](TERMS.md)). Keep your computer secure, don't share your data folder, set a spending limit with your AI provider, and revoke a key straight away if you think it was exposed.

## What Duely sends, and where

Duely connects only to the services you set up, directly from your computer:

| Service | What Duely sends or receives | Why |
|---|---|---|
| **Your school's Brightspace** | Downloads your calendar feed and the announcement feeds you added, using the links you pasted. | To find your deadlines, tests, classes and news. |
| **Google Calendar** (your Google account, through the Google Cloud client you created) | Creates one calendar for Duely and adds, updates and removes events in it. | To put your schedule in your calendar. |
| **Your AI provider** (OpenAI-compatible, Anthropic or Google Gemini, with your own API key) | Course codes, titles, dates and descriptions of your Brightspace items; the text of course announcements; your chat messages with the items they're about; and any screenshot you choose to import. | To sort the feed, read announcements for dates, answer your questions and read screenshots. |
| **Discord** (optional, coming later; only if you connect it) | The text of your alerts (for example a moved test, an important announcement, or your morning digest), sent to you as a direct message. This section will explain exactly how before the feature ships. | So your alerts reach you on your phone too. |

Each of these services handles the information it receives under its own terms and privacy policy, which you agreed to when you set up your account with it. In particular, check what your AI provider does with API requests (for example, whether it keeps or trains on them); many providers let you change this. A local model (such as Ollama or LM Studio) keeps everything on your computer.

## Google user data

Duely asks Google only for permission to **create and manage the calendars Duely itself creates** (`calendar.app.created`). It cannot read, change or delete your other calendars or events. Data from Google stays on your computer and is used only to keep Duely's calendar up to date; it isn't sent to the developers, sold, or used for advertising.

Duely's use and transfer of information received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Your choices

- **Disconnect Google** in Settings → Google. Duely revokes its access with Google. The calendar it created stays in your Google account until you delete it there.
- **Change or remove your AI key** in Settings → AI, or revoke it on your provider's website.
- **Turn off notifications** in Settings → Notifications.
- **Delete everything:** quit Duely, uninstall it, and delete the data folder listed above. You can also remove Duely's calendar in Google Calendar and revoke its access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Children

Duely is made for college and university students. It isn't intended for children under 13.

## Changes

If this policy changes, the new version will be published in Duely's repository and included in the next version of the app, with a new effective date.

## Contact

Questions or concerns: open an issue at [github.com/zaidahmad16/Duely-public-](https://github.com/zaidahmad16/Duely-public-/issues).
