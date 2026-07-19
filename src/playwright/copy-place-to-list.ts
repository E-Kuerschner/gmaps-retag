/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { copyPlaceToList } from './copy-place-to-list';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Chicago Private');
 *   await copyPlaceToList(page, 'Tuscan Hen Market', 'Chicago Private', 'Fort Worth/Dallas Shared', 'Great patio');
 */

import { type Page } from 'playwright';
import { openPlacePanel, closeMembershipDropdown } from './open-place-panel.ts';
import { resetToSavedListsPanel } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';
import { appendPlaceNote } from './set-place-note.ts';
import { logMutation } from '../logger.ts';

export type CopyOutcome = 'copied' | 'already-in-target' | 'not-in-source';

/**
 * Adds a saved place to destinationListName via the Saved dropdown, without touching
 * its membership in the list it's currently being viewed from. If note is given, also
 * writes it into the place's note on destinationListName — appended after whatever note
 * it may already have there (see set-place-note.ts), not overwriting it. Leaves the page
 * back on sourceListName's feed when done, since callers (including the update.ts loop
 * and move-place-to-list.ts's subsequent removePlaceFromList call) expect that list to
 * still be the one showing.
 *
 * Returns 'not-in-source' instead of throwing if the place isn't in the currently open
 * list — a stale collect snapshot may be out of sync with the list's current membership.
 * Returns 'already-in-target' if the place is already a member of the destination list;
 * clicking an already-checked menuitemradio would remove it instead of adding it. Note
 * copying still happens in this case — the place existing in the destination already
 * doesn't mean its note there is already up to date.
 */
export async function copyPlaceToList(
  page: Page,
  placeName: string,
  sourceListName: string,
  destinationListName: string,
  note?: string | null,
): Promise<CopyOutcome> {
  const opened = await openPlacePanel(page, placeName);
  if (opened === 'not-found') return 'not-in-source';

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

  // Select the destination list — adds the place to it.
  // Queried page-wide rather than scoped to opened.panel: the dropdown menu renders as
  // its own floating layer with a bounding box separate from the panel's (confirmed via
  // accessibility-tree inspection), not nested inside the panel's DOM subtree.
  // UNCERTAIN: radio label includes a dynamic place-count suffix — use partial match.
  // UNCERTAIN: assumes destinationListName isn't a prefix of another list's name (e.g.
  // "TEST 1" vs "TEST 10") — exact:false would then match the wrong menuitemradio.
  const destRadio = page.getByRole('menuitemradio', { name: destinationListName, exact: false });
  try {
    await destRadio.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    throw new Error(`Destination list "${destinationListName}" not found in membership dropdown for "${placeName}"`);
  }

  // RACE CONDITION: aria-checked briefly reads a stale/default value right after the
  // dropdown opens, before Maps' JS finishes syncing it from the place's real
  // membership — observed reading "false" for a list the place was actually a member
  // of. Give it a moment to settle before trusting the value.
  await page.waitForTimeout(500);
  // UNCERTAIN: assumes aria-checked reflects current membership as "true"/"false".
  const alreadyInTarget = (await destRadio.getAttribute('aria-checked')) === 'true';
  if (alreadyInTarget) {
    // Don't click — it's already selected, so clicking would deselect (remove) it.
    await closeMembershipDropdown(page);
  } else {
    await destRadio.click();
    // Give Maps a moment to persist the membership change over the network before the
    // note-copying step below navigates away — navigating too soon after the click can
    // cancel the in-flight request and silently drop the change.
    await page.waitForTimeout(1_000);
    // Logged after the settle wait, so the entry only exists once the change is committed.
    logMutation({ op: 'add-to-list', place: placeName, list: destinationListName });
    // Clicking a radio does not dismiss the menu, so close it explicitly — the same
    // cleanup the already-checked branch above does.
    await closeMembershipDropdown(page);
  }

  if (note) {
    // Notes live on the list's own feed (see set-place-note.ts), not the place panel we
    // currently have open — switch views to reach it.
    await resetToSavedListsPanel(page);
    await openListByName(page, destinationListName);
    await page.waitForTimeout(2_000);
    await appendPlaceNote(page, placeName, note, destinationListName);
  }

  // Return to sourceListName's feed on every path, note or not. Leaving this place's
  // panel open poisons the *next* place's run: openPlacePanel's already-open check matches
  // the leftover panel, so the next place never opens its own and ends up reading this
  // place's dropdown state. That is what made a copy queued right after a move report
  // 'already-in-target' and skip — the copy was reading the moved place's dropdown, where
  // the destination had just been checked.
  await resetToSavedListsPanel(page);
  await openListByName(page, sourceListName);
  await page.waitForTimeout(2_000);

  return alreadyInTarget ? 'already-in-target' : 'copied';
}
