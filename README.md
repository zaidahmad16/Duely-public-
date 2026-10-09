# Duely

Your course assistant for Brightspace (D2L) schools. Duely puts your deadlines, tests and classes
in Google Calendar, reads course announcements for new dates, suggests study time, and answers
"what's due this week?" — using **one AI provider of your choice** (OpenAI-compatible, Anthropic or
Google Gemini; local models via Ollama/LM Studio work too).

Runs on **Windows, macOS and Linux**. Everything stays on your computer: your data, your keys.

> Status: early development. See the milestones below.

## Planned features
- Brightspace calendar → your own Google Calendar (assignments, quizzes, tests, events)
- Weekly class timetable and final exams from screenshots (needs a model that reads images)
- AI reads course announcements for dates and important news
- Chat: ask what's due, what's next, when your test is
- Suggested study blocks (you approve each one), morning digest, test-eve briefing
- Desktop notifications, optional Slack

## Development
```sh
npm install
npm run dev        # run the app with hot reload
npm test           # tests
npm run typecheck
npm run dist       # build installers for this OS
```

## License
MIT
