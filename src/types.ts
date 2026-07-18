export interface Place {
  name: string;
  note?: string | null;
  permanentlyClosed?: boolean;
}

export interface PlaceAction {
  name: string;
  action: 'remove' | 'move';
  targetList?: string;
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

export interface ErrorEntry {
  location: string;
  step?: string;
  problem: string;
  timestamp: string;
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
  dryRun?: boolean;
}

export interface AppState {
  dryRun: boolean;
  collect: CollectWorkflow;
  update: UpdateWorkflow;
}
