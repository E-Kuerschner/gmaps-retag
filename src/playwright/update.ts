import { type BrowserContext } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { ActionFile, ErrorEntry } from '../types.ts';
import { setState, broadcast } from '../state.ts';
import { isDryRun } from '../config.ts';

const OUTPUT_DIR = join(process.cwd(), 'output');

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function saveErrors(errors: ErrorEntry[], ts: string): Promise<void> {
  if (errors.length === 0) return;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `errors_${ts}.json`);
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

  const page = await context.newPage();

  try {
    setState({
      phase: 'updating',
      message: `${isDryRun ? '[DRY RUN] ' : ''}Opening Google Maps…`,
      progress: { current: 0, total: actions.length },
    });

    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    setState({ message: 'Navigating to saved list…' });

    // Navigate to the source list — same flow as collect.
    // Selector for the "Saved" navigation rail button (no aria-label in current Maps UI).
    // BRITTLE: jsaction values are internal to Google's event framework — see collect.ts.
    const savedBtn = page
      .locator('[jsaction="navigationrail.saved"], button:has-text("Saved")')
      .first();
    try {
      await savedBtn.waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      throw new Error('Could not find the "Saved" button. Ensure you are logged in.');
    }
    await savedBtn.click();

    // UNCERTAIN: "Lists" tab selector.
    const listsTab = page.locator('button[role="tab"]:has-text("Lists"), [aria-label="Lists"]').first();
    try {
      await listsTab.waitFor({ state: 'visible', timeout: 10_000 });
      await listsTab.click();
    } catch {
      console.warn('[update] Could not find "Lists" tab; continuing.');
    }

    await page.waitForTimeout(1_500);

    // Open the source list.
    const listByAria = page.locator(`[aria-label="${listName}"]`).first();
    const listByText = page.locator(`text="${listName}"`).first();
    let clicked = false;
    try {
      await listByAria.waitFor({ state: 'visible', timeout: 5_000 });
      await listByAria.click();
      clicked = true;
    } catch { /* try text */ }
    if (!clicked) {
      try {
        await listByText.waitFor({ state: 'visible', timeout: 5_000 });
        await listByText.click();
        clicked = true;
      } catch { /* failed */ }
    }
    if (!clicked) {
      throw new Error(`Source list "${listName}" not found.`);
    }

    await page.waitForTimeout(2_000);

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const label = `${isDryRun ? '[DRY RUN] ' : ''}Processing ${i + 1}/${actions.length}: ${action.name}`;
      setState({ message: label, progress: { current: i + 1, total: actions.length } });
      broadcast('progress', { current: i + 1, total: actions.length, name: action.name });

      try {
        // Find the place in the list by name.
        // BRITTLE: role="article" does not exist on place cards in the current Maps UI
        // (confirmed during collect work — actual wrapper is div.XiKgde, itself a brittle
        // obfuscated class). The aria-label fallback may also not match. If this stops
        // working, update to match whatever item selector collect.ts is using, scoped
        // with :has-text() to filter by name.
        const placeCard = page
          .locator(`[role="article"]:has-text("${action.name}"), [aria-label*="${action.name}"]`)
          .first();

        try {
          await placeCard.waitFor({ state: 'visible', timeout: 8_000 });
        } catch {
          throw new Error(`Place card for "${action.name}" not visible in the list.`);
        }

        await placeCard.click();
        await page.waitForTimeout(1_500);

        // The place detail panel should now be open on the left.
        // UNCERTAIN: selector for the "Saved" / bookmark icon in the detail panel.
        // In the Maps UI it is typically a button with aria-label containing "Save"
        // or the label of the list it's already saved to.
        // BRITTLE: data-value="Save" is an internal attribute with no semantic
        // guarantee. The aria-label fallback is more durable but its exact wording
        // ("Saved", "Save to list", etc.) may vary by Maps version.
        const saveIconBtn = page
          .locator('[aria-label*="Saved"], [data-value="Save"], button:has-text("Saved")')
          .first();

        try {
          await saveIconBtn.waitFor({ state: 'visible', timeout: 8_000 });
        } catch {
          throw new Error(`Could not find the Save/Saved icon for "${action.name}".`);
        }

        await saveIconBtn.click();
        await page.waitForTimeout(1_000);

        // A popup/modal should appear showing the user's lists as checkboxes.
        // UNCERTAIN: the popup container and list-item selectors. Google Maps
        // renders these as a modal dialog with role="dialog" or a menu.
        const popup = page.locator('[role="dialog"], [role="menu"]').last();
        try {
          await popup.waitFor({ state: 'visible', timeout: 6_000 });
        } catch {
          throw new Error(`Save-to-list popup did not appear for "${action.name}".`);
        }

        // Resolve and validate all popup entries first — this exercises the
        // selectors regardless of whether dry-run is active.
        // UNCERTAIN: The list entry is likely a checkbox row labelled with
        // the list name. aria-checked="true" means currently saved to that list.
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
          // UNCERTAIN: target list entry selector.
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
          // Dismiss popup without making changes.
          await page.keyboard.press('Escape');
        } else {
          await currentListEntry.click();

          if (action.action === 'move') {
            await page.waitForTimeout(500);
            await targetListEntry!.click();
          }

          // Dismiss the popup — some Maps versions auto-close on selection,
          // others require pressing Escape or clicking outside.
          await page.waitForTimeout(800);
          try {
            // UNCERTAIN: close/done button inside the popup.
            const doneBtn = popup.locator('button:has-text("Done"), button:has-text("Close"), [aria-label="Close"]').first();
            const isDoneVisible = await doneBtn.isVisible();
            if (isDoneVisible) await doneBtn.click();
          } catch { /* popup may have already closed */ }
        }

        await page.waitForTimeout(500);

        // Navigate back to the list view before processing the next item.
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_000);
      } catch (err) {
        errors.push({
          location: action.name,
          problem: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
        broadcast('error', { name: action.name, problem: errors[errors.length - 1].problem });

        // Recover: navigate back to the list.
        try {
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1_000);
        } catch { /* ignore navigation errors */ }
      }
    }

    await saveErrors(errors, ts);

    const doneMessage = isDryRun
      ? `Dry run complete. ${actions.length - errors.length}/${actions.length} selector(s) validated. No changes were made.`
      : errors.length > 0
        ? `Done. ${actions.length - errors.length}/${actions.length} succeeded. Check errors_${ts}.json for failures.`
        : `All ${actions.length} update(s) completed successfully.`;

    setState({ phase: 'done', message: doneMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ location: `list "${listName}"`, problem: message, timestamp: new Date().toISOString() });
    await saveErrors(errors, ts);
    setState({ phase: 'error', message });
    throw err;
  } finally {
    await page.close();
  }
}
