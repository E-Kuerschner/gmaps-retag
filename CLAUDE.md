# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                        # install dependencies
bunx playwright install chromium   # install browser (first time only)

bun run dev          # watch mode — restarts on file changes
bun run dev:dry      # watch mode + dry-run (no Maps writes)
bun run start        # production
bun run start:dry    # production + dry-run
```

No test runner or linter is configured. There is no build step — Bun runs TypeScript directly.

## Architecture

The app is a single Bun process that serves an HTTP API + SSE stream and drives a Playwright browser in the background. There are no frameworks, no bundler, and no React — just vanilla HTML files served from `public/` and plain `fetch` calls from the browser.

### Key files

- `src/server.ts` — `Bun.serve()` entry point; all HTTP routes and SSE broadcast infrastructure
- `src/state.ts` — singleton `AppState`; all mutation flows through `setState(partial)`, which shallow-merges and immediately broadcasts the new state to every connected SSE client
- `src/playwright/collect.ts` — Playwright logic for navigating Google Maps and scraping a saved list
- `src/playwright/update.ts` — Playwright logic for applying user-confirmed actions (remove / move)
- `src/playwright/browser.ts` — creates/reuses the persistent browser context stored in `browser-data/`
- `src/types.ts` — all shared types (`AppState`, `AppPhase`, `Place`, `PlaceAction`, `ActionFile`)
- `src/config.ts` — reads `DRY_RUN` env var

### Data flow

1. Browser UI → `POST /api/collect/start` or `/api/update/start` → server spawns Playwright fire-and-forget and returns `200` immediately.
2. Playwright calls `setState(...)` as it progresses → `broadcast()` enqueues the payload on every active `ReadableStreamDefaultController` in the SSE client `Set`.
3. Browser tabs receive SSE events (`state`, `place`, `progress`, `error`, `dryRunAction`) and re-render accordingly.

### Phase state machine

```
idle → collecting → review → confirming → done
                                       ↘ error
idle → updating ──────────────────────→ done
                                       ↘ error
```

The `phase` field in `AppState` is the discriminant; UI pages switch sections based on it.

### Selector fragility

Google Maps uses dynamically generated CSS class names. All Playwright selectors use `aria-label`, `role`, and text-content selectors. Uncertain selectors are annotated with `// UNCERTAIN:` comments — these are the first things to check when Maps updates break the automation.

### Output files

Written to `output/` (git-ignored except `.gitkeep`):

| Pattern | Contents |
|---|---|
| `{list}_{ts}.json` | Raw scraped places (`CollectedList`) |
| `{list}_{ts}_actions.json` | User-confirmed actions (`ActionFile`) |
| `errors_{ts}.json` | Per-item failures |
