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
- `src/state.ts` — singleton `AppState`; all mutation flows through `setCollectState(partial)` / `setUpdateState(partial)`, which shallow-merge into the relevant workflow slice and immediately broadcast the new state to every connected SSE client
- `src/playwright/collect.ts` — Playwright logic for navigating Google Maps and scraping a saved list
- `src/playwright/update.ts` — Playwright logic for applying user-confirmed actions (remove / move)
- `src/playwright/browser.ts` — creates/reuses the persistent browser context stored in `browser-data/`
- `src/types.ts` — all shared types (`AppState`, `CollectWorkflow`, `UpdateWorkflow`, `Place`, `PlaceAction`, `ActionFile`)
- `src/config.ts` — reads `DRY_RUN` env var

### Data flow

1. Browser UI → `POST /api/collect/start` or `/api/update/start` → server spawns Playwright fire-and-forget and returns `200` immediately.
2. Playwright calls `setCollectState(...)` / `setUpdateState(...)` as it progresses → `broadcast()` enqueues the payload on every active `ReadableStreamDefaultController` in the SSE client `Set`.
3. Browser tabs receive SSE events (`state`, `place`, `progress`, `error`, `dryRunAction`) and re-render accordingly.

### Workflow state

`AppState` holds two independent workflow slices, each with its own `status`:

```
collect: idle → browsing | running → done ↘ error
update:  idle → running            → done ↘ error
```

Each page subscribes to the slice it cares about — `/` watches `collect`, `/collections/:f` watches `update` — and switches sections based on that slice's `status`. Only one workflow may run at a time; starting a second is rejected with 409.

### Selector fragility

Google Maps uses dynamically generated CSS class names. All Playwright selectors use `aria-label`, `role`, and text-content selectors. Uncertain selectors are annotated with `// UNCERTAIN:` comments — these are the first things to check when Maps updates break the automation.

### Keeping README.md up to date

Update `README.md` whenever you:
- Add, remove, or change an API endpoint (update the Routing section)
- Change architectural or system design (data flow, state model, SSE communication, Playwright modules, etc.)

### Output files

Written to `output/` (git-ignored except `.gitkeep`):

| Pattern | Contents |
|---|---|
| `{list}.json` | Raw scraped places (`CollectedList`) — overwritten on each re-collect; `lastUpdated` inside tracks when it was last run, and `dirtySince` (set by `src/mutations.ts` after an update mutates the list) flags it for re-sync on the home screen until the next collect overwrites it |
| `{list}_{ts}_actions.json` | User-confirmed actions (`ActionFile`) — deleted when the update run ends; its intent is logged to the session log first |
| `logs/session_{ts}.jsonl` | One JSONL log per server process. Every entry has `timestamp` + `level` (`info`/`error`); entries recording a change to a saved list also carry a `mutation` (`add-to-list` / `remove-from-list` / `append-note`) written so it can be inverted for undo. See README "Session logging". |
