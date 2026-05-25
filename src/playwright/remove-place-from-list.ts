/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { removePlaceFromList } from './remove-place-from-list';
 *
 *   const context = await getBrowserContext();
 *   const listName = 'Fort Worth/Dallas Shared';
 *   const placeName = 'Tuscan Hen Market';
 *
 *   const page = await openSavedLists(context);
 *   await openListByName(page, listName);
 *   await removePlaceFromList(page, placeName);
 */

import { type Page } from 'playwright';

/** Removes a named place from the currently open saved list. */
export async function removePlaceFromList(page: Page, placeName: string): Promise<Page> {
  // UNCERTAIN: button label may include a dynamic star-rating suffix — use partial match.
  const placeBtn = page.getByRole('button', { name: placeName, exact: false });
  try {
    await placeBtn.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(`Place button for "${placeName}" not visible in the list`);
  }
  await placeBtn.hover();

  // UNCERTAIN: "Delete" label may vary by locale or Maps update; could also be "Remove".
  const deleteBtn = page.getByRole('button', { name: /^Delete$|^Remove$/ });
  try {
    await deleteBtn.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    throw new Error(`Delete/Remove button did not appear after hovering "${placeName}"`);
  }
  await deleteBtn.click();

  return page;
}
