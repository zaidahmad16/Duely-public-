# Progress (resume here)

Plan: see the approved plan (milestones P0–P7). Updated 2026-10-09.

- **P0 done** (main, ad8667d): Electron + TypeScript scaffold, CI green on Windows/macOS/Linux.
- **P1 in progress** (branch `p1-engine-port`):
  - Done: `src/llm/` (types, OpenAI-compatible / Anthropic / Gemini adapters, JSON helper, capability probe);
    25 engine modules copied from the personal Worker into `src/core/`; `core/llm.ts` (one-provider reading AI);
    `actions.ts`, `agent.ts`, `ask.ts`, `slackui.ts` trimmed to the public features; **`npm run typecheck` passes**.
  - Tests: 74 pass, 9 fail. Next steps:
    1. Remove the Worker-route test blocks that import `../src/core/index.ts` from actions/ask/digest/vanished
       tests (re-add against the desktop engine in P2/P6).
    2. robust.test.ts: delete the Workers-AI→Mistral fallback tests; fix the 3 follow-up/free-form tests.
    3. chaos.test.ts: replace `{ mistralKey, workersAI }` with `{ llm: llmFromRun(...) }` (test/helpers.ts).
    4. Port oracle tests (harness + regression_cases) and add adapter tests with recorded responses.
    5. JSON store (`src/main/store.ts`, atomic writes, validated) and a headless `duely sync` CLI.
