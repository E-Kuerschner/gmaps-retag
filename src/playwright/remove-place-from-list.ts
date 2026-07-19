/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { removePlaceFromList } from './remove-place-from-list';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Chicago Private');
 *   await removePlaceFromList(page, 'Tuscan Hen Market', 'Chicago Private');
 */

import { type Page } from 'playwright';
import { openPlacePanel, closeMembershipDropdown } from './open-place-panel.ts';
import { resetToSavedListsPanel } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';
import { logMutation } from '../logger.ts';

export type RemoveOutcome = 'removed' | 'not-in-list';

/**
 * Removes a named place from listName via the Saved dropdown — the same dropdown
 * used to add a place to a list (see copy-place-to-list.ts), just clicking an
 * already-checked list radio instead of an unchecked one.
 *
 * Returns 'not-in-list' instead of throwing if the place is already absent from the
 * page entirely, or already unchecked for listName in the dropdown — a stale collect
 * snapshot may be out of sync with the list's current membership, and the desired
 * end state (place not in listName) is already true.
 */
export async function removePlaceFromList(
  page: Page,
  placeName: string,
  listName: string,
): Promise<RemoveOutcome> {
  const opened = await openPlacePanel(page, placeName);
  if (opened === 'not-found') return 'not-in-list';

  // Scoped to the place's own panel — the panel's "Saved (N)" button shares its
  // accessible name ("Saved") with Maps' global nav-rail button, so this must not
  // be a page-wide query.
  // UNCERTAIN: button may read "Saved" or "Saved (4)" depending on context.
  const savedBtn = opened.panel.getByRole('button', { name: /^Saved( \(\d+\))?$/ });
  try {
    await savedBtn.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(`"Saved (N)" button not found for "${placeName}" after clicking the place`);
  }
  await savedBtn.click();

  // Deselect listName — removes the place from it.
  // Queried page-wide rather than scoped to opened.panel: the dropdown menu renders as
  // its own floating layer with a bounding box separate from the panel's (confirmed via
  // accessibility-tree inspection), not nested inside the panel's DOM subtree.
  // UNCERTAIN: radio label includes a dynamic place-count suffix — use partial match.
  // UNCERTAIN: assumes listName isn't a prefix of another list's name (e.g. "TEST 1" vs
  // "TEST 10") — exact:false would then match the wrong menuitemradio.
  const listRadio = page.getByRole('menuitemradio', { name: listName, exact: false });
  try {
    await listRadio.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    throw new Error(`List "${listName}" not found in membership dropdown for "${placeName}"`);
  }

  // RACE CONDITION: aria-checked briefly reads a stale/default value right after the
  // dropdown opens, before Maps' JS finishes syncing it from the place's real
  // membership — observed reading "false" for a list the place was actually a member
  // of. Give it a moment to settle before trusting the value.
  await page.waitForTimeout(500);
  // UNCERTAIN: assumes aria-checked reflects current membership as "true"/"false".
  const isMember = (await listRadio.getAttribute('aria-checked')) === 'true';
  if (!isMember) {
    // Don't click — it's already unchecked, so clicking would add it instead of removing it.
    await closeMembershipDropdown(page);
    await resetToSavedListsPanel(page);
    await openListByName(page, listName);
    await page.waitForTimeout(2_000);
    return 'not-in-list';
  }

  await listRadio.click();
  // Give Maps a moment to persist the membership change over the network before a
  // caller potentially closes the page/browser — closing too soon after the click
  // can cancel the in-flight request and silently drop the change.
  await page.waitForTimeout(1_000);
  // Logged after the settle wait, so the entry only exists once the change is committed.
  logMutation({ op: 'remove-from-list', place: placeName, list: listName });

  // Leave the page back on listName's feed rather than on this place's panel with its
  // dropdown still open. Clicking a radio doesn't dismiss the menu, and a leftover open
  // panel poisons the *next* place's run: openPlacePanel's already-open check matches the
  // stale panel, so the next place reads this place's dropdown state instead of its own.
  await closeMembershipDropdown(page);
  await resetToSavedListsPanel(page);
  await openListByName(page, listName);
  await page.waitForTimeout(2_000);
  return 'removed';
}
