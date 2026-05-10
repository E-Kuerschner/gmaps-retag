export interface Place {
  name: string;
  link: string;
}

export interface PlaceAction extends Place {
  action: 'remove' | 'move';
  targetList?: string;
}

export interface CollectedList {
  listName: string;
  timestamp: string;
  places: Place[];
}

export interface ActionFile {
  listName: string;
  sourceFile: string;
  timestamp: string;
  actions: PlaceAction[];
}

export interface ErrorEntry {
  location: string;
  problem: string;
  timestamp: string;
}

export type AppPhase =
  | 'idle'
  | 'collecting'
  | 'review'
  | 'confirming'
  | 'updating'
  | 'done'
  | 'error';

export interface AppState {
  phase: AppPhase;
  dryRun?: boolean;
  listName?: string;
  places?: Place[];
  outputFile?: string;
  actionFile?: string;
  message?: string;
  progress?: { current: number; total: number };
}
