import { type BrowserContext, type Page } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { setCollectState, broadcast } from '../state.ts';
import { logInfo, logError } from '../logger.ts';
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
    logInfo(`Scanned ${names.length} saved list name(s)`, { count: names.length });
    broadcast('savedLists', names);

    setCollectState({ status: 'idle', message: undefined });
  } catch (err) {
    const finalErr = isCancelRequested() ? new CancelledError() : err instanceof Error ? err : new Error(String(err));
    logError(`Scan of saved lists aborted: ${finalErr.message}`);
    setCollectState({ status: 'error', message: finalErr.message });
    throw finalErr;
  } finally {
    // Close only this run's page, not the browser window — see the note in update.ts's
    // finally. Relaunching between runs races the profile lock and strands the next run
    // on "Opening Google Maps…".
    await page?.close().catch(() => {});
  }
}
