/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { movePlaceToList } from './move-place-to-list';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Chicago Private');
 *   await movePlaceToList(page, 'Tuscan Hen Market', 'Chicago Private', 'Fort Worth/Dallas Shared');
 */

import { type Page } from 'playwright';

/**
 * Moves a saved place from sourceListName to destinationListName by deselecting the source
 * and selecting the destination in the place's list-membership dropdown.
 */
export async function movePlaceToList(
  page: Page,
  placeName: string,
  sourceListName: string,
  destinationListName: string,
): Promise<Page> {
  // UNCERTAIN: button label includes a dynamic star-rating suffix (e.g. "4.7 stars") — use partial match.
  const placeBtn = page.getByRole('button', { name: placeName, exact: false });
  await placeBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await placeBtn.click();

  // UNCERTAIN: "Saved" label and count format (e.g. "Saved (4)") may change.
  const savedBtn = () => page.getByRole('button', { name: /^Saved \(\d+\)/ });
  await savedBtn().waitFor({ state: 'visible', timeout: 15_000 });
  await savedBtn().click();

  // Deselect the source list — removes the place from it.
  // UNCERTAIN: radio label includes a dynamic place-count suffix — use partial match.
  const sourceRadio = page.getByRole('menuitemradio', { name: sourceListName, exact: false });
  await sourceRadio.waitFor({ state: 'visible', timeout: 10_000 });
  await sourceRadio.click();

  // The dropdown closes after a radio click — reopen it to select the destination.
  await savedBtn().waitFor({ state: 'visible', timeout: 10_000 });
  await savedBtn().click();

  // Select the destination list — adds the place to it.
  // UNCERTAIN: radio label includes a dynamic place-count suffix — use partial match.
  const destRadio = page.getByRole('menuitemradio', { name: destinationListName, exact: false });
  await destRadio.waitFor({ state: 'visible', timeout: 10_000 });
  await destRadio.click();

  return page;
}
