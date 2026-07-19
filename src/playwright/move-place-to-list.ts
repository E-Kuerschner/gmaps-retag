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
import { copyPlaceToList } from './copy-place-to-list.ts';
import { removePlaceFromList } from './remove-place-from-list.ts';

export type MoveOutcome = 'moved' | 'already-in-target' | 'not-in-source';

/**
 * Moves a saved place from sourceListName to destinationListName by composing the two
 * atomic dropdown-toggle steps: add to the destination first, then remove from the
 * source — matching the order a person naturally performs it in, so a failure partway
 * through leaves the place in both lists rather than in neither. If note is given, it's
 * carried over to the destination's note the same way copyPlaceToList handles it
 * (appended after whatever note is already there) — see copy-place-to-list.ts.
 */
export async function movePlaceToList(
  page: Page,
  placeName: string,
  sourceListName: string,
  destinationListName: string,
  note?: string | null,
): Promise<MoveOutcome> {
  const addResult = await copyPlaceToList(page, placeName, sourceListName, destinationListName, note);
  if (addResult === 'not-in-source') return 'not-in-source';

  await removePlaceFromList(page, placeName, sourceListName);

  return addResult === 'already-in-target' ? 'already-in-target' : 'moved';
}
