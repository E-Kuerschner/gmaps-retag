/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Chicago Private');
 *   // page is now showing the place list — continue with place-specific steps
 */

import { type Page } from 'playwright';

/** Opens a named saved list from the saved lists panel. */
export async function openListByName(page: Page, listName: string): Promise<Page> {
  // The button label includes a dynamic suffix (e.g. "· 4 places") so we can't use exact role matching.
  // Instead match the .fontBodyLarge child, which contains only the bare list name, with an anchored regex.
  const escaped = listName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const listBtn = page.locator('button').filter({
    has: page.locator('.fontBodyLarge', { hasText: new RegExp(`^${escaped}$`) }),
  });
  try {
    await listBtn.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(`List "${listName}" not found in the saved lists panel`);
  }
  await listBtn.click();
  return page;
}
