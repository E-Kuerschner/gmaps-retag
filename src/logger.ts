import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { LogEntry, Mutation } from './types.ts';

const LOGS_DIR = join(process.cwd(), 'output', 'logs');

/**
 * One log file per server process — the module is evaluated once at startup, so every
 * run of `bun run dev` / `bun run start` gets its own timestamped file and all logging
 * for that session lands in it. Restarting the server (including a watch-mode reload)
 * starts a fresh file.
 */
const sessionFile = join(LOGS_DIR, `session_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

mkdirSync(LOGS_DIR, { recursive: true });

/**
 * JSON Lines, appended synchronously one entry at a time. Both properties matter for
 * recovery: append-only means a crash can never truncate earlier entries, and writing
 * synchronously per entry means anything already in the file is known to have happened
 * — there is no buffered tail to lose if the process is killed mid-run (which is exactly
 * what /api/collect/cancel does by force-closing the browser).
 */
function write(entry: LogEntry): void {
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

export function getSessionLogPath(): string {
  return sessionFile;
}

export function logInfo(message: string, context?: Record<string, unknown>): void {
  write({ timestamp: new Date().toISOString(), level: 'info', message, context });
  console.log(`[info] ${message}`);
}

export function logError(message: string, context?: Record<string, unknown>): void {
  write({ timestamp: new Date().toISOString(), level: 'error', message, context });
  console.error(`[error] ${message}`);
}

/**
 * Records a write that has already been made to Google Maps. Call this only AFTER the
 * change has been committed and settled, never before — the log's usefulness for undo
 * depends on every entry in it being something that actually happened.
 *
 * Mutations are recorded at the atomic level (add / remove / note), not at the level of
 * the user-facing action, because that is the level at which they are reversible. A
 * 'move' therefore appears as an add followed by a remove, and undoing it means undoing
 * both. Each shape carries everything needed to construct its own inverse — notably
 * `previousNote`, which is the only record anywhere of a note's prior contents.
 */
export function logMutation(mutation: Mutation): void {
  const message =
    mutation.op === 'add-to-list'
      ? `Added "${mutation.place}" to list "${mutation.list}"`
      : mutation.op === 'remove-from-list'
        ? `Removed "${mutation.place}" from list "${mutation.list}"`
        : `Appended note on "${mutation.place}" in list "${mutation.list}"`;

  write({ timestamp: new Date().toISOString(), level: 'info', message, mutation });
  console.log(`[mutation] ${message}`);
}
