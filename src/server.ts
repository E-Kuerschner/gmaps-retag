import { join } from 'path';
import { readdirSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { getState, setCollectState, setUpdateState, addSSEClient, removeSSEClient } from './state.ts';
import { getBrowserContext, closeBrowser } from './playwright/browser.ts';
import { collectList } from './playwright/collect.ts';
import { browseSavedLists } from './playwright/browse-saved-lists.ts';
import { performUpdates } from './playwright/update.ts';
import { resetCancel, requestCancel, isCancelRequested } from './playwright/cancel.ts';
import { isDryRun } from './config.ts';
import type { PlaceAction, ActionFile, CollectedList } from './types.ts';

const PUBLIC_DIR = join(import.meta.dir, '..', 'public');
const DATA_DIR = join(process.cwd(), 'output', 'data');
const LOGS_DIR = join(process.cwd(), 'output', 'logs');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

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

function isBusy(): boolean {
  const { collect, update } = getState();
  return collect.status === 'running' || collect.status === 'browsing' || update.status === 'running';
}

function makeSSEResponse(): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      addSSEClient(ctrl);
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
    if (pathname === '/') return html('collect.html');
    if (pathname.startsWith('/collections/')) return html('collection.html');

    // ── SSE stream ───────────────────────────────────────────────────────────
    if (pathname === '/api/events') return makeSSEResponse();

    // ── GET /api/collections/:fileName  (collection data for the collection page) ─
    if (pathname.startsWith('/api/collections/') && method === 'GET') {
      const fileName = decodeURIComponent(pathname.replace('/api/collections/', ''));
      if (!fileName || fileName.includes('..')) return json({ error: 'Invalid file name' }, 400);
      const filePath = join(DATA_DIR, fileName);
      if (!existsSync(filePath)) return json({ error: 'Not found' }, 404);
      const content = await Bun.file(filePath).text();
      return new Response(content, { headers: { 'Content-Type': 'application/json' } });
    }

    // ── GET /api/saved-lists  (all known saved list names, written during collect) ─
    if (pathname === '/api/saved-lists' && method === 'GET') {
      const filePath = join(DATA_DIR, 'saved-lists.json');
      if (!existsSync(filePath)) return json([]);
      const content = await Bun.file(filePath).text();
      return new Response(content, { headers: { 'Content-Type': 'application/json' } });
    }

    // ── GET /api/collect-files  (list of collection files for /collect page) ─
    if (pathname === '/api/collect-files' && method === 'GET') {
      const files = existsSync(DATA_DIR)
        ? readdirSync(DATA_DIR)
            .filter((f) => f.endsWith('.json') && !f.endsWith('_actions.json') && f !== 'saved-lists.json')
            .sort()
        : [];
      const result = await Promise.all(files.map(async (fileName) => {
        try {
          const data: CollectedList = JSON.parse(await Bun.file(join(DATA_DIR, fileName)).text());
          return { fileName, listName: data.listName, lastUpdated: data.lastUpdated ?? null };
        } catch {
          return { fileName, listName: fileName, lastUpdated: null };
        }
      }));
      return json(result);
    }

    // ── DELETE /api/collect-files/:name ──────────────────────────────────────
    if (pathname.startsWith('/api/collect-files/') && method === 'DELETE') {
      const fileName = decodeURIComponent(pathname.replace('/api/collect-files/', ''));
      if (!fileName || fileName.includes('..')) return json({ error: 'Invalid file name' }, 400);
      const filePath = join(DATA_DIR, fileName);
      if (!existsSync(filePath)) return json({ error: 'Not found' }, 404);
      unlinkSync(filePath);
      return json({ ok: true });
    }

    // ── POST /api/collect/start ───────────────────────────────────────────────
    if (pathname === '/api/collect/start' && method === 'POST') {
      const body = (await req.json()) as { listName?: string };
      const listName = body.listName?.trim();
      if (!listName) return json({ error: 'listName is required' }, 400);

      if (isBusy()) {
        return json({ error: 'An operation is already in progress' }, 409);
      }

      resetCancel();
      setCollectState({ status: 'running', listName, outputFile: undefined, message: 'Starting…' });

      getBrowserContext()
        .then((ctx) => {
          if (isCancelRequested()) {
            setCollectState({ status: 'error', message: 'Cancelled by user.' });
            return;
          }
          return collectList(ctx, listName);
        })
        .catch((err: unknown) => {
          setCollectState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        });

      return json({ ok: true });
    }

    // ── POST /api/collect/browse-lists  (scrape all saved list names for picking) ─
    if (pathname === '/api/collect/browse-lists' && method === 'POST') {
      if (isBusy()) {
        return json({ error: 'An operation is already in progress' }, 409);
      }

      resetCancel();
      setCollectState({ status: 'browsing', listName: undefined, outputFile: undefined, message: 'Starting…' });

      getBrowserContext()
        .then((ctx) => {
          if (isCancelRequested()) {
            setCollectState({ status: 'error', message: 'Cancelled by user.' });
            return;
          }
          return browseSavedLists(ctx);
        })
        .catch((err: unknown) => {
          setCollectState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        });

      return json({ ok: true });
    }

    // ── POST /api/collect/cancel  (force-stop an in-progress collect/browse run) ─
    if (pathname === '/api/collect/cancel' && method === 'POST') {
      const { collect } = getState();
      if (collect.status !== 'running' && collect.status !== 'browsing') {
        return json({ error: 'No collect operation is in progress' }, 409);
      }

      requestCancel();
      // Force-closing the browser interrupts whatever Playwright call is currently
      // blocking (goto, waitFor, etc.) — the running flow's own catch block detects
      // the cancellation and reports it; this closeBrowser() is a fallback in case
      // it happens before a page/context even exists yet.
      await closeBrowser().catch(() => {});

      return json({ ok: true });
    }

    // ── POST /api/collect/reset ───────────────────────────────────────────────
    if (pathname === '/api/collect/reset' && method === 'POST') {
      setCollectState({ status: 'idle', listName: undefined, outputFile: undefined, message: undefined });
      return json({ ok: true });
    }

    // ── POST /api/update/start  (create action file + launch update workflow) ─
    if (pathname === '/api/update/start' && method === 'POST') {
      const body = (await req.json()) as { collectionFile?: string; actions?: PlaceAction[]; dryRun?: boolean };
      const { collectionFile, actions = [] } = body;
      const dryRun = isDryRun || body.dryRun === true;

      if (!collectionFile) return json({ error: 'collectionFile is required' }, 400);

      const collectionPath = join(DATA_DIR, collectionFile);
      if (!existsSync(collectionPath)) return json({ error: 'Collection file not found' }, 404);

      if (isBusy()) {
        return json({ error: 'An operation is already in progress' }, 409);
      }

      const collectionData: CollectedList = JSON.parse(await Bun.file(collectionPath).text());
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeName = collectionData.listName.replace(/[^a-z0-9]/gi, '_');
      const actionFileName = `${safeName}_${ts}_actions.json`;
      const actionFilePath = join(DATA_DIR, actionFileName);

      const actionData: ActionFile = {
        listName: collectionData.listName,
        collectionFile,
        timestamp: new Date().toISOString(),
        actions,
      };
      await Bun.write(actionFilePath, JSON.stringify(actionData, null, 2));

      setUpdateState({ status: 'running', message: 'Starting update…', progress: undefined, dryRun });

      getBrowserContext()
        .then((ctx) => performUpdates(ctx, actionFilePath, dryRun))
        .catch((err: unknown) => {
          setUpdateState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        });

      return json({ ok: true });
    }

    // ── POST /api/update/reset ────────────────────────────────────────────────
    if (pathname === '/api/update/reset' && method === 'POST') {
      setUpdateState({ status: 'idle', message: undefined, progress: undefined });
      return json({ ok: true });
    }

    // ── POST /api/log-error  (client-side error logging) ────────────────────
    if (pathname === '/api/log-error' && method === 'POST') {
      const body = (await req.json()) as { message?: string };
      const message = body.message?.trim();
      if (message) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const entry = [{ location: 'client', problem: message, timestamp: new Date().toISOString() }];
        await Bun.write(join(LOGS_DIR, `errors_${ts}.json`), JSON.stringify(entry, null, 2));
      }
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
