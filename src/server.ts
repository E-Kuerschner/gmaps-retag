import { join } from 'path';
import { readdirSync, existsSync, mkdirSync } from 'fs';
import { getState, setState, addSSEClient, removeSSEClient } from './state.ts';
import { getBrowserContext, closeBrowser } from './playwright/browser.ts';
import { collectList } from './playwright/collect.ts';
import { performUpdates } from './playwright/update.ts';
import type { PlaceAction, ActionFile } from './types.ts';

const PUBLIC_DIR = join(import.meta.dir, '..', 'public');
const OUTPUT_DIR = join(process.cwd(), 'output');

mkdirSync(OUTPUT_DIR, { recursive: true });

function html(path: string): Response {
  return new Response(Bun.file(join(PUBLIC_DIR, path)), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSSEResponse(): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      addSSEClient(ctrl);
      // Immediately send current state so the client doesn't wait.
      ctrl.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(getState())}\n\n`));
    },
    cancel() {
      removeSSEClient(ctrl);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

const server = Bun.serve({
  port: 3000,

  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // ── Static pages ─────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') return html('index.html');
    if (pathname === '/collect') return html('collect.html');
    if (pathname === '/update') return html('update.html');

    // ── SSE stream ───────────────────────────────────────────────────────────
    if (pathname === '/api/events') return makeSSEResponse();

    // ── GET /api/state ───────────────────────────────────────────────────────
    if (pathname === '/api/state' && method === 'GET') {
      return json(getState());
    }

    // ── GET /api/action-files  (list files available for the update flow) ────
    if (pathname === '/api/action-files' && method === 'GET') {
      const files = existsSync(OUTPUT_DIR)
        ? readdirSync(OUTPUT_DIR)
            .filter((f) => f.endsWith('_actions.json'))
            .sort()
            .reverse()
        : [];
      return json(files);
    }

    // ── GET /api/action-files/:fileName  (preview a single action file) ────────
    if (pathname.startsWith('/api/action-files/') && method === 'GET') {
      const fileName = decodeURIComponent(pathname.replace('/api/action-files/', ''));
      if (!fileName || fileName.includes('..')) return json({ error: 'Invalid file name' }, 400);
      const filePath = join(OUTPUT_DIR, fileName);
      if (!existsSync(filePath)) return json({ error: 'Not found' }, 404);
      const content = await Bun.file(filePath).text();
      return new Response(content, { headers: { 'Content-Type': 'application/json' } });
    }

    // ── POST /api/collect/start ───────────────────────────────────────────────
    if (pathname === '/api/collect/start' && method === 'POST') {
      const body = (await req.json()) as { listName?: string };
      const listName = body.listName?.trim();
      if (!listName) return json({ error: 'listName is required' }, 400);

      const current = getState();
      if (current.phase === 'collecting' || current.phase === 'updating') {
        return json({ error: 'An operation is already in progress' }, 409);
      }

      setState({ phase: 'collecting', listName, places: [], outputFile: undefined, message: 'Starting…' });

      // Fire-and-forget — progress is pushed via SSE.
      getBrowserContext()
        .then((ctx) => collectList(ctx, listName))
        .catch((err: unknown) => {
          setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
        });

      return json({ ok: true });
    }

    // ── POST /api/collect/confirm ─────────────────────────────────────────────
    if (pathname === '/api/collect/confirm' && method === 'POST') {
      const body = (await req.json()) as { actions?: PlaceAction[] };
      const { actions = [] } = body;

      const state = getState();
      if (!state.listName || !state.outputFile) {
        return json({ error: 'No active collection to confirm' }, 400);
      }

      setState({ phase: 'confirming', message: 'Saving action file…' });

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeName = state.listName.replace(/[^a-z0-9]/gi, '_');
      const actionFilePath = join(OUTPUT_DIR, `${safeName}_${ts}_actions.json`);

      const actionData: ActionFile = {
        listName: state.listName,
        sourceFile: state.outputFile,
        timestamp: new Date().toISOString(),
        actions,
      };

      await Bun.write(actionFilePath, JSON.stringify(actionData, null, 2));

      setState({
        phase: 'done',
        actionFile: actionFilePath,
        message: `Action file saved: ${actionFilePath}`,
      });

      return json({ ok: true, actionFile: actionFilePath });
    }

    // ── POST /api/update/start ────────────────────────────────────────────────
    if (pathname === '/api/update/start' && method === 'POST') {
      const body = (await req.json()) as { fileName?: string };
      const fileName = body.fileName?.trim();
      if (!fileName) return json({ error: 'fileName is required' }, 400);

      const filePath = join(OUTPUT_DIR, fileName);
      if (!existsSync(filePath)) return json({ error: 'File not found' }, 404);

      const current = getState();
      if (current.phase === 'collecting' || current.phase === 'updating') {
        return json({ error: 'An operation is already in progress' }, 409);
      }

      setState({ phase: 'updating', message: 'Starting update…', progress: undefined });

      getBrowserContext()
        .then((ctx) => performUpdates(ctx, filePath))
        .catch((err: unknown) => {
          setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
        });

      return json({ ok: true });
    }

    // ── POST /api/reset ───────────────────────────────────────────────────────
    if (pathname === '/api/reset' && method === 'POST') {
      setState({
        phase: 'idle',
        listName: undefined,
        places: undefined,
        outputFile: undefined,
        actionFile: undefined,
        message: undefined,
        progress: undefined,
      });
      return json({ ok: true });
    }

    // ── POST /api/browser/close ───────────────────────────────────────────────
    if (pathname === '/api/browser/close' && method === 'POST') {
      await closeBrowser();
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`\n  gmaps-retag running → http://localhost:${server.port}\n`);
