# Setting up Duely

Duely puts your Brightspace deadlines, tests and classes in Google Calendar, reads your course announcements for new dates, and answers questions like "what's due this week?". Setup takes about 15 minutes, once.

## What you need

- your school's **Brightspace** login;
- a **Google account** (the calendar goes there);
- an **AI provider account** and its API key (OpenAI-compatible, Anthropic or Google Gemini). Duely needs one to work;
- about 15 minutes.

Duely walks you through five steps when you first open it. This guide explains each one in detail.

## 1. Your Brightspace calendar link

Duely reads your Brightspace calendar through a private subscription link.

1. Sign in to Brightspace.
2. Open **Calendar** (often under **Tools** in the top bar, or in a calendar widget on your homepage).
3. Click **Settings**, tick **Enable Calendar Feeds**, and click **Save**. (If you don't see this, feeds are already on.)
4. Click **Subscribe**.
5. In the **Calendar Subscriptions** list, choose **All Calendars and Tasks**, so every course is included.
6. Copy the link shown under the list. It starts with `webcal://` or `https://`.
7. Paste it into Duely and click **Continue**.

**Keep this link private.** It contains a token that lets anyone with the link see your calendar. If it leaks, you can reset it in Brightspace's calendar settings and paste the new one into Duely (**Settings → Sources → Brightspace calendar → Edit**).

## 2. Google Calendar

Duely adds everything to a calendar of its own (called "Brightspace") in your Google account. It can't see or change your other calendars.

Google needs to know which app is asking for access, so you create a small, free "client" for Duely in Google Cloud. It's a one-time setup of about 5 minutes. You don't need a credit card.

### Create the Google client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with the Google account you want to use.
2. Create a project: open the project picker at the top, click **New project**, name it `Duely`, and click **Create**. Make sure it's selected.
3. Turn on the Calendar API: go to **APIs & Services → Library**, search for **Google Calendar API**, open it, and click **Enable**.
4. Set up the consent screen: go to **Google Auth Platform → Branding** and click **Get started**.
   - **App name:** `Duely`. **User support email:** your email. Click **Next**.
   - **Audience:** choose **External**. Click **Next**.
   - **Contact information:** your email. Click **Next**.
   - Tick **I agree to the Google API Services: User Data Policy**, then click **Continue** and **Create**.
5. Add yourself as a test user: go to **Google Auth Platform → Audience**, find **Test users**, click **Add users**, enter your own Gmail address, and click **Save**. If the dialog stays open, click **Save** again.
6. Create the client: go to **Google Auth Platform → Clients**, click **Create client**, choose **Desktop app** as the application type, name it `Duely`, and click **Create**.
7. **Download the JSON file** right away (the download button in the dialog, or next to the client in the list). Google may only show the secret once. Keep the file somewhere private; it's what you'll give Duely.

### Connect it in Duely

1. In Duely, click **Choose file** and pick the JSON file you downloaded.
2. Click **Connect Google**. Your browser opens Google's sign-in.
3. Choose your account. Google warns that it **hasn't verified this app**. That's expected: it's your own client, not a published app. Continue past the warning (on some screens this is under **Advanced**).
4. Allow everything Duely asks for: **make secondary calendars and manage their events**, **see your email address**, and **create and update Apps Script projects** (so it can set itself up in your account, next).
5. When the page says **Google is connected**, go back to Duely.

### Run Duely in your Google account (recommended)

Right after you connect, Duely offers to run in your own Google account, so your calendar stays up to date and announcements still get read while your computer is off. It's a small Apps Script project named "Duely" that only you can see. It's free, and nothing goes to Duely's developers. You can also set it up later in **Settings → Google**, or choose to keep Duely on this computer only.

1. Click **Open Apps Script settings**, switch on **Google Apps Script API**, go back to Duely and click **I turned it on**.
2. Click **Install Duely in my Google account**.
3. Your browser opens the script in Google's editor, on a function called `duelySetup`. Click **Run**. Google asks you to approve it: choose your account, click **Advanced → Go to Duely (unsafe)** (it's your own project, so Google hasn't checked it), then **Allow**.
4. Duely shows a ✓ as soon as the approval is done. Upcoming then says **Updated by Duely in the cloud**.

When it's on, **Settings → Google** shows **Duely in your Google account** (with a switch to pause it) and **Email me alerts**, which also sends your alerts to your Gmail. Your AI key is kept in the script too, so it can read announcements while your computer is off (see the [Privacy Policy](PRIVACY.md)).

### Stay connected (recommended)

While your Google client is in **Testing**, Google signs Duely out every **7 days**, and you'd see "Google needs to be reconnected". To stop that:

1. In Google Cloud, go to **Google Auth Platform → Audience** and click **Publish app**, then confirm. The status changes to **In production**. You don't need to submit it for verification, because only you use it.
2. In Duely, go to **Settings → Google**, click **Disconnect**, then connect again (step "Connect it in Duely" above). The new sign-in doesn't expire.

## 3. Your AI

Duely uses one AI of your choice to sort your Brightspace items, read announcements for dates, and answer your questions in chat. **This step is required.** Duely won't open until the connection test passes.

### Pick a provider and get a key

| Provider | In Duely, choose | Where to get a key | Base URL |
|---|---|---|---|
| OpenAI | OpenAI-compatible | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | leave empty |
| Anthropic (Claude) | Anthropic | [platform.claude.com](https://platform.claude.com) → **API Keys** → **Create Key** | (none) |
| Google Gemini | Gemini | [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key** (has a free tier) | (none) |
| Mistral | OpenAI-compatible | [console.mistral.ai](https://console.mistral.ai) → **API Keys** | `https://api.mistral.ai/v1` |
| Groq | OpenAI-compatible | [console.groq.com](https://console.groq.com) → **API Keys** | `https://api.groq.com/openai/v1` |
| OpenRouter | OpenAI-compatible | [openrouter.ai](https://openrouter.ai) → **Keys** | `https://openrouter.ai/api/v1` |
| Ollama (on your computer) | OpenAI-compatible | no key needed | `http://localhost:11434/v1` |
| LM Studio (on your computer) | OpenAI-compatible | no key needed | `http://localhost:1234/v1` |

Copy the key when it's shown; most providers only show it once.

### Connect it in Duely

1. Choose the provider.
2. Paste your **API key**.
3. For OpenAI-compatible providers other than OpenAI, fill in the **Base URL** from the table.
4. Click **Test connection**. Duely asks your provider which models your key can use, picks a small, fast one that works, and checks three things:
   - **Chat:** the model can use tools, so chat understands your questions. Without it, chat answers with simple lists.
   - **Reading:** the model gives structured answers, so announcements can be read for dates.
   - **Screenshots:** the model can read images, for importing a timetable from a screenshot.

   The test must at least connect. A ✗ on one of them only turns that feature off. If a model is busy or isn't available to your key, Duely tries the next one; the result says which model it chose.
5. Click **Continue**.

You don't need to know model names. If you want a particular one, open **Advanced** and type or pick it; leave it empty to let Duely choose. You can change it later in **Settings → AI**. For a model on your own computer (Ollama, LM Studio), Duely picks from the models you've downloaded.

### Costs and your key

Your provider bills you for API use. Duely makes a capped number of requests a day (**Settings → AI → Daily cap**), but **you're responsible for your key and its charges** (see the [Terms of Service](TERMS.md)). It's a good idea to:

- **set a spending limit:** OpenAI under **Project settings → Limits**; Anthropic under **Organization settings → Billing → Spend limits**; Gemini's free tier needs no billing at all;
- use a key only for Duely;
- revoke the key with your provider right away if you think it was exposed, and paste a new one into **Settings → AI**.

## 4. Course announcements (optional)

Duely can read each course's announcements, add dates your profs post (like a moved test), and tell you about important ones. Brightspace gives each course's announcements its own RSS link, so do this once per course, each term.

1. In Brightspace, open a course.
2. Open **Announcements** (in the course's top bar, or the Announcements widget on the course homepage).
3. Click the **RSS** button or icon. A page of text opens in a new tab.
4. Copy the address from your browser's address bar.
5. Paste it into Duely: in setup, step 4; later, **Settings → Sources → Announcements**, then press **Enter**.

Items Duely found in an announcement are marked **from announcement** in your lists. Double-check those against the post.

**Timetable screenshots:** you can add your weekly classes here too (see "Your timetable and exams" below).

## 5. Notifications

Duely can notify you on your computer about:

- sync problems;
- moved tests and deadlines;
- important announcements (if you turn that on);
- the morning digest and Sunday preview;
- the evening-before-a-test briefing.

Turn each one on or off in **Settings → Notifications** and **Settings → Study & digests**.

Duely keeps working when you close its window. It stays in the system tray (or menu bar), and **Quit Duely** is in the tray menu. In the installed app, you can turn on **Start at login** in **Settings → Google**.

## Your timetable and exams (optional)

Duely can put your weekly classes and your final exams in your calendar from screenshots, so you don't type them in.

**Classes:** in your school's registration system, open your timetable in **week view** and take a screenshot of each term (Fall and Winter together is fine). In Duely, go to **Settings → Sources → Class timetable → Add terms from screenshots** (or use the box in step 4 of setup) and choose the screenshots. Your AI reads them, then Duely shows each term for you to check:

- the **first and last day of classes** (taken from the dates printed on the screenshot);
- **No classes:** breaks and holidays. Breaks your Brightspace calendar already lists (like "Reading Week – No Classes") are filled in. Add any other days off, such as statutory holidays;
- **Follows another day's schedule:** for days like a Friday that runs Monday's classes;
- each **class**, with a switch to leave it out and the details (days, times, room) to fix anything that's off;
- courses with **no meeting times** (online or TBA), which have nothing to add, and any course code that looks misread (for example the same class printed with two different numbers).

Click **Add to calendar** for each term. Each class repeats weekly from the first to the last day of classes, skipping the days off. To take a term back out, click **×** next to it in Settings; its future classes leave your calendar at the next sync.

**Academic dates page (optional):** if your school has a page listing each term's dates, breaks and holidays, paste its link in **Settings → Sources → Academic dates page**. Duely then takes the dates from there instead of guessing them from the screenshot.

**Final exams:** when your school posts the exam schedule, take a screenshot and use **Settings → Sources → Final exams → Add final exams**. Check each exam and click **Add to calendar**.

Screenshots go to your AI provider to be read, and aren't kept by Duely. This needs a model that can read images (Test connection shows ✓ for Screenshots).

## Using Duely

- **Upcoming** shows today, the rest of this week and next week. Tick the box when you've handed something in; it gets a ✓ in your calendar. Click a row to open it in Brightspace.
- **Questions** appear at the top when Duely needs you, for example when a quiz disappeared from Brightspace, or to suggest study time. Nothing is added to your calendar until you say yes.
- **Chat** answers questions like "what's due tomorrow?" or "when is my next test?".
- **Sync now** checks Brightspace straight away. Duely also checks every 10 minutes on its own, and again when your computer wakes up. If Duely runs in your Google account, it checks every 10 minutes even while your computer is off, and Sync now can take a couple of minutes to start (Google decides when).

## Troubleshooting

**"Google needs to be reconnected"**
Your Google client is still in Testing, so the sign-in expired after 7 days. Publish it (see "Stay connected") and connect again.

**"Google Apps Script API" is still off**
Open [script.google.com/home/usersettings](https://script.google.com/home/usersettings) in the same Google account you connected, switch it on, wait a few seconds, and click **I turned it on** again.

**Google's editor opened in a different account**
If you're signed in to several Google accounts, check the account picture at the top right of the editor. Duely opens links in the account you connected, but if you switched accounts, close the tab and click **Open it again** in Duely.

**"Access blocked" or "Error 403: access_denied" when connecting Google**
Your account isn't a test user of your Google client. Add it under **Google Auth Platform → Audience → Test users**, or publish the app.

**"That's a Web application client"**
You created the wrong kind of client. Create a new one with application type **Desktop app**, and download its JSON.

**"The Brightspace calendar link didn't return a calendar"**
The link is wrong or was reset. Copy it again from **Calendar → Subscribe** in Brightspace.

**"The API key wasn't accepted" / "That model wasn't found"**
Check that the whole key was copied (no spaces), and the base URL for OpenAI-compatible providers. If you typed a model under **Advanced**, clear it to let Duely choose.

**"The provider is busy right now"**
Every model Duely tried was overloaded (this happens with Gemini at busy times). Try again in a minute.

**"The provider is limiting requests or the account has no credit"**
Add credit or wait a minute. Free tiers have per-minute limits.

**An announcements link "isn't working"**
The course may be over or the link changed. Remove it in **Settings → Sources**, or copy it again from the course's Announcements page.

**No notifications (Linux)**
Your desktop needs a notification service. Most desktops have one; minimal window managers may need one installed (for example `dunst`).

**"Saved keys are only lightly protected" (Linux)**
Your computer has no keyring, so Duely can't use the system's encryption for your keys. Install and unlock a keyring (GNOME Keyring or KWallet), then restart Duely and enter your key again.

## Privacy

Everything Duely stores stays on your computer, and in your own Google account if you run it there. It only talks to Brightspace, Google and your AI provider, directly. Read the [Privacy Policy](PRIVACY.md) for the details.
