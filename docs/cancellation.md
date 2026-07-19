# Cancellation

Playwright automation can hang — Maps never finishing a load, or a scroll loop that never detects it's reached the bottom. `POST /api/collect/cancel` and `POST /api/update/cancel` (wired to the _Cancel_ buttons on `/` and `/collections/:file`) handle this by:

1. Setting a module-level flag (`src/playwright/cancel.ts`) that `collect.ts`, `browse-saved-lists.ts`, `saved-list-names.ts`, and `update.ts` check between loop iterations, so a run that's merely looping stops on its next check.
2. Force-closing the persistent Playwright browser context. This is what actually unblocks a run that's stuck *inside* a single blocking call (`page.goto`, `locator.waitFor`, etc.) — closing the context makes Playwright reject that in-flight call immediately.

Either path lands in the flow's own `catch` block, which checks the cancellation flag and reports `"Cancelled by user."` as the terminal error state instead of whatever raw Playwright error surfaced.

Both workflows reset the flag when a run starts, so a cancellation never leaks into the next run.

## Cancelling an update is not an undo

Collect only ever reads, so stopping it loses nothing; an update may already have written to Maps by the time it's cancelled. Nothing is rolled back — the run stops where it is, and the terminal message reports how many actions completed (`Cancelled by user after 3 of 8 action(s). Changes already made were not undone.`). The mutations that did land are in the session log; see [Session logging](./session-logging.md).

Because force-closing the browser makes the in-flight Playwright call reject, that rejection surfaces inside `update.ts`'s per-action `catch`. That handler re-checks the cancel flag and rethrows, so a cancellation isn't recorded as a failure of the action it interrupted — and doesn't leave the loop running on to fail every remaining action.
