import { type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Place, CollectedList, ErrorEntry } from '../types.ts';
import { setCollectState, broadcast } from '../state.ts';
import { openSavedLists } from './open-saved-lists.ts';
import { openListByName } from './open-list-by-name.ts';

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

  let page: Page | undefined;
  const errors: ErrorEntry[] = [];
  const places: Place[] = [];
  const ts = timestamp();

  try {
    setCollectState({ status: 'running', listName, message: 'Opening Google Maps…' });

    setCollectState({ message: 'Waiting for Google Maps to load. Please log in if prompted.' });
    try {
      page = await openSavedLists(context);
    } catch {
      throw new Error(
        'Could not find the "Saved" button. Make sure you are logged into Google Maps.',
      );
    }

    setCollectState({ message: `Looking for list "${listName}"…` });
    try {
      await openListByName(page, listName);
    } catch {
      throw new Error(`List "${listName}" was not found in your saved lists.`);
    }

    setCollectState({ message: `Opened list "${listName}". Scrolling to load all places…` });
    await page.waitForTimeout(2_000);

    // Scrollable container for place items.
    // BRITTLE: DxyBCb is the unique class on the outer scroll container. Individual
    // place items share XiKgde with the container but not DxyBCb. If scrolling
    // stops working, inspect the container element and update this selector.
    const feed = page.locator('div.DxyBCb').first();

    while (true) {
      try {
        await feed.evaluate((el) => { el.scrollTo(0, el.scrollHeight); });
      } catch {
        await page.keyboard.press('End');
        break;
      }
      await page.waitForTimeout(800);
      const atBottom = await feed.evaluate(
        (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      ).catch(() => true);
      if (atBottom) break;
    }

    // Collect all place cards now that the full list is loaded.
    // Place cards are <button> elements inside the scroll container that wrap the place name,
    // address, and thumbnail. Scoping inside feed avoids matching buttons elsewhere on the page.
    // BRITTLE: fontHeadlineSmall is a Maps typography utility class used for the place name;
    // it is less likely to change than obfuscated hash classes but is still not a semantic attr.
    // If count comes back 0, inspect a place card and confirm it still contains .fontHeadlineSmall.
    const items = feed.locator('button:has(.fontHeadlineSmall)');
    const total = await items.count();
    setCollectState({ message: `Found ${total} place(s). Reading names and notes…` });

    for (let i = 0; i < total; i++) {
      const item = items.nth(i);
      try {
        // BRITTLE: fontHeadlineSmall is a Maps utility class — less likely to change
        // than a random hash class, but not a semantic attribute.
        const nameEl = item.locator('.fontHeadlineSmall').first();
        const name = (await nameEl.textContent())?.trim();
        if (!name) throw new Error('element found but text content was empty');

        // Maps renders one note textarea per card in list order, scoped inside the feed.
        // Using nth(i) off the feed matches the same positional card as the name button above.
        // Not all places have notes — treat any failure or empty value as no note.
        // UNCERTAIN: aria-label "Note" may vary by locale.
        let note: string | null = null;
        try {
          const noteArea = feed.locator('textarea[aria-label="Note"]').nth(i);
          const text = (await noteArea.inputValue({ timeout: 1_000 })).trim();
          note = text.length > 0 ? text : null;
        } catch {
          // Textarea absent or inaccessible — no note.
        }

        const place: Place = { name, note };
        places.push(place);
        broadcast('place', place);
      } catch {
        errors.push({
          location: `Item ${i + 1} of ${total} in list "${listName}"`,
          step: 'read name',
          problem: `Name element (.fontHeadlineSmall) not found inside place button at index ${i} — the button selector may have drifted or the card structure changed`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const outputFileName = `${safeFileName(listName)}_${ts}.json`;
    const outputFile = join(OUTPUT_DIR, outputFileName);
    const data: CollectedList = {
      listName,
      timestamp: new Date().toISOString(),
      places,
    };
    await Bun.write(outputFile, JSON.stringify(data, null, 2));
    await saveErrors(errors, ts);

    setCollectState({ status: 'done', outputFile: outputFileName, message: `Collected ${places.length} place(s).` });
    return outputFile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ location: `list "${listName}"`, problem: message, timestamp: new Date().toISOString() });
    await saveErrors(errors, ts);
    setCollectState({ status: 'error', message });
    throw err;
  } finally {
    await page?.close();
  }
}
