/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { getPlaceDetails } from './get-place-details';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Fort Worth/Dallas Shared');
 *   const details = await getPlaceDetails(page, 'Orangetheory Fitness');
 *   // details: { name, address, note }
 */

import { type Page } from 'playwright';

export interface PlaceDetails {
  name: string;
  address: string;
  note: string | null;
}

/** Clicks a named place in the currently open list and scrapes its name, address, and optional note. */
export async function getPlaceDetails(page: Page, placeName: string): Promise<PlaceDetails> {
  // UNCERTAIN: button label may include a dynamic star-rating suffix — use partial match.
  const placeBtn = page.getByRole('button', { name: placeName, exact: false });
  await placeBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await placeBtn.click();

  // UNCERTAIN: place name may be in an h1 or a different heading role depending on Maps version.
  const nameEl = page.locator('h1').first();
  await nameEl.waitFor({ state: 'visible', timeout: 15_000 });
  const name = (await nameEl.textContent()) ?? placeName;

  // Address button aria-label is prefixed with "Address: " followed by the full address.
  // UNCERTAIN: prefix label may change by locale.
  const addressBtn = page.getByRole('button', { name: /^Address:/ });
  await addressBtn.waitFor({ state: 'visible', timeout: 10_000 });
  const addressLabel = (await addressBtn.getAttribute('aria-label')) ?? '';
  const address = addressLabel.replace(/^Address:\s*/, '');

  // Note panel is revealed by clicking the "Saved in <list>" button — not all places have notes.
  // UNCERTAIN: button label includes the dynamic list name — use partial match.
  let note: string | null = null;
  const savedInBtn = page.getByRole('button', { name: /^Saved in / });
  if (await savedInBtn.isVisible()) {
    await savedInBtn.click();
    const noteBox = page.getByRole('textbox', { name: 'Edit note' });
    try {
      await noteBox.waitFor({ state: 'visible', timeout: 5_000 });
      const text = (await noteBox.inputValue()).trim();
      note = text.length > 0 ? text : null;
    } catch {
      // Note panel didn't appear — treat as no note.
    }
  }

  return { name, address, note };
}
