# gmaps-retag

A local tool for bulk-reviewing and retagging your Google Maps saved lists.

Because Google Maps has no public API for personal saved data, the tool drives a real browser via Playwright. All data stays on your machine — nothing is sent to any external service.

## Download (no dev environment needed)

Pre-built binaries for every platform are attached to each [GitHub Release](../../releases). Download the one for your OS, make it executable, and run it:

```bash
# macOS (Apple Silicon)
chmod +x gmaps-retag-macos-arm64 && ./gmaps-retag-macos-arm64

# macOS (Intel)
chmod +x gmaps-retag-macos-x64 && ./gmaps-retag-macos-x64

# Linux x64
chmod +x gmaps-retag-linux-x64 && ./gmaps-retag-linux-x64

# Windows — double-click gmaps-retag-win-x64.exe or run from a terminal
```

On first launch the tool detects that Chromium isn't installed and downloads it automatically (~150 MB, cached permanently at `~/.cache/ms-playwright`). Subsequent runs start instantly.

---

## Development setup

### Requirements

- [Bun](https://bun.sh) ≥ 1.3 (version pinned in `.bun-version`)
- Chromium (downloaded automatically on first run, or manually with `bunx playwright install chromium`)

### Install

```bash
bun install
```

## Usage

```bash
bun run dev          # watch mode (restarts on file changes)
bun run dev:dry      # watch mode + dry-run (no Maps changes written)
bun run start        # production
bun run start:dry    # production + dry-run
```

Open **http://localhost:3000** in your browser.

### Workflow

**1 · Collect & Review**

Enter the name of a saved list. A browser window opens and navigates to Google Maps. Once the places are collected they appear in a review table where each one can be marked _keep_, _remove_, or _move to another list_. Confirming writes an actions file to `output/`.

**2 · Update**

Select an actions file from step 1. The browser navigates back to Maps and applies every marked change automatically.

### Dry-run mode

Start the server with `DRY_RUN=true` (or use the `dev:dry` / `start:dry` scripts). The browser still navigates all the way through to the save popup for each place and resolves every selector — but the final list-entry clicks are skipped. Use this to validate and tune Playwright selectors without touching your real data. An amber banner appears on all UI pages and the Update page logs what _would_ have been applied.

## Output files

Everything is written to `output/` (git-ignored except `.gitkeep`):

| File pattern | Contents |
|---|---|
| `{list}_{ts}.json` | Raw collected places — name and Maps link |
| `{list}_{ts}_actions.json` | User-confirmed actions consumed by the Update flow |
| `errors_{ts}.json` | Per-item failures from either flow |

## Releasing

Push a semver tag to trigger the GitHub Actions release workflow, which cross-compiles all five platform binaries from a single Ubuntu runner and attaches them to the release automatically:

```bash
git tag v1.0.0
git push origin v1.0.0
```

To build binaries locally:

```bash
bun run build        # current platform only → dist/gmaps-retag
bun run build:all    # all five platforms    → dist/
```

---

## Architecture

### Bird's-eye view

```
┌──────────────────────────────────────────────────────────────────┐
│                          Bun process                             │
│                                                                  │
│  ┌─────────────────┐   setState()    ┌──────────────────────┐   │
│  │   Playwright     │ ──────────────▶ │  AppState            │   │
│  │  collect.ts /   │                 │  src/state.ts        │   │
│  │  update.ts      │                 └──────────┬───────────┘   │
│  └─────────────────┘                            │ broadcast()   │
│                                                 ▼               │
│  ┌─────────────────┐   fetch POST    ┌──────────────────────┐   │
│  │  Browser UI     │ ──────────────▶ │  Bun.serve()         │   │
│  │  (HTML pages)   │                 │  src/server.ts       │   │
│  │                 │ ◀── SSE stream ─┘                      │   │
│  └─────────────────┘                                        │   │
└──────────────────────────────────────────────────────────────────┘
```

User actions (submitting a list name, confirming actions) travel from the browser UI to the server as plain `fetch` POST calls. Progress and state changes travel back through a persistent SSE stream.

### State management

A single `AppState` object lives as a module-level variable in `src/state.ts`. Every mutation goes through `setState(partial)`, which shallow-merges the update and immediately broadcasts the new state to all connected clients:

```typescript
// src/state.ts (simplified)
let state: AppState = { phase: 'idle', dryRun: isDryRun };

export function setState(update: Partial<AppState>) {
  state = { ...state, ...update };
  broadcast('state', state);
}
```

`AppState` carries a discriminated `phase` field that drives which UI section is shown on each page:

```
idle → collecting → review → confirming → done
                                       ↘ error
idle → updating ──────────────────────→ done
                                       ↘ error
```

### SSE communication

The server keeps a `Set` of active `ReadableStreamDefaultController` instances — one per connected browser tab. `broadcast()` encodes the payload and enqueues it on every controller in the set:

```
Browser tab                        Server (Bun.serve)
    │                                      │
    │   GET /api/events                    │
    │ ───────────────────────────────────▶ │ adds controller to Set,
    │ ◀── event: state (current) ───────── │ sends snapshot immediately
    │                                      │
    │            [Playwright runs in background]
    │                                      │
    │ ◀── event: place ─────────────────── │ each scraped place
    │ ◀── event: progress ──────────────── │ per-item update progress
    │ ◀── event: error ─────────────────── │ per-item failure
    │ ◀── event: dryRunAction ──────────── │ dry-run: what would apply
    │ ◀── event: state (phase=done) ─────── │ terminal state
    │                                      │
    │   POST /api/collect/start            │
    │ ───────────────────────────────────▶ │ spawns Playwright fire-and-forget,
    │ ◀── 200 { ok: true } ─────────────── │ returns immediately
```

Playwright runs fire-and-forget from the API handler. The HTTP response returns as soon as the browser is launched; all subsequent progress is pushed back over the SSE channel.

### Browser persistence

Playwright launches a **persistent browser context** stored in `browser-data/` (git-ignored). This preserves the Google session between server restarts so the user only needs to log in once.

### Playwright selector notes

Google Maps uses dynamically generated CSS class names, so the Playwright code targets `aria-label`, `role`, and text-content selectors wherever possible. Every selector that is uncertain is annotated with a `// UNCERTAIN:` comment explaining the assumption and suggesting fallback approaches — these are the first things to check when testing against a live Maps session.
