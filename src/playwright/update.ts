import { type BrowserContext, type Page } from 'playwright';
import { unlinkSync } from 'fs';
import { basename } from 'path';
import type { ActionFile } from '../types.ts';
import { setUpdateState, broadcast } from '../state.ts';
import { logInfo, logError, getSessionLogPath } from '../logger.ts';
import { openSavedLists } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';
import { movePlaceToList } from './move-place-to-list.ts';
import { copyPlaceToList } from './copy-place-to-list.ts';
import { removePlaceFromList } from './remove-place-from-list.ts';
import { placeButtonName } from './open-place-panel.ts';
import { isCancelRequested, CancelledError } from './cancel.ts';
import { resetMutationTracking, flushResyncFlags } from '../mutations.ts';

export async function performUpdates(
  context: BrowserContext,
  actionFilePath: string,
  dryRun: boolean,
): Promise<void> {
  let errorCount = 0;
  let skipped = 0;
  /** Actions the loop got all the way through — used to report how far a cancelled run got. */
  let completedCount = 0;

  // Start from a clean slate: recordMutation (called deep in the mutation modules) accrues
  // the run's changed lists into module state, which flushResyncFlags() drains in finally.
  resetMutationTracking();

  const raw = await Bun.file(actionFilePath).text();
  const data: ActionFile = JSON.parse(raw);
  const { listName, actions } = data;

  let page: Page | undefined;

  try {
    // The intended actions are recorded here so the action file itself becomes
    // disposable — it is deleted once the run ends (see the finally block).
    logInfo(`${dryRun ? '[DRY RUN] ' : ''}Update run started on list "${listName}"`, {
      dryRun,
      listName,
      actions,
    });

    setUpdateState({
      status: 'running',
      message: `${dryRun ? '[DRY RUN] ' : ''}Opening Google Maps…`,
      progress: { current: 0, total: actions.length },
      dryRun,
    });

    try {
      page = await openSavedLists(context);
    } catch {
      throw new Error('Could not find the "Saved" button. Ensure you are logged in.');
    }

    setUpdateState({ message: 'Navigating to saved list…' });

    try {
      await openListByName(page, listName);
    } catch {
      throw new Error(`Source list "${listName}" not found.`);
    }

    await page.waitForTimeout(2_000);

    // Skips are a real outcome, not a non-event: without a record of them there is no way
    // to tell afterwards whether an action was applied or quietly passed over.
    const skip = (name: string, reason: string) => {
      skipped++;
      logInfo(`Skipped "${name}": ${reason}`, { place: name, list: listName });
      broadcast('skipped', { name, reason });
    };

    for (let i = 0; i < actions.length; i++) {
      // Checked between actions so a cancellation lands on a clean boundary rather than
      // partway through one — matching the loop checks in collect.ts.
      if (isCancelRequested()) throw new CancelledError();

      const action = actions[i];
      const label = `${dryRun ? '[DRY RUN] ' : ''}Processing ${i + 1}/${actions.length}: ${action.name}`;
      setUpdateState({ message: label, progress: { current: i + 1, total: actions.length } });
      broadcast('progress', { current: i + 1, total: actions.length, name: action.name });

      try {
        if (dryRun) {
          // Validate that the place button is present before reporting success.
          const placeBtn = page!.getByRole('button', { name: placeButtonName(action.name) });
          const isPresent = await placeBtn
            .waitFor({ state: 'visible', timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
          if (!isPresent) {
            skip(action.name, `no longer in "${listName}" (list may be out of sync) — would skip.`);
          } else {
            const noteSuffix = action.note ? ' and append its note' : '';
            const wouldDo = action.action === 'move'
              ? `remove from "${listName}" and add to "${action.targetList}"${noteSuffix}`
              : action.action === 'copy'
                ? `add to "${action.targetList}"${noteSuffix} (keeping it in "${listName}")`
                : `remove from "${listName}"`;
            logInfo(`[DRY RUN] Would ${wouldDo}: "${action.name}"`, { place: action.name, list: listName });
            broadcast('dryRunAction', { name: action.name, action: action.action, targetList: action.targetList });
          }
        } else if (action.action === 'move') {
          const outcome = await movePlaceToList(page!, action.name, listName, action.targetList!, action.note);
          if (outcome === 'not-in-source') {
            skip(action.name, `no longer in "${listName}" (list may be out of sync) — skipped.`);
          } else if (outcome === 'already-in-target') {
            skip(
              action.name,
              `was already in "${action.targetList}" — removed from "${listName}" without re-adding${action.note ? ' (note still appended)' : ''}.`,
            );
          }
        } else if (action.action === 'copy') {
          const outcome = await copyPlaceToList(page!, action.name, listName, action.targetList!, action.note);
          if (outcome === 'not-in-source') {
            skip(action.name, `no longer in "${listName}" (list may be out of sync) — skipped.`);
          } else if (outcome === 'already-in-target') {
            skip(
              action.name,
              `was already in "${action.targetList}" — nothing to add${action.note ? ' (note still appended)' : ''}.`,
            );
          }
        } else {
          const outcome = await removePlaceFromList(page!, action.name, listName);
          if (outcome === 'not-in-list') {
            skip(action.name, `no longer in "${listName}" (list may be out of sync) — skipped.`);
          }
        }
        completedCount++;
      } catch (err) {
        // Cancelling force-closes the browser, which makes whatever Playwright call was
        // in flight reject. That rejection lands here, but it is not a failure of this
        // action — recording it as one would log a bogus error for the action being
        // cancelled, plus one for every action after it as the loop kept going.
        if (isCancelRequested()) throw new CancelledError();

        errorCount++;
        const problem = err instanceof Error ? err.message : String(err);
        logError(`Failed on "${action.name}" in list "${listName}": ${problem}`, {
          place: action.name,
          list: listName,
          action: action.action,
        });
        broadcast('error', { name: action.name, problem });
      }
    }

    const logName = basename(getSessionLogPath());
    const skippedNote = skipped > 0 ? ` (${skipped} skipped as already up to date)` : '';
    const doneMessage = dryRun
      ? `Dry run complete. ${actions.length - errorCount}/${actions.length} selector(s) validated${skippedNote}. No changes were made.`
      : errorCount > 0
        ? `Done. ${actions.length - errorCount}/${actions.length} succeeded${skippedNote}. Check logs/${logName} for failures.`
        : `All ${actions.length} update(s) completed successfully${skippedNote}.`;

    logInfo(`Update run finished on list "${listName}"`, {
      dryRun,
      listName,
      total: actions.length,
      failed: errorCount,
      skipped,
    });

    setUpdateState({ status: 'done', message: doneMessage, errorCount, skippedCount: skipped });
  } catch (err) {
    const finalErr = isCancelRequested()
      ? new CancelledError()
      : err instanceof Error
        ? err
        : new Error(String(err));

    // Unlike a cancelled collect, which only ever read, a cancelled update may already
    // have written to Maps. Record how far it got — the mutations themselves are already
    // in the log above this entry, and this marks where they stop.
    logError(`Update run aborted on list "${listName}": ${finalErr.message}`, {
      listName,
      cancelled: finalErr instanceof CancelledError,
      completed: completedCount,
      total: actions.length,
    });

    const message =
      finalErr instanceof CancelledError && completedCount > 0
        ? `Cancelled by user after ${completedCount} of ${actions.length} action(s). Changes already made were not undone.`
        : finalErr.message;

    setUpdateState({ status: 'error', message });
    throw finalErr;
  } finally {
    // Flush the lists recordMutation accrued into re-sync flags. Done in the finally so a
    // run that errored or was cancelled partway still flags whatever it managed to change
    // before stopping — those mutations are already committed in Maps regardless of how the
    // run ended. No-ops for a dry run, which records no mutations.
    await flushResyncFlags().catch(() => {});

    // The action file only ever described intent, and that intent is now in the session
    // log — so it has no reason to outlive the run. Deleted on every exit path, including
    // failure and cancellation: a retry posts a fresh set of actions rather than reusing
    // this file, so keeping it around would only accumulate dead files.
    try {
      unlinkSync(actionFilePath);
    } catch {
      // Already gone, or never written — nothing to clean up.
    }
    // Close only this run's page, NOT the browser context. The context is cached and
    // reused across runs (see browser.ts); tearing it down here forced the next run to
    // relaunch launchPersistentContext() on the same profile dir, and a back-to-back
    // relaunch races Chromium's release of the profile's Singleton lock — the losing run
    // hangs on page.goto() and surfaces as a stuck "Opening Google Maps…". getBrowserContext()
    // already relaunches on its own if the context died (isUsable check), and the browser is
    // torn down explicitly via /api/browser/close and the cancel routes.
    await page?.close().catch(() => {});
  }
}
