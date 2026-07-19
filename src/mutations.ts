import { join } from 'path';
import { readdirSync, existsSync } from 'fs';
import type { CollectedList, Mutation } from './types.ts';
import { logInfo, logMutation } from './logger.ts';

const DATA_DIR = join(process.cwd(), 'output', 'data');

/**
 * Lists changed in Maps since the last reset, accumulated across a whole update run.
 * This is module-level mutable state rather than something threaded through each call, so
 * the leaf mutation modules can add to it without every function passing a context object
 * down the stack — the same approach `cancel.ts` takes for its run-scoped flag. It is safe
 * because only one workflow runs at a time (the server rejects a second with 409) and
 * `performUpdates` owns the lifecycle: it resets this at the start of a run and flushes it
 * at the end, so nothing leaks between runs.
 */
const dirtyLists = new Set<string>();

/**
 * Records a committed Maps mutation: writes it to the session log AND marks its list as
 * needing a re-sync. Call it at the point the change settles — the same spot `logMutation`
 * was called from before. Doing both here, at the leaf level, means any flow that composes
 * the mutation modules gets logging and dirty-tracking automatically, instead of the caller
 * re-deriving which lists changed from action outcomes.
 */
export function recordMutation(mutation: Mutation): void {
  logMutation(mutation);
  dirtyLists.add(mutation.list);
}

/**
 * Clears the accumulated dirty lists. Called at the start of an update run so a previous
 * run's leftovers (e.g. from a run that flushed and then errored) can't carry over.
 */
export function resetMutationTracking(): void {
  dirtyLists.clear();
}

/**
 * Stamps `dirtySince` onto the on-disk snapshot of every list changed since the last
 * reset, so the home screen recommends a re-sync, then clears the accumulator.
 *
 * Only lists we already hold a snapshot for are flagged: a mutation to a list that was
 * never imported has nothing on disk to go stale. An already-flagged file is left as-is so
 * `dirtySince` keeps the time of the *first* mutation since the last sync, not the latest.
 */
export async function flushResyncFlags(): Promise<void> {
  const names = new Set(dirtyLists);
  dirtyLists.clear();
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
