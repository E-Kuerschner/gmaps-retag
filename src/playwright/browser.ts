import { chromium, type BrowserContext } from 'playwright';
import { join } from 'path';

// Persist the browser profile so the user only needs to log in once.
const USER_DATA_DIR = join(process.cwd(), 'browser-data');

// Upper bound on the liveness probe in getBrowserContext(). A healthy context answers in
// single-digit milliseconds, so this only ever elapses when the browser is actually gone —
// it's the ceiling on how long a run can look stuck before we give up on the cached context
// and relaunch, replacing what used to be an unbounded "Opening Google Maps…" hang.
const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

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

/**
 * Actively confirms the cached context can still talk to its browser, within a timeout.
 *
 * isUsable() is only a cheap synchronous guess: for a persistent context ctx.browser() is
 * null, so it always says "usable" and leans entirely on the 'close' listener to notice a
 * dead browser. That listener covers every case where the browser DISCONNECTS (crash, kill,
 * the user closing the window) — but not the narrow one where the process is alive yet
 * wedged, or where 'close' simply hasn't propagated yet in the split second before a new run
 * starts. In those cases the stale context is reused and the first newPage() never settles,
 * which is exactly the silent "Opening Google Maps…" hang we're guarding against.
 *
 * cookies() is a lightweight protocol round-trip that needs a live browser but, unlike
 * newPage(), opens no visible tab. On a healthy context it resolves immediately; on a dead
 * or wedged one it hangs (or rejects), so we race it against a timeout: resolve → alive,
 * timeout/throw → treat as dead and relaunch. The abandoned cookies() promise on the dead
 * path never settles, which is harmless — it holds nothing open.
 */
async function isAlive(ctx: BrowserContext): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.cookies(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('liveness probe timed out')), LIVENESS_PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (context && !isUsable(context)) context = null;

  // Then the airtight check: probe the cached context for real before handing it back, so a
  // wedged-but-not-disconnected browser (or a 'close' event that hasn't fired yet) becomes a
  // fast relaunch instead of a run that hangs forever on its first step. Only the reuse path
  // pays for this; a freshly launched context below is trusted without a probe.
  if (context && !(await isAlive(context))) {
    await context.close().catch(() => {});
    context = null;
  }

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
