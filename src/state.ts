import type { AppState } from './types.ts';
import { isDryRun } from './config.ts';

type SSEController = ReadableStreamDefaultController<Uint8Array>;

const clients = new Set<SSEController>();
const encoder = new TextEncoder();

export function addSSEClient(controller: SSEController) {
  clients.add(controller);
}

export function removeSSEClient(controller: SSEController) {
  clients.delete(controller);
}

export function broadcast(event: string, data: unknown) {
  const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const client of clients) {
    try {
      client.enqueue(payload);
    } catch {
      clients.delete(client);
    }
  }
}

let state: AppState = { phase: 'idle', dryRun: isDryRun };

export function getState(): AppState {
  return state;
}

export function setState(update: Partial<AppState>) {
  state = { ...state, ...update };
  broadcast('state', state);
}
