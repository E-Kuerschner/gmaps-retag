import { chromium, type BrowserContext } from 'playwright';
import { join } from 'path';

// Persist the browser profile so the user only needs to log in once.
const USER_DATA_DIR = join(process.cwd(), 'browser-data');

let context: BrowserContext | null = null;

/**
 * Whether the cached context still has a live browser behind it.
 *
 * This matters more than it looks: a context whose browser process is gone does NOT
 * reject calls made on it — `newPage()` simply never settles. There is no timeout on it,
 * so reusing a dead context strands the workflow on its first step forever, showing
 * "Opening Google Maps…" with no error. Checking liveness is what turns that silent hang
 * into a fresh browser launch.
 */
function isUsable(ctx: BrowserContext): boolean {
  const browser = ctx.browser();
  // A persistent context can report no browser handle; assume usable and let the close
  // listener below be the safety net in that case.
  return browser === null || browser.isConnected();
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (context && !isUsable(context)) context = null;

  if (!context) {
    const launched = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    // Every way the browser can go away — crashing, the user closing the window, the
    // server being killed and the browser outliving or dying with it — has to clear the
    // cached handle, or the next run picks up a dead one.
    launched.on('close', () => {
      if (context === launched) context = null;
    });
    context = launched;
  }

  return context;
}

export async function closeBrowser(): Promise<void> {
  const closing = context;
  // Cleared before the await, not after: if close() rejects, the old code left a dead
  // context cached and every later run hung on it.
  context = null;
  await closing?.close().catch(() => {});
}
