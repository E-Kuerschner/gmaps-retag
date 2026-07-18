import { type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { setCollectState, broadcast } from '../state.ts';
import { closeBrowser } from './browser.ts';
import { openSavedLists } from './open-saved-lists.ts';
import { scrapeSavedListNames, writeSavedListNames } from './saved-list-names.ts';
import { isCancelRequested, CancelledError } from './cancel.ts';

const DATA_DIR = join(process.cwd(), 'output', 'data');

export async function browseSavedLists(context: BrowserContext): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  let page: Page | undefined;

  try {
    setCollectState({ status: 'browsing', message: 'Opening Google Maps…' });

    setCollectState({ message: 'Waiting for Google Maps to load. Please log in if prompted.' });
    try {
      page = await openSavedLists(context);
    } catch {
      throw new Error(
        'Could not find the "Saved" button. Make sure you are logged into Google Maps.',
      );
    }

    setCollectState({ message: 'Reading your saved list names…' });
    const names = await scrapeSavedListNames(page);
    if (names.length === 0) {
      throw new Error('No saved lists were found — the page layout may have changed, or you have no saved lists yet.');
    }

    await writeSavedListNames(DATA_DIR, names);
    broadcast('savedLists', names);

    setCollectState({ status: 'idle', message: undefined });
  } catch (err) {
    const finalErr = isCancelRequested() ? new CancelledError() : err instanceof Error ? err : new Error(String(err));
    setCollectState({ status: 'error', message: finalErr.message });
    throw finalErr;
  } finally {
    await page?.close().catch(() => {});
    await closeBrowser();
  }
}
