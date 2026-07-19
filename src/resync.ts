import { join } from 'path';
import { readdirSync, existsSync } from 'fs';
import type { CollectedList } from './types.ts';
import { logInfo } from './logger.ts';

const DATA_DIR = join(process.cwd(), 'output', 'data');

/**
 * Marks the on-disk snapshot of every named list as needing a re-sync, by stamping
 * `dirtySince` on its collection file. Call this after an update run with the set of
 * lists it actually mutated in Maps (the source it removed from, plus any list it added
 * to or appended a note on) — those snapshots are now point-in-time copies that no longer
 * reflect the real list, so the home screen should nudge the user to re-collect them.
 *
 * Only lists we already hold a snapshot for are flagged: a mutation to a list that was
 * never imported has nothing on disk to go stale, so there is nothing to resync. An
 * already-flagged file is left untouched so `dirtySince` keeps the time of the *first*
 * mutation since the last sync, not the most recent.
 */
export async function flagListsForResync(mutatedLists: Iterable<string>): Promise<void> {
  const names = new Set(mutatedLists);
  if (names.size === 0 || !existsSync(DATA_DIR)) return;

  const now = new Date().toISOString();
  const files = readdirSync(DATA_DIR).filter(
    (f) => f.endsWith('.json') && !f.endsWith('_actions.json') && f !== 'saved-lists.json',
  );

  for (const fileName of files) {
    const filePath = join(DATA_DIR, fileName);
    let data: CollectedList;
    try {
      data = JSON.parse(await Bun.file(filePath).text());
    } catch {
      continue; // Unreadable or malformed — skip rather than clobber it.
    }

    if (!names.has(data.listName) || data.dirtySince) continue;

    data.dirtySince = now;
    await Bun.write(filePath, JSON.stringify(data, null, 2));
    logInfo(`Flagged imported list "${data.listName}" for re-sync after an update mutated it`, {
      listName: data.listName,
      file: fileName,
    });
  }
}
