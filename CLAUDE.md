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

A single Bun process serves an HTTP API + SSE stream and drives a Playwright browser in the background. No frameworks, no bundler, no React — vanilla HTML files served from `public/` and plain `fetch` calls from the browser.

Deep-dive docs live in `docs/`; consult them for detail and keep them current (see "Keeping docs up to date"):

- `docs/architecture.md` — process model, state model, full routing table, SSE events, the `src/playwright/` module breakdown, selector conventions, output-file formats
- `docs/session-logging.md` — the per-session JSONL log and the mutation/undo model
- `docs/cancellation.md` — the cooperative-cancellation mechanism

### Key files

- `src/server.ts` — `Bun.serve()` entry point; all HTTP routes and SSE broadcast infrastructure
- `src/state.ts` — singleton `AppState`; state changes flow through `setCollectState(partial)` / `setUpdateState(partial)`, which shallow-merge into the relevant workflow slice and immediately broadcast to every SSE client
- `src/playwright/collect.ts` — navigate Google Maps and scrape a saved list
- `src/playwright/update.ts` — apply user-confirmed actions (remove / move / copy)
- other `src/playwright/*` — one composable step per file (open list, open place panel, copy / remove / move / note), orchestrated by `collect.ts` and `update.ts`
- `src/mutations.ts` — `recordMutation()` (log a Maps change + flag its list for re-sync) and the run-scoped dirty-list tracking drained by `flushResyncFlags()`
- `src/logger.ts` — session JSONL logging (`logInfo` / `logError` / `logMutation`)
- `src/types.ts` — all shared types
- `src/config.ts` — reads the `DRY_RUN` env var

### Data flow

1. Browser UI → `POST /api/collect/start` or `/api/update/start` → server spawns Playwright fire-and-forget and returns `200` immediately.
2. Playwright calls `setCollectState(...)` / `setUpdateState(...)` as it progresses → `broadcast()` enqueues the payload on every active SSE controller.
3. Browser tabs receive SSE events (`state`, `place`, `savedLists`, `progress`, `error`, `dryRunAction`, `skipped`) and re-render accordingly.

### Workflow state

`AppState` holds two independent workflow slices, each with its own `status`:

```
collect: idle → browsing | running → done ↘ error   (browsing returns to idle)
update:  idle → running → done ↘ error
```

Each page subscribes to the slice it cares about — `/` watches `collect`, `/collections/:f` watches `update`. Only one workflow may run at a time; starting a second is rejected with 409.

### Mutations & re-sync

Anything that writes to Maps goes through `recordMutation()` in `src/mutations.ts`, called from the leaf modules (`copy-place-to-list.ts`, `remove-place-from-list.ts`, `set-place-note.ts`) right after the change settles. It logs the mutation *and* marks that list dirty. `update.ts` calls `resetMutationTracking()` at the start of a run and `flushResyncFlags()` in its `finally`, which stamps `dirtySince` onto the affected on-disk collections so the home screen recommends a re-sync. When adding a new write step, instrument it by calling `recordMutation()` — don't re-infer changed lists in the caller. Details in `docs/architecture.md` and `docs/session-logging.md`.

### Selectors

Google Maps uses dynamically generated CSS class names, so selectors prefer `aria-label`, `role`, and text content. Fragile ones are annotated `// BRITTLE:` (will break on a new class hash) or `// UNCERTAIN:` (may vary by locale/Maps version) — check these first when automation breaks.

## Keeping docs up to date

- User-facing behavior (setup, workflow, dry-run, cancellation UX) → `README.md`
- API endpoints → the routing table in `docs/architecture.md`
- Architecture / system design (data flow, state model, SSE, Playwright modules, output files) → `docs/architecture.md`
- Logging / mutation model → `docs/session-logging.md`

## Output files

Written to `output/` (git-ignored except `.gitkeep`); full formats in `docs/architecture.md#output-files`:

- `{list}.json` — scraped places (`CollectedList`); `dirtySince` (set by `src/mutations.ts`) flags it for re-sync until the next collect overwrites it
- `{list}_{ts}_actions.json` — user-confirmed actions (`ActionFile`); deleted when the update run ends (intent logged first)
- `logs/session_{ts}.jsonl` — one JSONL log per server process (see `docs/session-logging.md`)
