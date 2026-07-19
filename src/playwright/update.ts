import { type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { ActionFile, ErrorEntry } from '../types.ts';
import { setUpdateState, broadcast } from '../state.ts';
import { closeBrowser } from './browser.ts';
import { openSavedLists } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';
import { movePlaceToList } from './move-place-to-list.ts';
import { copyPlaceToList } from './copy-place-to-list.ts';
import { removePlaceFromList } from './remove-place-from-list.ts';
import { placeButtonName } from './open-place-panel.ts';

const LOGS_DIR = join(process.cwd(), 'output', 'logs');

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function saveErrors(errors: ErrorEntry[], ts: string): Promise<void> {
  if (errors.length === 0) return;
  mkdirSync(LOGS_DIR, { recursive: true });
  const path = join(LOGS_DIR, `errors_${ts}.json`);
  await Bun.write(path, JSON.stringify(errors, null, 2));
  console.error(`[update] ${errors.length} error(s) written to ${path}`);
}

export async function performUpdates(
  context: BrowserContext,
  actionFilePath: string,
  dryRun: boolean,
): Promise<void> {
  const ts = timestamp();
  const errors: ErrorEntry[] = [];
  let skipped = 0;

  const raw = await Bun.file(actionFilePath).text();
  const data: ActionFile = JSON.parse(raw);
  const { listName, actions } = data;

  let page: Page | undefined;

  try {
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

    for (let i = 0; i < actions.length; i++) {
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
            skipped++;
            const reason = `"${action.name}" is no longer in "${listName}" (list may be out of sync) — would skip.`;
            console.log(`[dry-run] ${reason}`);
            broadcast('skipped', { name: action.name, reason });
          } else {
            const noteSuffix = action.note ? ' and append its note' : '';
            const wouldDo = action.action === 'move'
              ? `remove from "${listName}" and add to "${action.targetList}"${noteSuffix}`
              : action.action === 'copy'
                ? `add to "${action.targetList}"${noteSuffix} (keeping it in "${listName}")`
                : `remove from "${listName}"`;
            console.log(`[dry-run] Would ${wouldDo}: ${action.name}`);
            broadcast('dryRunAction', { name: action.name, action: action.action, targetList: action.targetList });
          }
        } else if (action.action === 'move') {
          const outcome = await movePlaceToList(page!, action.name, listName, action.targetList!, action.note);
          if (outcome === 'not-in-source') {
            skipped++;
            broadcast('skipped', {
              name: action.name,
              reason: `"${action.name}" is no longer in "${listName}" (list may be out of sync) — skipped.`,
            });
          } else if (outcome === 'already-in-target') {
            skipped++;
            broadcast('skipped', {
              name: action.name,
              reason: `"${action.name}" was already in "${action.targetList}" — removed from "${listName}" without re-adding${action.note ? ' (note still appended)' : ''}.`,
            });
          }
        } else if (action.action === 'copy') {
          const outcome = await copyPlaceToList(page!, action.name, listName, action.targetList!, action.note);
          if (outcome === 'not-in-source') {
            skipped++;
            broadcast('skipped', {
              name: action.name,
              reason: `"${action.name}" is no longer in "${listName}" (list may be out of sync) — skipped.`,
            });
          } else if (outcome === 'already-in-target') {
            skipped++;
            broadcast('skipped', {
              name: action.name,
              reason: `"${action.name}" was already in "${action.targetList}" — nothing to add${action.note ? ' (note still appended)' : ''}.`,
            });
          }
        } else {
          const outcome = await removePlaceFromList(page!, action.name, listName);
          if (outcome === 'not-in-list') {
            skipped++;
            broadcast('skipped', {
              name: action.name,
              reason: `"${action.name}" is no longer in "${listName}" (list may be out of sync) — skipped.`,
            });
          }
        }
      } catch (err) {
        errors.push({
          location: `"${action.name}" in list "${listName}"`,
          problem: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
        broadcast('error', { name: action.name, problem: errors[errors.length - 1].problem });
      }
    }

    await saveErrors(errors, ts);

    const skippedNote = skipped > 0 ? ` (${skipped} skipped as already up to date)` : '';
    const doneMessage = dryRun
      ? `Dry run complete. ${actions.length - errors.length}/${actions.length} selector(s) validated${skippedNote}. No changes were made.`
      : errors.length > 0
        ? `Done. ${actions.length - errors.length}/${actions.length} succeeded${skippedNote}. Check logs/errors_${ts}.json for failures.`
        : `All ${actions.length} update(s) completed successfully${skippedNote}.`;

    setUpdateState({ status: 'done', message: doneMessage, errorCount: errors.length, skippedCount: skipped });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ location: `list "${listName}"`, problem: message, timestamp: new Date().toISOString() });
    await saveErrors(errors, ts);
    setUpdateState({ status: 'error', message });
    throw err;
  } finally {
    await page?.close();
    await closeBrowser();
  }
}
