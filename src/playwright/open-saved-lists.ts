/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   // page is now showing the Maps saved-lists panel — continue with list-specific steps
 *   await page.close();
 */

import { type BrowserContext, type Page } from 'playwright';

/**
 * Resets an already-open Maps page back to the saved-lists overview panel, regardless
 * of current navigation depth (a specific list's feed, or an open place's detail panel
 * several clicks deep — confirmed this reset works from a place panel just as well as
 * from a list view, rather than needing to track how many "Back" clicks to issue).
 * Does not navigate/reload the page — only clicks the persistent nav rail, so it's
 * cheap to call between list-switches within a single flow (see copy-place-to-list.ts).
 */
export async function resetToSavedListsPanel(page: Page): Promise<void> {
  // BRITTLE: jsaction values are internal to Google's event framework and can be renamed.
  // Fallback to button text if the jsaction selector stops matching.
  const savedBtn = page
    .locator('[jsaction="navigationrail.saved"], button:has-text("Saved")')
    .first();

  try {
    await savedBtn.waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    throw new Error("The 'Saved' button was not found on Google Maps — you may not be logged in");
  }
  await savedBtn.click();

  // UNCERTAIN: "Lists" tab label may differ by locale.
  const listsTab = page.locator('button[role="tab"]:has-text("Lists"), [aria-label="Lists"]').first();
  try {
    await listsTab.waitFor({ state: 'visible', timeout: 10_000 });
    await listsTab.click();
  } catch {
    // No "Lists" tab found — lists may already be visible inline.
  }
}

/** Navigates to Google Maps and opens the saved lists panel, returning the page. */
export async function openSavedLists(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();

  // UNCERTAIN: domcontentloaded is safer than networkidle — Maps analytics may never settle.
  await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30_000 });

  await resetToSavedListsPanel(page);

  return page;
}
