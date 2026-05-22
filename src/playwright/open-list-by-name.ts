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
  // UNCERTAIN: button label includes a dynamic place-count suffix (e.g. "· 4 places") — use partial match.
  const listBtn = page.getByRole('button', { name: listName, exact: false });
  await listBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await listBtn.click();
  return page;
}
