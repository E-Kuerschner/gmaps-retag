import { chromium, type BrowserContext } from 'playwright';
import { join } from 'path';

// Persist the browser profile so the user only needs to log in once.
const USER_DATA_DIR = join(process.cwd(), 'browser-data');

let context: BrowserContext | null = null;

export async function getBrowserContext(): Promise<BrowserContext> {
  if (!context) {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }
  return context;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}
