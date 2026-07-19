export interface Place {
  name: string;
  note?: string | null;
  permanentlyClosed?: boolean;
}

export interface PlaceAction {
  name: string;
  action: 'remove' | 'move' | 'copy';
  targetList?: string;
  /** Carried over from the source collection's Place.note for 'copy'/'move' actions. */
  note?: string | null;
}

export interface CollectedList {
  listName: string;
  lastUpdated: string;
  places: Place[];
}

export interface ActionFile {
  listName: string;
  collectionFile: string;
  timestamp: string;
  actions: PlaceAction[];
}

export type LogLevel = 'info' | 'error';

/**
 * A write made to Google Maps, recorded at the atomic level at which it can be reversed.
 * Every variant carries enough to build its own inverse: an add is undone by a remove,
 * a remove by an add, and a note append by restoring `previousNote`.
 */
export type Mutation =
  | { op: 'add-to-list'; place: string; list: string }
  | { op: 'remove-from-list'; place: string; list: string }
  | { op: 'append-note'; place: string; list: string; previousNote: string | null; newNote: string };

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  /** Present only on entries recording an actual change to a saved list. */
  mutation?: Mutation;
  context?: Record<string, unknown>;
}

export interface CollectWorkflow {
  status: 'idle' | 'browsing' | 'running' | 'done' | 'error';
  listName?: string;
  outputFile?: string;
  message?: string;
}

export interface UpdateWorkflow {
  status: 'idle' | 'running' | 'done' | 'error';
  message?: string;
  progress?: { current: number; total: number };
  errorCount?: number;
  skippedCount?: number;
  dryRun?: boolean;
}

export interface AppState {
  dryRun: boolean;
  collect: CollectWorkflow;
  update: UpdateWorkflow;
}
