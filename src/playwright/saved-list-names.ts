import { type Page } from 'playwright';
import { join } from 'path';

export const SAVED_LISTS_FILE = 'saved-lists.json';

// List name is in .fontBodyLarge inside each list button; other text in the button
// (author, sharing status) lives in sibling elements and is intentionally excluded.
export async function scrapeSavedListNames(page: Page): Promise<string[]> {
  const nameEls = page.locator('button .fontBodyLarge');
  await nameEls.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  const count = await nameEls.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = (await nameEls.nth(i).textContent())?.trim();
    if (text) names.push(text);
  }
  return names;
}

export async function writeSavedListNames(dataDir: string, names: string[]): Promise<void> {
  await Bun.write(join(dataDir, SAVED_LISTS_FILE), JSON.stringify(names, null, 2));
}
