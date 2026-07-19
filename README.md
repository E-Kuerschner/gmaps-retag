# gmaps-retag

A local tool for bulk-reviewing and retagging your Google Maps saved lists.

Because Google Maps has no public API for personal saved data, the tool drives a real browser via Playwright. All data stays on your machine — nothing is sent to any external service.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (version pinned in `.bun-version`)
- Chromium (installed automatically by Playwright on first run)

## Setup

```bash
bun install
bunx playwright install chromium
```

## Usage

```bash
bun run dev          # watch mode (restarts on file changes)
bun run dev:dry      # watch mode + dry-run (no Maps changes written)
bun run start        # production
bun run start:dry    # production + dry-run
```

Open **http://localhost:3000** in your browser.

### Page hierarchy

```
/                         Import a new list or browse previously imported ones
└── /collections/:f       Collection — review places, assign actions, run update
```

Each collection is a permanent URL. Browser back and forward work naturally throughout.

### Workflow

**Step 1 — Collect** (`/`)

Click _Scan My Saved Lists_. A browser window opens, navigates to Google Maps, and reads the names of all your saved lists — no places are scraped yet, just the list names (written to `output/saved-lists.json`, also used elsewhere for the _Move to…_ dropdown). Once it finishes, pick one from the dropdown (lists already imported are left out, since re-syncing those is handled below) and click _Import_. That runs the full import — opens the target list, scrolls to load all places, and scrapes each one's name and note. Progress appears live as places stream in. When the run completes, the page redirects automatically to the new collection.

Previously imported lists appear below with a "Last synced" timestamp — since each is a point-in-time snapshot, click _Re-sync_ next to a list to refresh it. The page suggests a re-sync for two reasons: the snapshot is older than a week, or an update run has since written to that list in Maps (moved/copied a place into it, removed one from it, or appended a note) so the snapshot no longer matches. The second case is tracked with a `dirtySince` stamp written onto the collection file when the update runs — only lists that are actually imported get flagged, and the next collect overwrites the file and clears it.

While a scan or import is running, a _Cancel_ button is available if it gets stuck (e.g. Maps never finishing loading, or a scroll loop that never reaches the bottom). Cancelling force-closes the Playwright browser, which is what actually unblocks whatever call was hanging — see [Cancellation](#cancellation) below.

**Step 2 — Review** (`/collections/:fileName`)

The collection page shows every place with its address and note. For each place choose _Keep_, _Remove_, _Move to…_, or _Copy to…_ (the latter two need a target list name). Places you leave as _Keep_ are ignored by the update. _Move_ removes the place from the source list once it's added to the target; _Copy_ adds it to the target list while leaving it in the source list. If the place has a note, _Copy_ and _Move_ carry it over to the target list — appended after whatever note the place already has there, if any, rather than overwriting it.

**Step 3 — Update** (same page)

Check _Dry run_ if you just want to validate selectors without touching real data, then click _Start Update_. The browser navigates back to Maps and applies every marked change. Progress is shown inline; individual failures are logged without stopping the rest of the run. The actions file is written to `output/` for reference.

### Dry-run mode

Dry run is a per-update choice, not a server-wide setting: tick the _Dry run_ checkbox above the action table before clicking _Start Update_. The browser navigates all the way through to the save popup for each place and resolves every selector — but the final list-entry clicks are skipped. An amber banner appears on the collection page and it logs what _would_ have been applied instead of applying it.

Starting the server with `DRY_RUN=true` (or the `dev:dry` / `start:dry` scripts) forces every update to run as a dry run regardless of the checkbox — the checkbox is shown checked and disabled in that case. Use the env var for a server that should never write to Maps (e.g. a staging setup); use the per-update checkbox to validate a specific run on an otherwise live server.

### Cancellation

Playwright automation can hang — Maps never finishing a load, or a scroll loop that never detects it's reached the bottom. `POST /api/collect/cancel` and `POST /api/update/cancel` (wired to the _Cancel_ buttons on `/` and `/collections/:file`) handle this by:

1. Setting a module-level flag (`src/playwright/cancel.ts`) that `collect.ts`, `browse-saved-lists.ts`, `saved-list-names.ts`, and `update.ts` check between loop iterations, so a run that's merely looping stops on its next check.
2. Force-closing the persistent Playwright browser context. This is what actually unblocks a run that's stuck *inside* a single blocking call (`page.goto`, `locator.waitFor`, etc.) — closing the context makes Playwright reject that in-flight call immediately.

Either path lands in the flow's own `catch` block, which checks the cancellation flag and reports `"Cancelled by user."` as the terminal error state instead of whatever raw Playwright error surfaced.

Both workflows reset the flag when a run starts, so a cancellation never leaks into the next run.

**Cancelling an update is not an undo.** Collect only ever reads, so stopping it loses nothing; an update may already have written to Maps by the time it's cancelled. Nothing is rolled back — the run stops where it is, and the terminal message reports how many actions completed (`Cancelled by user after 3 of 8 action(s). Changes already made were not undone.`). The mutations that did land are in the session log; see [Session logging](#session-logging).

Because force-closing the browser makes the in-flight Playwright call reject, that rejection surfaces inside `update.ts`'s per-action `catch`. That handler re-checks the cancel flag and rethrows, so a cancellation isn't recorded as a failure of the action it interrupted — and doesn't leave the loop running on to fail every remaining action.

## Output files

Everything is written to `output/` (git-ignored except `.gitkeep`):

| File pattern | Contents |
|---|---|
| `saved-lists.json` | Names of all saved lists — refreshed on each collect run, used to populate the _Move to…_ dropdown |
| `{list}_{ts}.json` | Scraped collection — places with name, address, and note; carries a `dirtySince` stamp once an update mutates the list, which flags it for re-sync on the home screen until the next collect overwrites the file |
| `{list}_{ts}_actions.json` | Actions confirmed on the collection page (created when update starts, **deleted when the run ends** — the intent is recorded in the session log first) |
| `logs/session_{ts}.jsonl` | One log file per server process — see [Session logging](#session-logging) |

---

## Session logging

Every run of the server writes to its own timestamped file, `output/logs/session_{ts}.jsonl`.
Restarting the server — including a watch-mode reload — starts a new one. All logging for a
session lands in that single file; there are no separate per-error files.

The format is [JSON Lines](https://jsonlines.org): one JSON object per line, so the file is
greppable by eye and parseable by a script. Every entry carries a `timestamp` and a `level`
of either `info` or `error`.

Entries that record an actual change to a saved list also carry a `mutation` object:

```jsonc
{"timestamp":"…","level":"info","message":"Removed \"Ritual Coffeehouse\" from list \"TEST 1\"",
 "mutation":{"op":"remove-from-list","place":"Ritual Coffeehouse","list":"TEST 1"}}
```

Mutations are recorded at the atomic level at which Google Maps actually changes — `add-to-list`,
`remove-from-list`, `append-note` — rather than at the level of the user-facing action. A **move**
therefore appears as an add followed by a remove. This is deliberate: each atomic record carries
everything needed to construct its own inverse, which is what makes the log usable for undo.

| `op` | Inverse |
|---|---|
| `add-to-list` | remove the place from `list` |
| `remove-from-list` | add the place back to `list` |
| `append-note` | restore `previousNote` |

`previousNote` matters most — it is the only record anywhere of what a note said beforehand. Maps
keeps no history, and the collect snapshot is overwritten on every re-sync.

Two guarantees make the log trustworthy for recovery:

- **Append-only, flushed per entry.** Written with a synchronous append per line, so a crash or a
  force-closed browser (which is how cancellation works) can never truncate what came before.
- **Written only after the change commits.** Every mutation is logged after its settle wait, never
  before — so anything in the file is something that actually happened.

The converse is worth knowing: a process killed mid-click can leave a change made in Maps but not
logged. The window is small, but the log is a lower bound on what happened, not a perfect mirror.
There is no automatic rollback — the log gives you the data to reconstruct by hand.

---

## Architecture

### Bird's-eye view

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

### State model

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

### Routing

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

POST /api/reset                  → reset both workflows to idle
POST /api/browser/close          → close the persistent Playwright browser
```

### SSE communication

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

Playwright runs fire-and-forget from inside the API handler. The HTTP response returns as soon as the workflow is launched; all subsequent progress arrives over SSE.

### Playwright modules

Navigation to Google Maps is broken into composable, reusable steps in `src/playwright/`:

| Module | Signature | What it does |
|---|---|---|
| `browser.ts` | `getBrowserContext()` | Creates/reuses the persistent Chromium profile in `browser-data/` |
| `open-saved-lists.ts` | `(context) → Page`; also exports `resetToSavedListsPanel(page)` | Navigates to Maps and opens the saved-lists panel; the reset helper returns to that panel from any depth without a full reload, for switching between lists mid-flow |
| `open-list-by-name.ts` | `(page, listName) → Page` | Clicks a named list in the panel — only works from the saved-lists overview |
| `saved-list-names.ts` | `scrapeSavedListNames(page)`, `writeSavedListNames(dir, names)` | Reads list names from the open saved-lists panel and persists them |
| `browse-saved-lists.ts` | `(context) → void` | Standalone flow: open saved lists, scrape names only, write JSON, broadcast — used by "Scan My Saved Lists" |
| `cancel.ts` | `requestCancel()`, `isCancelRequested()`, `resetCancel()`, `CancelledError` | Cooperative cancellation flag checked by collect/browse loops — see [Cancellation](#cancellation) |
| `get-place-details.ts` | `(page, placeName) → PlaceDetails` | Clicks a place, scrapes name/address/note |
| `open-place-panel.ts` | `openPlacePanel(page, placeName) → OpenPlacePanelResult`; also exports `placeButtonName(placeName)`, `closeMembershipDropdown(page)` | Opens a place's detail panel and returns a Locator scoped to it, for reading/toggling its "Saved (N)" membership dropdown |
| `set-place-note.ts` | `appendPlaceNote(page, placeName, noteToAdd, listName?) → SetNoteOutcome` | Appends text to a place's note in the currently open list's feed, creating the note if it doesn't have one. `listName` is used only to label the mutation log entry |
| `copy-place-to-list.ts` | `(page, placeName, sourceListName, destinationListName, note?) → CopyOutcome` | Adds a place to a list via the Saved dropdown, skipping the click if already a member; if `note` is given, appends it to the place's note on the destination list |
| `remove-place-from-list.ts` | `(page, placeName, listName) → RemoveOutcome` | Removes a place from a list via the Saved dropdown, skipping the click if not a member |
| `move-place-to-list.ts` | `(page, placeName, src, dest, note?) → MoveOutcome` | Composes copy + remove: adds to `dest` first (carrying `note` over if given), then removes from `src` |
| `collect.ts` | `(context, listName) → string` | Full collect workflow — navigate, scroll, enrich, write JSON |
| `update.ts` | `(context, actionFilePath) → void` | Full update workflow — navigate, apply each action |

`collect.ts` and `update.ts` orchestrate the atomic modules above. The smaller modules are independently usable in scripts or future flows.

The three modules that actually change something in Maps — `copy-place-to-list.ts`, `remove-place-from-list.ts`, and `set-place-note.ts` — each call `logMutation()` from `src/logger.ts` immediately after the change settles. Instrumenting at this level rather than in `update.ts` means any future flow that composes these modules is recorded automatically. See [Session logging](#session-logging).

As it runs, `update.ts` also tracks which lists it wrote to (the source it removed from, plus any list it added to or noted on) and, once the run ends, passes them to `flagListsForResync()` in `src/resync.ts`. That stamps `dirtySince` onto the matching collection file(s) on disk so the home screen recommends a re-sync — but only for lists that are actually imported, since a mutation to a never-imported list has no snapshot to go stale. Flagging happens in the run's `finally`, so a cancelled or errored run still flags whatever it managed to change; the next collect overwrites the file and clears the stamp.

### Selector fragility

Google Maps uses dynamically generated CSS class names. All Playwright selectors prefer `aria-label`, `role`, and text-content attributes. Selectors that rely on internal class names or attributes are annotated:

- `// BRITTLE:` — known-fragile; will break when Maps deploys a new class hash
- `// UNCERTAIN:` — selector works in testing but the attribute may change by locale or Maps version

These annotations are the first things to check when a live Maps session breaks a flow.

### Browser persistence

Playwright launches a **persistent browser context** stored in `browser-data/` (git-ignored). This preserves the Google session between server restarts so login is only required once.
