import { type BrowserContext } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Place, CollectedList, ErrorEntry } from '../types.ts';
import { setState, broadcast } from '../state.ts';

const OUTPUT_DIR = join(process.cwd(), 'output');

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '_');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function saveErrors(errors: ErrorEntry[], ts: string): Promise<void> {
  if (errors.length === 0) return;
  const path = join(OUTPUT_DIR, `errors_${ts}.json`);
  await Bun.write(path, JSON.stringify(errors, null, 2));
  console.error(`[collect] ${errors.length} error(s) written to ${path}`);
}

export async function collectList(
  context: BrowserContext,
  listName: string,
): Promise<string> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const page = await context.newPage();
  const errors: ErrorEntry[] = [];
  const places: Place[] = [];
  const ts = timestamp();

  try {
    setState({ phase: 'collecting', listName, places: [], message: 'Opening Google Maps…' });

    // UNCERTAIN: Google Maps may redirect or require login. Using networkidle
    // can time out if ads/analytics never settle — domcontentloaded is safer.
    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Give the user a moment to log in if the session isn't already authenticated.
    setState({ message: 'Waiting for Google Maps to load. Please log in if prompted.' });

    // Selector for the "Saved" navigation rail button.
    // Primary: jsaction attribute is a stable internal identifier.
    // Fallback: button containing the text "Saved".
    // Does NOT have aria-label or data-tooltip in the current Maps UI.
    // BRITTLE: jsaction values are internal to Google's event framework and can
    // be renamed in any Maps deploy. If this breaks, rely on the text fallback
    // or inspect the nav rail for a new jsaction value.
    const savedBtn = page
      .locator('[jsaction="navigationrail.saved"], button:has-text("Saved")')
      .first();

    try {
      await savedBtn.waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      throw new Error(
        'Could not find the "Saved" button. Make sure you are logged into Google Maps.',
      );
    }

    await savedBtn.click();
    setState({ message: 'Navigating to Lists…' });

    // UNCERTAIN: Google Maps shows tabs labelled "Favourites", "Starred places",
    // "Want to go", "Travelled", and custom list names. The "Lists" tab that
    // shows *all* user-created lists may be labelled differently in some locales.
    // Try tab text first, fall back to role=tab selector.
    const listsTab = page.locator('button[role="tab"]:has-text("Lists"), [aria-label="Lists"]').first();
    try {
      await listsTab.waitFor({ state: 'visible', timeout: 10_000 });
      await listsTab.click();
    } catch {
      // If there is no "Lists" tab the UI may show lists inline — carry on.
      console.warn('[collect] Could not find "Lists" tab; assuming lists are already visible.');
    }

    setState({ message: `Looking for list "${listName}"…` });
    await page.waitForTimeout(1_500);

    // UNCERTAIN: List cards in the saved section. Google Maps renders them as
    // clickable divs/buttons. Trying aria-label match first, then text content.
    const byAria = page.locator(`[aria-label="${listName}"]`).first();
    const byText = page.locator(`text="${listName}"`).first();

    let clicked = false;
    try {
      await byAria.waitFor({ state: 'visible', timeout: 5_000 });
      await byAria.click();
      clicked = true;
    } catch { /* try byText next */ }

    if (!clicked) {
      try {
        await byText.waitFor({ state: 'visible', timeout: 5_000 });
        await byText.click();
        clicked = true;
      } catch { /* failed */ }
    }

    if (!clicked) {
      throw new Error(`List "${listName}" was not found in your saved lists.`);
    }

    setState({ message: `Opened list "${listName}". Collecting places…` });
    await page.waitForTimeout(2_000);

    // Scrollable container for place items.
    // BRITTLE: DxyBCb is the unique class on the outer scroll container. Individual
    // place items share XiKgde with the container but not DxyBCb. If scrolling
    // stops working, inspect the container element and update this selector.
    const feed = page.locator('div.DxyBCb').first();

    // Scroll to the absolute bottom, wait for lazy-loaded items to render, then
    // check if the scrollHeight grew (meaning new content appeared). Repeat until
    // we are truly at the bottom.
    setState({ message: `Opened list "${listName}". Scrolling to load all places…` });
    while (true) {
      try {
        await feed.evaluate((el) => { el.scrollTo(0, el.scrollHeight); });
      } catch {
        // Feed element not found — fall back to pressing End and assume one pass is enough.
        await page.keyboard.press('End');
        break;
      }
      await page.waitForTimeout(800); // let lazy-loaded items render
      const atBottom = await feed.evaluate(
        (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      ).catch(() => true);
      if (atBottom) break;
    }

    // Collect all place items now that the full list is loaded.
    // BRITTLE: XiKgde is a minified/obfuscated class name shared by both the
    // scroll container (DxyBCb) and individual items. :not(.DxyBCb) excludes the
    // container. If count comes back 0, inspect a place card and update this selector.
    const items = page.locator('div.XiKgde:not(.DxyBCb)');
    const total = await items.count();

    setState({ message: `Found ${total} place(s). Extracting details…` });

    for (let i = 0; i < total; i++) {
      const item = items.nth(i);
      try {
        // Place name is in .fontHeadlineSmall within the item card.
        // BRITTLE: fontHeadlineSmall is a Maps utility class — less likely to
        // change than a random hash class, but still not a semantic attribute.
        // Fallback: try 'h3' or '[aria-label]' on the clickable button within the item.
        const nameEl = item.locator('.fontHeadlineSmall').first();
        const name = (await nameEl.textContent())?.trim();
        if (!name) {
          throw new Error('Could not read place name');
        }

        // The update flow finds places by name within the open list and does not
        // navigate to individual place URLs, so link is not needed here.
        const link = '';

        places.push({ name, link });
        broadcast('place', { name, link });
        setState({ message: `Collected ${places.length} / ${total}: ${name}` });
      } catch (err) {
        errors.push({
          location: `Item ${i} in list "${listName}"`,
          problem: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Persist the collected data.
    const outputFile = join(OUTPUT_DIR, `${safeFileName(listName)}_${ts}.json`);
    const data: CollectedList = {
      listName,
      timestamp: new Date().toISOString(),
      places,
    };
    await Bun.write(outputFile, JSON.stringify(data, null, 2));
    await saveErrors(errors, ts);

    setState({ phase: 'review', places, outputFile, message: `Collected ${places.length} place(s).` });
    return outputFile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ location: `list "${listName}"`, problem: message, timestamp: new Date().toISOString() });
    await saveErrors(errors, ts);
    setState({ phase: 'error', message });
    throw err;
  } finally {
    await page.close();
  }
}
