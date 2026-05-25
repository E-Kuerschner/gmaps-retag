import { type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { ActionFile, ErrorEntry } from '../types.ts';
import { setUpdateState, broadcast } from '../state.ts';
import { isDryRun } from '../config.ts';
import { openSavedLists } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';

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
        // Find the place in the list by name.
        // BRITTLE: role="article" does not exist on place cards in the current Maps UI
        // (confirmed during collect work — actual wrapper is div.XiKgde, itself a brittle
        // obfuscated class). The aria-label fallback may also not match. If this stops
        // working, update to match whatever item selector collect.ts is using, scoped
        // with :has-text() to filter by name.
        const placeCard = page!
          .locator(`[role="article"]:has-text("${action.name}"), [aria-label*="${action.name}"]`)
          .first();

        try {
          await placeCard.waitFor({ state: 'visible', timeout: 8_000 });
        } catch {
          throw new Error(`Place card for "${action.name}" not visible in the list.`);
        }

        await placeCard.click();
        await page!.waitForTimeout(1_500);

        // UNCERTAIN: selector for the "Saved" / bookmark icon in the detail panel.
        // BRITTLE: data-value="Save" is an internal attribute with no semantic guarantee.
        const saveIconBtn = page!
          .locator('[aria-label*="Saved"], [data-value="Save"], button:has-text("Saved")')
          .first();

        try {
          await saveIconBtn.waitFor({ state: 'visible', timeout: 8_000 });
        } catch {
          throw new Error(`Could not find the Save/Saved icon for "${action.name}".`);
        }

        await saveIconBtn.click();
        await page!.waitForTimeout(1_000);

        // UNCERTAIN: popup container selector.
        const popup = page!.locator('[role="dialog"], [role="menu"]').last();
        try {
          await popup.waitFor({ state: 'visible', timeout: 6_000 });
        } catch {
          throw new Error(`Save-to-list popup did not appear for "${action.name}".`);
        }

        // UNCERTAIN: list entry selector inside popup.
        const currentListEntry = popup
          .locator(`[aria-label*="${listName}"], :has-text("${listName}")`)
          .first();
        try {
          await currentListEntry.waitFor({ state: 'visible', timeout: 5_000 });
        } catch {
          throw new Error(`Could not find "${listName}" entry in popup for "${action.name}".`);
        }

        let targetListEntry = null;
        if (action.action === 'move') {
          targetListEntry = popup
            .locator(`[aria-label*="${action.targetList}"], :has-text("${action.targetList}")`)
            .first();
          try {
            await targetListEntry.waitFor({ state: 'visible', timeout: 5_000 });
          } catch {
            throw new Error(
              `Could not find target list "${action.targetList}" in popup for "${action.name}".`,
            );
          }
        }

        if (isDryRun) {
          const wouldDo = action.action === 'move'
            ? `remove from "${listName}" and add to "${action.targetList}"`
            : `remove from "${listName}"`;
          console.log(`[dry-run] Would ${wouldDo}: ${action.name}`);
          broadcast('dryRunAction', { name: action.name, action: action.action, targetList: action.targetList });
          await page!.keyboard.press('Escape');
        } else {
          await currentListEntry.click();

          if (action.action === 'move') {
            await page!.waitForTimeout(500);
            await targetListEntry!.click();
          }

          await page!.waitForTimeout(800);
          try {
            const doneBtn = popup.locator('button:has-text("Done"), button:has-text("Close"), [aria-label="Close"]').first();
            const isDoneVisible = await doneBtn.isVisible();
            if (isDoneVisible) await doneBtn.click();
          } catch { /* popup may have already closed */ }
        }

        await page!.waitForTimeout(500);

        await page!.goBack({ waitUntil: 'domcontentloaded' });
        await page!.waitForTimeout(1_000);
      } catch (err) {
        errors.push({
          location: `"${action.name}" in list "${listName}"`,
          problem: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
        broadcast('error', { name: action.name, problem: errors[errors.length - 1].problem });

        try {
          await page!.goBack({ waitUntil: 'domcontentloaded' });
          await page!.waitForTimeout(1_000);
        } catch { /* ignore navigation errors */ }
      }
    }

    await saveErrors(errors, ts);

    const doneMessage = isDryRun
      ? `Dry run complete. ${actions.length - errors.length}/${actions.length} selector(s) validated. No changes were made.`
      : errors.length > 0
        ? `Done. ${actions.length - errors.length}/${actions.length} succeeded. Check logs/errors_${ts}.json for failures.`
        : `All ${actions.length} update(s) completed successfully.`;

    setUpdateState({ status: 'done', message: doneMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ location: `list "${listName}"`, problem: message, timestamp: new Date().toISOString() });
    await saveErrors(errors, ts);
    setUpdateState({ status: 'error', message });
    throw err;
  } finally {
    await page?.close();
  }
}
