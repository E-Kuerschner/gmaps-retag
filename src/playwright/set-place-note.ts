/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { appendPlaceNote } from './set-place-note';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Fort Worth/Dallas Shared');
 *   await appendPlaceNote(page, 'Tuscan Hen Market', 'Great patio for groups');
 */

import { type Page } from 'playwright';
import { recordMutation } from '../mutations.ts';

export type SetNoteOutcome = 'set' | 'appended' | 'not-found';

/**
 * Appends noteToAdd to placeName's note within the currently open list, creating the
 * note if it doesn't have one yet. Operates on the list's own feed (the same view
 * collect.ts scrapes notes from) — NOT the place detail panel opened via
 * open-place-panel.ts, which has no note field at all. Every card in a list's feed has
 * a note <textarea> regardless of whether it's been used yet (confirmed via DOM
 * inspection), but the textarea stays hidden until its sibling "Add note" button is
 * clicked once, which is why this only clicks that button when the textarea isn't
 * already visible.
 */
export async function appendPlaceNote(
  page: Page,
  placeName: string,
  noteToAdd: string,
  /** The currently open list. Not used to find anything — only to identify which list's
   *  note was written in the mutation log, since that log is what an undo would read. */
  listName?: string,
): Promise<SetNoteOutcome> {
  // BRITTLE: DxyBCb is the unique class on the outer scroll container — same one
  // collect.ts uses to find the feed. If scrolling/scraping selectors there stop
  // working, this needs the same fix.
  const feed = page.locator('div.DxyBCb').first();

  const escaped = placeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // BRITTLE: fontHeadlineSmall is a Maps typography utility class for the place name —
  // same one collect.ts relies on to find place cards.
  const item = feed
    .locator('button:has(.fontHeadlineSmall)')
    .filter({ has: page.locator('.fontHeadlineSmall', { hasText: new RegExp(`^${escaped}$`) }) })
    .first();
  const isPresent = await item
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!isPresent) return 'not-found';

  // UNCERTAIN: assumes the nearest ancestor <div> containing a note textarea is this
  // card's own container and not, say, a wrapper shared with an adjacent card. Verified
  // via DOM inspection this resolves to exactly one card per place, but it's a
  // structural assumption rather than a semantic attribute.
  const card = item.locator('xpath=ancestor::div[.//textarea[@aria-label="Note"]][1]');
  // UNCERTAIN: aria-label "Note" may vary by locale (same assumption collect.ts makes).
  const noteArea = card.locator('textarea[aria-label="Note"]');

  // The textarea exists in the DOM for every card but stays hidden until the "Add note"
  // button (present even for cards that already show note text — its accessible name
  // doesn't change) is clicked once to reveal/focus it.
  const alreadyVisible = await noteArea.isVisible().catch(() => false);
  if (!alreadyVisible) {
    const addNoteBtn = card.getByRole('button', { name: 'Add note' });
    await addNoteBtn.click();
    await noteArea.waitFor({ state: 'visible', timeout: 5_000 });
  }

  const existing = (await noteArea.inputValue()).trim();
  const combined = existing ? `${existing}\n\n${noteToAdd}` : noteToAdd;

  await noteArea.click();
  await noteArea.fill(combined);
  // Tab blurs the textarea, which is what persists the value — confirmed by rereading
  // it in a fresh page load after this.
  await page.keyboard.press('Tab');
  // Give Maps a moment to persist the note over the network before a caller potentially
  // navigates away or closes the browser — same reasoning as the settle waits in
  // copy-place-to-list.ts / remove-place-from-list.ts.
  await page.waitForTimeout(1_000);

  // Logged after the settle wait, so the entry only exists once the change is committed.
  // `previousNote` is the sole record of what the note said beforehand — Maps keeps no
  // history, and the collect snapshot is overwritten on every re-sync.
  recordMutation({
    op: 'append-note',
    place: placeName,
    list: listName ?? '(current list)',
    previousNote: existing || null,
    newNote: combined,
  });

  return existing ? 'appended' : 'set';
}
