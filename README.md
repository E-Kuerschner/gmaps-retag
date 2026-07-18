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
/                         Home
└── /collect              Collect — import a new list or browse previously imported ones
    └── /collections/:f   Collection — review places, assign actions, run update
```

Each collection is a permanent URL. Browser back and forward work naturally throughout.

### Workflow

**Step 1 — Collect** (`/collect`)

Enter the exact name of a Google Maps saved list and click _Import List_. A browser window opens, navigates to Google Maps, and first captures the names of all your saved lists (written to `output/saved-lists.json` for use in the _Move to…_ dropdown and the list picker described below). It then opens the target list, scrolls to load all places, and scrapes each one's name and note. Progress appears live as places stream in. When the run completes, the page redirects automatically to the new collection.

If you don't know the exact list name, click _Browse My Lists_ instead. This opens the same kind of browser window solely to read your saved list names (writing them to `output/saved-lists.json`, same as above) — no places are scraped yet. Once it finishes, the names appear as clickable pills; picking one runs the normal import for that list.

Previously imported lists appear below the form with a "Last synced" timestamp — since each is a point-in-time snapshot, re-import a list (by name or by browsing) to refresh it if it's been a while (the page flags anything older than a week and suggests a re-sync).

**Step 2 — Review** (`/collections/:fileName`)

The collection page shows every place with its address and note. For each place choose _Keep_, _Remove_, or _Move to…_ (and type a target list name). Places you leave as _Keep_ are ignored by the update.

**Step 3 — Update** (same page)

Check _Dry run_ if you just want to validate selectors without touching real data, then click _Start Update_. The browser navigates back to Maps and applies every marked change. Progress is shown inline; individual failures are logged without stopping the rest of the run. The actions file is written to `output/` for reference.

### Dry-run mode

Dry run is a per-update choice, not a server-wide setting: tick the _Dry run_ checkbox above the action table before clicking _Start Update_. The browser navigates all the way through to the save popup for each place and resolves every selector — but the final list-entry clicks are skipped. An amber banner appears on the collection page and it logs what _would_ have been applied instead of applying it.

Starting the server with `DRY_RUN=true` (or the `dev:dry` / `start:dry` scripts) forces every update to run as a dry run regardless of the checkbox — the checkbox is shown checked and disabled in that case. Use the env var for a server that should never write to Maps (e.g. a staging setup); use the per-update checkbox to validate a specific run on an otherwise live server.

## Output files

Everything is written to `output/` (git-ignored except `.gitkeep`):

| File pattern | Contents |
|---|---|
| `saved-lists.json` | Names of all saved lists — refreshed on each collect run, used to populate the _Move to…_ dropdown |
| `{list}_{ts}.json` | Scraped collection — places with name, address, and note |
| `{list}_{ts}_actions.json` | Actions confirmed on the collection page (created when update starts) |
| `errors_{ts}.json` | Per-item failures from either workflow |

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
  collect: CollectWorkflow;   // watched by /collect
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
GET  /                           → index.html
GET  /collect                    → collect.html
GET  /collections/:fileName      → collection.html

GET  /api/events                 → SSE stream (broadcasts AppState on every mutation)
GET  /api/saved-lists            → names of all saved lists (from output/saved-lists.json, or [] if not yet collected)
GET  /api/collect-files          → list of collection JSON files in output/
GET  /api/collections/:fileName  → contents of a specific collection JSON
DEL  /api/collect-files/:name    → delete a collection file

POST /api/log-error              → { message } — write a client-side error entry to output/errors_{ts}.json

POST /api/collect/start          → { listName } — launch collect workflow
POST /api/collect/browse-lists   → scrape all saved list names (no listName needed); writes output/saved-lists.json and broadcasts a savedLists event
POST /api/collect/reset          → reset collect workflow to idle

POST /api/update/start           → { collectionFile, actions[], dryRun? } — write action file, launch update workflow (dryRun forced true if server started with DRY_RUN=true)
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
    │ ◀── event: state (done/error) ──── │  terminal state
```

Playwright runs fire-and-forget from inside the API handler. The HTTP response returns as soon as the workflow is launched; all subsequent progress arrives over SSE.

### Playwright modules

Navigation to Google Maps is broken into composable, reusable steps in `src/playwright/`:

| Module | Signature | What it does |
|---|---|---|
| `browser.ts` | `getBrowserContext()` | Creates/reuses the persistent Chromium profile in `browser-data/` |
| `open-saved-lists.ts` | `(context) → Page` | Navigates to Maps and opens the saved-lists panel |
| `open-list-by-name.ts` | `(page, listName) → Page` | Clicks a named list in the panel |
| `saved-list-names.ts` | `scrapeSavedListNames(page)`, `writeSavedListNames(dir, names)` | Reads list names from the open saved-lists panel and persists them |
| `browse-saved-lists.ts` | `(context) → void` | Standalone flow: open saved lists, scrape names only, write JSON, broadcast — used by the "Browse My Lists" picker |
| `get-place-details.ts` | `(page, placeName) → PlaceDetails` | Clicks a place, scrapes name/address/note |
| `remove-place-from-list.ts` | `(page, placeName) → Page` | Hovers to reveal the delete button and removes the place |
| `move-place-to-list.ts` | `(page, placeName, src, dest) → Page` | Moves a place between lists via the Saved dropdown |
| `collect.ts` | `(context, listName) → string` | Full collect workflow — navigate, scroll, enrich, write JSON |
| `update.ts` | `(context, actionFilePath) → void` | Full update workflow — navigate, apply each action |

`collect.ts` and `update.ts` orchestrate the atomic modules above. The smaller modules are independently usable in scripts or future flows.

### Selector fragility

Google Maps uses dynamically generated CSS class names. All Playwright selectors prefer `aria-label`, `role`, and text-content attributes. Selectors that rely on internal class names or attributes are annotated:

- `// BRITTLE:` — known-fragile; will break when Maps deploys a new class hash
- `// UNCERTAIN:` — selector works in testing but the attribute may change by locale or Maps version

These annotations are the first things to check when a live Maps session breaks a flow.

### Browser persistence

Playwright launches a **persistent browser context** stored in `browser-data/` (git-ignored). This preserves the Google session between server restarts so login is only required once.
