import { type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { ActionFile, ErrorEntry } from '../types.ts';
import { setUpdateState, broadcast } from '../state.ts';
import { isDryRun } from '../config.ts';
import { closeBrowser } from './browser.ts';
import { openSavedLists } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';
import { movePlaceToList } from './move-place-to-list.ts';
import { removePlaceFromList } from './remove-place-from-list.ts';

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
): Promise<void> {
  const ts = timestamp();
  const errors: ErrorEntry[] = [];

  const raw = await Bun.file(actionFilePath).text();
  const data: ActionFile = JSON.parse(raw);
  const { listName, actions } = data;

  let page: Page | undefined;

  try {
    setUpdateState({
      status: 'running',
      message: `${isDryRun ? '[DRY RUN] ' : ''}Opening Google Maps…`,
      progress: { current: 0, total: actions.length },
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
      const label = `${isDryRun ? '[DRY RUN] ' : ''}Processing ${i + 1}/${actions.length}: ${action.name}`;
      setUpdateState({ message: label, progress: { current: i + 1, total: actions.length } });
      broadcast('progress', { current: i + 1, total: actions.length, name: action.name });

      try {
        if (isDryRun) {
          // Validate that the place button is present before reporting success.
          const placeBtn = page!.getByRole('button', { name: action.name, exact: false });
          try {
            await placeBtn.waitFor({ state: 'visible', timeout: 15_000 });
          } catch {
            throw new Error(`Place button for "${action.name}" not visible in the list.`);
          }
          const wouldDo = action.action === 'move'
            ? `remove from "${listName}" and add to "${action.targetList}"`
            : `remove from "${listName}"`;
          console.log(`[dry-run] Would ${wouldDo}: ${action.name}`);
          broadcast('dryRunAction', { name: action.name, action: action.action, targetList: action.targetList });
        } else if (action.action === 'move') {
          await movePlaceToList(page!, action.name, listName, action.targetList!);
        } else {
          await removePlaceFromList(page!, action.name);
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

    const doneMessage = isDryRun
      ? `Dry run complete. ${actions.length - errors.length}/${actions.length} selector(s) validated. No changes were made.`
      : errors.length > 0
        ? `Done. ${actions.length - errors.length}/${actions.length} succeeded. Check logs/errors_${ts}.json for failures.`
        : `All ${actions.length} update(s) completed successfully.`;

    setUpdateState({ status: 'done', message: doneMessage, errorCount: errors.length });
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
