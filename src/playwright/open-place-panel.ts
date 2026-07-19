/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';
 *   import { openListByName } from './open-list-by-name';
 *   import { openPlacePanel } from './open-place-panel';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   await openListByName(page, 'Chicago Private');
 *   const result = await openPlacePanel(page, 'Tuscan Hen Market');
 *   if (result !== 'not-found') {
 *     // result.panel is scoped to this place's detail panel — use it to find
 *     // the "Saved (N)" button without matching the global nav-rail "Saved" button.
 *     await result.panel.getByRole('button', { name: /^Saved( \(\d+\))?$/ }).click();
 *   }
 */

import { type Locator, type Page } from 'playwright';

export type OpenPlacePanelResult = { panel: Locator } | 'not-found';

/**
 * Matches accessible names that start with placeName, unlike Playwright's own
 * exact:false which matches placeName anywhere in the name. That distinction matters:
 * a place's hero image button is labeled "Photo of <placeName>", which contains
 * placeName as a substring and made an unanchored match ambiguous (observed: "Roscoe
 * Village" matched both the actual row button and "Photo of Roscoe Village").
 */
export function placeButtonName(placeName: string): RegExp {
  const escaped = placeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}`, 'i');
}

/**
 * Clicks a place's list-row button and returns a Locator scoped to its detail panel.
 * Idempotent: if the panel is already open for this place (e.g. a caller reopens it
 * after dismissing a membership dropdown — see closeMembershipDropdown in
 * copy-place-to-list.ts / remove-place-from-list.ts), returns it directly without
 * re-searching for the list-row button — opening a place navigates the panel, replacing
 * the list view, so that button no longer exists once you're already viewing the place.
 *
 * Scoping matters: the detail panel's own "Saved (N)" button has the same accessible
 * name ("Saved") as Maps' global nav-rail button, so an unscoped page-wide query can
 * match the wrong one. Retries the click a few times because the panel occasionally
 * fails to open on the first click (observed flakiness, likely an animation/timing
 * issue) — if that happens silently, code relying on an unscoped "Saved" button match
 * would proceed against the nav-rail button instead of erroring.
 *
 * Returns 'not-found' instead of throwing if the place button never appears at all —
 * a stale collect snapshot may be out of sync with the list's current membership.
 */
export async function openPlacePanel(page: Page, placeName: string): Promise<OpenPlacePanelResult> {
  // UNCERTAIN: business-place panels expose an accessible name matching the place, but
  // neighborhood/area entries (e.g. "Roscoe Village") don't — their "main" landmark has
  // no computed name at all. Match on visible text content instead, which both use.
  // The underlying list panel also contains the place's name as one of its rows and is
  // never fully unmounted, so this resolves to 2+ elements; the place's own detail panel
  // is reliably the last one rendered — narrow to it with .last() so callers get a
  // single-element Locator.
  const panel = page.getByRole('main').filter({ hasText: placeName }).last();

  // Can't just check panel.isVisible() — the underlying list view is itself a "main"
  // landmark containing this place's name as one of its rows, so it visibly matches
  // even before anything has been clicked. A place's own detail panel is distinguished
  // by having a "Saved (N)" button as a descendant; the list view doesn't.
  const alreadyOpen = await panel
    .getByRole('button', { name: /^Saved( \(\d+\))?$/ })
    .isVisible()
    .catch(() => false);
  if (alreadyOpen) return { panel };

  // UNCERTAIN: button label includes a dynamic star-rating suffix (e.g. "4.7 stars") — use partial match.
  const placeBtn = page.getByRole('button', { name: placeButtonName(placeName) });
  const isPresent = await placeBtn
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!isPresent) return 'not-found';

  for (let attempt = 0; attempt < 3; attempt++) {
    await placeBtn.click();
    const opened = await panel
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return { panel };
  }

  throw new Error(`Place panel for "${placeName}" did not open after 3 attempts`);
}

/**
 * Dismisses an open place-membership dropdown (the "Saved (N)" menu) without navigating
 * away from the place panel. Clicking the trigger button again doesn't work — the open
 * menu's own overlay intercepts the click. Pressing Escape doesn't work either — it
 * closes the entire place panel, not just the menu, kicking the flow back out to the
 * list view. Clicking the map canvas outside the right-hand panel closes just the menu.
 *
 * UNCERTAIN: (50, 100) sits on top of the left nav rail's "Ask Maps" icon, not open
 * map canvas — confirmed with document.elementFromPoint(50, 100) while the dropdown
 * was open, which returned an unlabeled generic <div>, not the nav icon. This works
 * because the open dropdown has its own full-viewport backdrop that intercepts clicks
 * anywhere outside the menu (standard click-outside-to-close behavior) and absorbs this
 * click before it reaches "Ask Maps" underneath. That only holds while the dropdown is
 * actually open — calling this with no dropdown open would click "Ask Maps" for real.
 * Only ever call it right after detecting an already-checked/unchecked radio, per the
 * existing callers in copy-place-to-list.ts / remove-place-from-list.ts.
 */
export async function closeMembershipDropdown(page: Page): Promise<void> {
  await page.mouse.click(50, 100);
}
