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

/** Navigates to Google Maps and opens the saved lists panel, returning the page. */
export async function openSavedLists(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();

  // UNCERTAIN: domcontentloaded is safer than networkidle — Maps analytics may never settle.
  await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30_000 });

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

  return page;
}
