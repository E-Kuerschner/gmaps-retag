# Architecture

The app is a single Bun process that serves an HTTP API and an SSE stream, and drives a Playwright browser in the background. There are no frameworks, no bundler, and no React — just vanilla HTML files served from `public/` and plain `fetch` calls from the browser.

## Bird's-eye view

```
┌──────────────────────────────────────────────────────────────────┐
│                          Bun process                             │
│                                                                  │
│  ┌──────────────────┐  setCollectState()  ┌──────────────────┐  │
│  │  collect.ts      │ ──────────────────▶ │                  │  │
│  │                  │                     │  AppState        │  │
│  │  update.ts       │ ──────────────────▶ │  src/state.ts    │  │
│  └──────────────────┘  setUpdateState()   │                  │  │
│                                           └────────┬─────────┘  │
│                                                    │ broadcast() │
│                                                    ▼            │
│  ┌──────────────────┐   fetch POST        ┌──────────────────┐  │
│  │  Browser UI      │ ──────────────────▶ │  Bun.serve()     │  │
│  │  (HTML pages)    │                     │  src/server.ts   │  │
│  │                  │ ◀─── SSE stream ─── │                  │  │
│  └──────────────────┘                     └──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

User actions travel from the browser to the server as plain `fetch` POST calls. Progress and state changes travel back through a persistent SSE stream on `/api/events`.

Playwright runs fire-and-forget from inside the API handler: the HTTP response returns as soon as the workflow is launched, and all subsequent progress arrives over SSE.

## State model

State is split into two independent workflows. Each page subscribes to the part it cares about:

```typescript
interface AppState {
  dryRun: boolean;
  collect: CollectWorkflow;   // watched by /
  update:  UpdateWorkflow;    // watched by /collections/:f
}
```

Each workflow follows the same simple lifecycle:

```
collect:   idle ──▶ running ──▶ done
             │            └──▶ error
             └──▶ browsing ──▶ idle   (scrape saved list names, then back to idle)
                          └──▶ error

update:    idle ──▶ running ──▶ done
                          └──▶ error
```

Mutations go through `setCollectState(partial)` or `setUpdateState(partial)`, which shallow-merge the update into the relevant workflow slice and immediately broadcast the new full state to all connected SSE clients.

The two workflows are independent — the collect and update Playwright processes are completely separate runs. Starting a second run while one is active is rejected with 409.

## Routing

```
GET  /                           → collect.html
GET  /collections/:fileName      → collection.html

GET  /api/events                 → SSE stream (broadcasts AppState on every mutation)
GET  /api/saved-lists            → names of all saved lists (from output/saved-lists.json, or [] if not yet collected)
GET  /api/collect-files          → list of collection JSON files in output/ (each: fileName, listName, lastUpdated, dirtySince — dirtySince set when an update has since mutated the list)
GET  /api/collections/:fileName  → contents of a specific collection JSON
DEL  /api/collect-files/:name    → delete a collection file

POST /api/log-error              → { message } — record a client-side error in the session log

GET  /map-background.jpg         → static page background (the only static asset route; matched by exact path)

POST /api/collect/start          → { listName } — launch collect workflow
POST /api/collect/browse-lists   → scrape all saved list names (no listName needed); writes output/saved-lists.json and broadcasts a savedLists event
POST /api/collect/cancel         → force-stop an in-progress collect/browse run (see Cancellation)
POST /api/collect/reset          → reset collect workflow to idle

POST /api/update/start           → { collectionFile, actions[], dryRun? } — write action file, launch update workflow (dryRun forced true if server started with DRY_RUN=true)
POST /api/update/cancel          → force-stop an in-progress update run (see Cancellation)
POST /api/update/reset           → reset update workflow to idle

POST /api/browser/close          → close the persistent Playwright browser
```

## SSE communication

A single `/api/events` endpoint serves all pages. The server keeps a `Set` of active `ReadableStreamDefaultController` instances — one per connected tab. On connect, the current `AppState` is sent immediately so the page renders without waiting for the next mutation.

```
Browser tab                         Server
    │                                  │
    │   GET /api/events                │
    │ ───────────────────────────────▶ │  adds controller to Set
    │ ◀── event: state (snapshot) ──── │  sends current state immediately
    │                                  │
    │         [Playwright runs in background]
    │                                  │
    │ ◀── event: place ──────────────── │  each scraped place (collect)
    │ ◀── event: savedLists ─────────── │  full list of saved-list names (collect, browse-lists)
    │ ◀── event: progress ───────────── │  per-item progress (update)
    │ ◀── event: error ──────────────── │  per-item failure (update)
    │ ◀── event: dryRunAction ────────── │  dry-run log entry (update)
    │ ◀── event: skipped ────────────── │  per-item action skipped as already up to date (update)
    │ ◀── event: state (done/error) ──── │  terminal state
```

## Playwright modules

Navigation to Google Maps is broken into composable, reusable steps in `src/playwright/`:

| Module | Signature | What it does |
|---|---|---|
| `browser.ts` | `getBrowserContext()` | Creates/reuses the persistent Chromium profile in `browser-data/` |
| `open-saved-lists.ts` | `(context) → Page`; also exports `resetToSavedListsPanel(page)` | Navigates to Maps and opens the saved-lists panel; the reset helper returns to that panel from any depth without a full reload, for switching between lists mid-flow |
| `open-list-by-name.ts` | `(page, listName) → Page` | Clicks a named list in the panel — only works from the saved-lists overview |
| `saved-list-names.ts` | `scrapeSavedListNames(page)`, `writeSavedListNames(dir, names)` | Reads list names from the open saved-lists panel and persists them |
| `browse-saved-lists.ts` | `(context) → void` | Standalone flow: open saved lists, scrape names only, write JSON, broadcast — used by "Scan My Saved Lists" |
| `cancel.ts` | `requestCancel()`, `isCancelRequested()`, `resetCancel()`, `CancelledError` | Cooperative cancellation flag checked by collect/browse loops — see [Cancellation](./cancellation.md) |
| `get-place-details.ts` | `(page, placeName) → PlaceDetails` | Clicks a place, scrapes name/address/note |
| `open-place-panel.ts` | `openPlacePanel(page, placeName) → OpenPlacePanelResult`; also exports `placeButtonName(placeName)`, `closeMembershipDropdown(page)` | Opens a place's detail panel and returns a Locator scoped to it, for reading/toggling its "Saved (N)" membership dropdown |
| `set-place-note.ts` | `appendPlaceNote(page, placeName, noteToAdd, listName?) → SetNoteOutcome` | Appends text to a place's note in the currently open list's feed, creating the note if it doesn't have one. `listName` is used only to label the mutation record |
| `copy-place-to-list.ts` | `(page, placeName, sourceListName, destinationListName, note?) → CopyOutcome` | Adds a place to a list via the Saved dropdown, skipping the click if already a member; if `note` is given, appends it to the place's note on the destination list |
| `remove-place-from-list.ts` | `(page, placeName, listName) → RemoveOutcome` | Removes a place from a list via the Saved dropdown, skipping the click if not a member |
| `move-place-to-list.ts` | `(page, placeName, src, dest, note?) → MoveOutcome` | Composes copy + remove: adds to `dest` first (carrying `note` over if given), then removes from `src` |
| `collect.ts` | `(context, listName) → string` | Full collect workflow — navigate, scroll, enrich, write JSON |
| `update.ts` | `(context, actionFilePath, dryRun) → void` | Full update workflow — navigate, apply each action |

`collect.ts` and `update.ts` orchestrate the atomic modules above. The smaller modules are independently usable in scripts or future flows.

### The `recordMutation` abstraction

The three modules that actually change something in Maps — `copy-place-to-list.ts`, `remove-place-from-list.ts`, and `set-place-note.ts` — each call `recordMutation()` from `src/mutations.ts` immediately after the change settles. `recordMutation` does two things: it writes the mutation to the session log, and it marks the mutated list as needing a re-sync. Instrumenting at this leaf level rather than in `update.ts` means any future flow that composes these modules gets both effects automatically, without re-deriving which lists changed. See [Session logging](./session-logging.md).

The re-sync half accumulates in module-level state inside `src/mutations.ts` — the changed lists build up across a run, then `update.ts` drains them in its `finally` via `flushResyncFlags()`, which stamps `dirtySince` onto the matching collection file(s) on disk so the home screen recommends a re-sync. Only lists that are actually imported get flagged, since a mutation to a never-imported list has no snapshot to go stale. `update.ts` calls `resetMutationTracking()` at the start of a run so nothing leaks between runs, and flushing in the `finally` means a cancelled or errored run still flags whatever it managed to change; the next collect overwrites the file and clears the stamp. This module state is safe because only one workflow runs at a time (a second is rejected with 409).

## Selector fragility

Google Maps uses dynamically generated CSS class names. All Playwright selectors prefer `aria-label`, `role`, and text-content attributes. Selectors that rely on internal class names or attributes are annotated:

- `// BRITTLE:` — known-fragile; will break when Maps deploys a new class hash
- `// UNCERTAIN:` — selector works in testing but the attribute may change by locale or Maps version

These annotations are the first things to check when a live Maps session breaks a flow.

## Browser persistence

Playwright launches a **persistent browser context** stored in `browser-data/` (git-ignored). This preserves the Google session between server restarts so login is only required once.

## Output files

Everything is written to `output/` (git-ignored except `.gitkeep`):

| File pattern | Contents |
|---|---|
| `saved-lists.json` | Names of all saved lists — refreshed on each collect run, used to populate the _Move to…_ dropdown |
| `{list}.json` | Scraped collection (`CollectedList`) — places with name and note; overwritten on each re-collect. `lastUpdated` records when it was last run; `dirtySince` is stamped once an update mutates the list, which flags it for re-sync on the home screen until the next collect overwrites the file |
| `{list}_{ts}_actions.json` | Actions confirmed on the collection page (`ActionFile`) — created when an update starts, **deleted when the run ends**; the intent is recorded in the session log first |
| `logs/session_{ts}.jsonl` | One log file per server process — see [Session logging](./session-logging.md) |
