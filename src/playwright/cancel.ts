let cancelRequested = false;

export function resetCancel(): void {
  cancelRequested = false;
}

export function requestCancel(): void {
  cancelRequested = true;
}

export function isCancelRequested(): boolean {
  return cancelRequested;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled by user.');
    this.name = 'CancelledError';
  }
}
