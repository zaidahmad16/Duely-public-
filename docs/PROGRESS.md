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
- **P2 next**: Google OAuth (loopback + PKCE) in Node, Calendar sync push, scheduler with catch-up after sleep,
  tray, desktop notifications; secrets via `safeStorage`.
