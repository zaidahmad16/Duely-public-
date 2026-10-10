# Privacy Policy

**Effective:** October 10, 2026

Duely is a desktop app that puts your Brightspace deadlines, tests and classes in Google Calendar and answers questions about them with an AI provider you choose. This policy explains what Duely does with your information. The short version: **Duely runs on your computer and, if you turn it on, in your own Google account. There is no Duely account, no Duely server, and nothing is sent to the people who make Duely.**

## What Duely does not do

- It doesn't have accounts or a cloud backend run by its developers. ("Duely in your Google account", below, runs in *your* Google account, not ours.) The one exception is the small **Discord relay**, used only if you connect Discord (see "Discord alerts" below).
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

**Keys and sign-ins** (your AI API key, your Google sign-in, and your Discord link if you connect it) are encrypted with your operating system's keychain: Keychain on macOS, Data Protection (DPAPI) on Windows, and the Secret Service keyring on Linux. If a Linux computer has no keyring, Duely falls back to Electron's basic storage, which only lightly protects them, and tells you so in the app.

## What Duely keeps in your Google account (if you turn it on)

So your calendar stays up to date while your computer is off, Duely can install a small Apps Script project named **"Duely"** in your own Google account (you approve it once on Google's own screen). It runs on Google's servers under your account, every 10 minutes. Only you can see or edit it, and its developers have no access to it. Duely offers this during setup and in Settings → Google; you can skip it and keep everything on your computer.

When it's on, the script keeps these in its own storage in your Google account (Apps Script "script properties"):

- your settings, including your Brightspace calendar link and announcement links;
- **your AI API key**, so it can read announcements while your computer is off;
- the deadlines, tests, classes and events it read, which ones you marked done, its questions and your answers, a cache of announcements already read, a count of today's AI requests, and a short log of recent runs and errors;
- alerts waiting for the app to show them as notifications;
- a random 256-bit key that the app uses to talk to the script.

The app reaches the script through a private web link that only works together with that key. The app stores the link and key on your computer, encrypted like your other keys. The script's storage is protected by your Google account's security; it is not encrypted by Duely. Chat still runs on your computer.

## Security

Duely protects what it stores as described above, but no software or storage is perfectly secure. Duely's developers are not responsible for any API key, sign-in, link or other information that is exposed, leaked or misused, or for any charges that result (see section 3 of the [Terms of Service](TERMS.md)). Keep your computer secure, don't share your data folder, set a spending limit with your AI provider, and revoke a key straight away if you think it was exposed.

## What Duely sends, and where

Duely connects only to the services you set up, directly from your computer or, if you turned it on, from the script in your Google account (which then does the Brightspace, Google Calendar and announcement-reading work below, even while your computer is off):

| Service | What Duely sends or receives | Why |
|---|---|---|
| **Your school's Brightspace** | Downloads your calendar feed and the announcement feeds you added, using the links you pasted. | To find your deadlines, tests, classes and news. |
| **Google Calendar** (your Google account, through the Google Cloud client you created) | Creates one calendar for Duely and adds, updates and removes events in it. | To put your schedule in your calendar. |
| **Google Apps Script** (only if you turn on "Duely in your Google account") | The app creates and updates the "Duely" script project in your account, and sends it your settings, your AI key, and the items you mark done or answers you give. | So Duely keeps working while your computer is off. |
| **Gmail** (only if you turn on email alerts) | The script emails your alerts from your own Google account to your own address. | So alerts reach you anywhere. |
| **Your AI provider** (OpenAI-compatible, Anthropic or Google Gemini, with your own API key) | Course codes, titles, dates and descriptions of your Brightspace items; the text of course announcements; your chat messages with the items they're about; and any screenshot you choose to import (it's read once and not kept). | To sort the feed, read announcements for dates, answer your questions and read screenshots. |
| **Discord** (optional; only if you connect it) | The text of your alerts (for example a moved test, an important announcement, or your morning digest), sent through Duely's Discord relay to the Duely bot, which sends it to you as a direct message. See "Discord alerts" below. | So your alerts reach you on your phone too. |

Each of these services handles the information it receives under its own terms and privacy policy, which you agreed to when you set up your account with it. In particular, check what your AI provider does with API requests (for example, whether it keeps or trains on them); many providers let you change this. A local model (such as Ollama or LM Studio) keeps everything on your computer.

## Google user data

Duely asks Google for these permissions, and uses each only for the reason given:

| Permission | Asked by | Used for |
|---|---|---|
| **See, create and manage the calendars Duely creates** (`calendar.app.created`) | the app and the script | Making Duely's own calendar and keeping its events up to date. Duely cannot read, change or delete your other calendars or events. |
| **Your email address** (`userinfo.email`) | the app and the script | The app: opening Google pages in the right account when you're signed in to several. The script: the address it sends your email alerts to. |
| **Create and update Apps Script projects** (`script.projects`, `script.deployments`) | the app | Installing and updating the "Duely" script in your account. It only touches the project it created. |
| **Connect to external services** (`script.external_request`) | the script | Downloading your Brightspace feeds and calling your AI provider. |
| **Manage its own triggers** (`script.scriptapp`) | the script | Its 10-minute timer and "Sync now". |
| **Send email as you** (`script.send_mail`) | the script | Email alerts to yourself, only if you turn them on. Duely never emails anyone else. |

Data from Google is used only to run Duely for you. It stays on your computer and in your own Google account; it isn't sent to the developers, sold, or used for advertising, and no person reads it.

Duely's use and transfer of information received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Discord alerts (optional)

If you click **Connect Discord**, you sign in with Discord and allow Duely to see your username and to add you to the **Duely** Discord server (Discord only lets a bot message people who share a server with it). The server is only for alerts: members can't post, and nobody can join it except through Duely.

Sending the alerts needs Duely's bot, and a bot's password can't be put inside an app, so this one feature goes through a small service run by Duely's developers: the **Discord relay** (a Cloudflare Worker; its code is in Duely's repository). It works like this:

- **What the relay keeps:** your Discord user ID and display name, a fingerprint (SHA-256 hash) of a random device token, and when it last heard from your copy of Duely. Nothing else: not your Discord sign-in, not your email, not your schedule.
- **What passes through it:** the text of each alert, on its way to Discord. It isn't stored or logged; Cloudflare keeps only basic request records (time, path, result) for a few days. Discord keeps the message in your DMs, under Discord's own privacy policy.
- **The device token** is kept on your computer (encrypted like your other keys) and, if Duely runs in your Google account, in the script's storage there, so alerts reach you while your computer is off. Your app and script check in with the relay once a day.
- **Automatic removal:** if the relay hasn't heard from your Duely for **30 days**, it deletes your link and removes you from the Duely server. Anyone in the server without a link is removed every hour.
- **Disconnect** (Settings → Notifications → Discord) deletes your link at the relay at once, removes you from the server, and deletes the token from your computer and your Google account. Leaving the Duely server in Discord has the same effect on alerts.

## Your choices

- **Disconnect Google** in Settings → Google. If Duely is running in your Google account, the script first stops its timer and deletes your AI key and Brightspace links from its storage; then Duely revokes its access with Google. The "Duely" script project (with the schedule it read and your done marks) and the calendar it created stay in your Google account until you delete them.
- **Turn off email alerts** in Settings → Google.
- **Change or remove your AI key** in Settings → AI, or revoke it on your provider's website.
- **Turn off notifications** in Settings → Notifications. Discord alerts follow the same switches.
- **Disconnect Discord** in Settings → Notifications → Discord.
- **Delete everything:** in Settings → Notifications, disconnect Discord if you connected it. In Settings → Google, choose Disconnect. Then quit Duely, uninstall it, and delete the data folder listed above. In your Google account, delete the "Duely" project at [script.google.com](https://script.google.com) (this removes everything it stored), delete Duely's calendar in Google Calendar, and check its access is gone at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Children

Duely is made for college and university students. It isn't intended for children under 13.

## Changes

If this policy changes, the new version will be published in Duely's repository and included in the next version of the app, with a new effective date.

## Contact

Questions or concerns: open an issue at [github.com/zaidahmad16/Duely-public-](https://github.com/zaidahmad16/Duely-public-/issues).
