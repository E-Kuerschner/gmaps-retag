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

Click _Scan My Saved Lists_. A browser window opens, navigates to Google Maps, and reads the names of all your saved lists — no places are scraped yet, just the list names. Once it finishes, pick one from the dropdown (lists you've already imported are left out, since re-syncing those is handled below) and click _Import_. That runs the full import — opens the target list, scrolls to load all places, and scrapes each one's name and note. Progress appears live as places stream in. When the run completes, the page redirects automatically to the new collection.

Previously imported lists appear below with a "Last synced" timestamp. Since each is a point-in-time snapshot, click _Re-sync_ next to a list to refresh it. The page recommends a re-sync when the snapshot is over a week old, or when a later update has changed that list in Maps (moved or copied a place into it, removed one from it, or appended a note) so your imported copy no longer matches.

While a scan or import is running, a _Cancel_ button is available if it gets stuck.

**Step 2 — Review** (`/collections/:fileName`)

The collection page shows every place with its address and note. For each place choose _Keep_, _Remove_, _Move to…_, or _Copy to…_ (the latter two need a target list name). Places you leave as _Keep_ are ignored by the update. _Move_ removes the place from the source list once it's added to the target; _Copy_ adds it to the target list while leaving it in the source list. If the place has a note, _Copy_ and _Move_ carry it over to the target list — appended after whatever note the place already has there, if any, rather than overwriting it.

**Step 3 — Update** (same page)

Check _Dry run_ if you just want to validate selectors without touching real data, then click _Start Update_. The browser navigates back to Maps and applies every marked change. Progress is shown inline; individual failures are logged without stopping the rest of the run.

### Dry-run mode

Dry run is a per-update choice, not a server-wide setting: tick the _Dry run_ checkbox above the action table before clicking _Start Update_. The browser navigates all the way through to the save popup for each place and resolves every selector — but the final list-entry clicks are skipped. An amber banner appears on the collection page and it logs what _would_ have been applied instead of applying it.

Starting the server with `DRY_RUN=true` (or the `dev:dry` / `start:dry` scripts) forces every update to run as a dry run regardless of the checkbox — the checkbox is shown checked and disabled in that case. Use the env var for a server that should never write to Maps (e.g. a staging setup); use the per-update checkbox to validate a specific run on an otherwise live server.

### Cancelling a run

Both the import screen and the update screen have a _Cancel_ button for when the automation gets stuck (Maps never finishing a load, or a scroll loop that never reaches the bottom).

**Cancelling an update is not an undo.** An import only reads, so stopping it loses nothing. An update may already have written some changes to Maps by the time you cancel — those stay; the run just stops where it is and tells you how many actions completed. See [docs/cancellation.md](./docs/cancellation.md) for the details.

## Where your data lives

Everything is written to `output/` (git-ignored) and never leaves your machine: your imported collections, the list of saved-list names, and a per-session change log under `output/logs/`. The change log records every write the tool makes to Maps, at a level detailed enough to reverse it by hand. See [docs/architecture.md](./docs/architecture.md#output-files) for the file formats and [docs/session-logging.md](./docs/session-logging.md) for the log.

## How it works

For contributors: the design — process model, state and SSE communication, the Playwright module breakdown, and how selectors are kept resilient to Maps changes — is documented under [`docs/`](./docs):

- [docs/architecture.md](./docs/architecture.md) — process model, state, routing, SSE, Playwright modules, output files
- [docs/session-logging.md](./docs/session-logging.md) — the per-session change log and how it supports undo-by-hand
- [docs/cancellation.md](./docs/cancellation.md) — how cancelling a stuck run works
