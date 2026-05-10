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

    // UNCERTAIN: Selector for the "Saved" entry in the left-panel navigation.
    // In the current Maps UI it is a button/link rendered with aria-label="Saved"
    // inside the header bar. If this fails, try '[data-tooltip="Saved"]' or
    // 'a[href*="/maps/save"]'.
    const savedBtn = page
      .locator('[aria-label="Saved"], [data-tooltip="Saved"]')
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

    // UNCERTAIN: The scrollable container for place items within a saved list.
    // In the Maps UI the feed pane has role="feed" or a class like "m6QErb".
    // We scroll this container to trigger lazy-loading.
    const feed = page.locator('[role="feed"], .m6QErb').first();

    // Scroll until no new items load for 3 consecutive attempts.
    let previousCount = 0;
    let stableRounds = 0;
    while (stableRounds < 3) {
      // UNCERTAIN: place item selector within the feed. Article role is common
      // in Maps; fallback to any div with a data-result-index attribute.
      const items = page.locator('[role="feed"] [role="article"], [data-result-index]');
      const count = await items.count();

      if (count === previousCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
        previousCount = count;
      }

      try {
        await feed.evaluate((el) => el.scrollBy(0, 600));
      } catch {
        // Feed element not found — fall back to page scroll.
        await page.keyboard.press('End');
      }
      await page.waitForTimeout(800);
    }

    // Re-query after scrolling.
    // UNCERTAIN: exact selectors — adjust if items are not captured.
    const items = page.locator('[role="feed"] [role="article"], [data-result-index]');
    const total = await items.count();

    setState({ message: `Found ${total} place(s). Extracting details…` });

    for (let i = 0; i < total; i++) {
      const item = items.nth(i);
      try {
        // UNCERTAIN: place name is typically in an <h3> or an element with
        // aria-label inside the article. Try both.
        const nameEl = item.locator('h3, [aria-label]').first();
        let name = (await nameEl.textContent())?.trim();
        if (!name) {
          name = (await nameEl.getAttribute('aria-label'))?.trim();
        }
        if (!name) {
          throw new Error('Could not read place name');
        }

        // UNCERTAIN: the place link. Each article usually contains an <a> whose
        // href points to the Maps place URL.
        const linkEl = item.locator('a[href]').first();
        const link = (await linkEl.getAttribute('href'))?.trim() ?? '';

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
