---
name: record-playwright
description: >
  Records a Playwright automation script by opening a live browser session where the user
  interacts naturally while Playwright captures every action into a TypeScript script.
  Use this skill whenever the user wants to record, capture, script, or automate browser
  interactions they don't know the exact selectors for — phrases like "record a flow",
  "capture my interactions", "generate a playwright script", "I want to automate X on
  this site", or "help me script this web task" should all trigger this skill. Also use
  it proactively when the user is writing Playwright automation and seems uncertain about
  selectors or page structure.
---

# Record a Playwright Script

This skill walks the user through a Playwright codegen session, then cleans up the
generated script so it's ready to integrate into the project.

## Step 1 — Understand the goal

Ask the user two things (you can ask both at once):

1. **What is the goal of this flow?** (e.g. "remove a saved place from a Google Maps list")
   — used to name the file and write a header comment.
2. **What is the starting URL?** The page where the browser should open when recording begins.
   If the flow requires the user to be logged in first, remind them this project stores a
   persistent browser profile in `browser-data/`, so they are likely already authenticated.

## Step 2 — Choose an output path

Pick a filename that reflects the goal, in kebab-case, and place it under `src/playwright/`:

```
src/playwright/<goal-slug>.ts
```

Use a temp path during recording (e.g. `/tmp/<goal-slug>-raw.js`) so the raw generated
output stays separate from the final file. You will post-process it in Step 5.

## Step 3 — Launch the recording session

Run the codegen command **in the background** so Claude doesn't block:

```bash
bunx playwright codegen \
  --target javascript \
  --user-data-dir browser-data \
  -o /tmp/<goal-slug>-raw.js \
  "<starting-url>"
```

Key flags:
- `--target javascript` — generates plain JS (no test-runner wrapper) matching this project's style
- `--user-data-dir browser-data` — reuses the persistent login stored in `browser-data/` so the user doesn't have to log in again
- `-o /tmp/<goal-slug>-raw.js` — saves the script when the browser is closed

## Step 4 — Let the user interact

Tell the user:
> "The browser is open. Interact with the page normally to record your flow.
> When you're done, **close the browser window** — that will save the script.
> Come back here when you're finished."

Then wait. Do not proceed until the user confirms they've closed the browser.

## Step 5 — Trim setup steps

Once the user confirms they're done, read the raw generated file. It will look something
like this (plain Playwright JS with one action per line):

```js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://example.com');
  // ... recorded actions ...

  await browser.close();
})();
```

Show the user a **numbered list of every recorded action** (the `await page.*` lines),
skipping the boilerplate launch/close lines. Ask them:

> "Here are the steps that were recorded. Which ones were just setup to get to the right
> place, and which step marks where the real flow begins? Tell me the step number where
> the actual task starts."

Remove every step before the user's chosen starting point. If the user says "all steps
are part of the real flow", keep everything.

## Step 6 — Break the flow into composable modules

Before writing any files, analyze the trimmed steps and split them into **logical atomic
sub-steps** — each step should do exactly one thing (navigate to a URL, click a specific
button, wait for a panel to appear, extract a value). Think about what a future flow author
would want to reuse independently.

Use `src/playwright/open-saved-lists.ts` as the reference template — it:
- Takes a `BrowserContext` (when creating a new page) or a `Page` (when continuing)
- Does one logical unit of navigation
- Returns the `Page` for the caller to continue chaining

**Function signature rules:**
- Use `(context: BrowserContext): Promise<Page>` when the step creates a new page.
- Use `(page: Page, ...params): Promise<Page>` when the step navigates or mutates and the
  caller will keep using the page.
- Use `(page: Page, ...params): Promise<T>` when the step reads/extracts data.
- Prefer `Page` as the first argument over `BrowserContext` whenever no new page is needed.

Give each module a kebab-case filename that names the single action it performs
(e.g. `click-saved-button.ts`, `open-list-by-name.ts`, `scroll-list-to-bottom.ts`).

## Step 7 — Write module files

For each logical sub-step identified in Step 6, write a separate file at
`src/playwright/<step-slug>.ts`. Every file **must** start with a comment block showing
how to compose this module into a flow. Follow this exact structure:

```typescript
/*
 * Example — composing this step into a flow:
 *
 *   import { getBrowserContext } from './browser';
 *   import { openSavedLists } from './open-saved-lists';   // preceding step
 *   import { <thisExportedFunction> } from './<this-file>';
 *
 *   const context = await getBrowserContext();
 *   const page = await openSavedLists(context);
 *   const result = await <thisExportedFunction>(page, ...);
 */

import { type Page } from 'playwright';

/** One-sentence description of what this step does. */
export async function <functionName>(page: Page, ...): Promise<Page> {
  // ...recorded steps...
  return page;
}
```

Key things to adapt from the raw recorded JS:
- Drop the boilerplate `chromium.launch()` / `browser.newContext()` / `browser.close()` block entirely.
- Each file imports only what it needs from `'playwright'` (`Page`, `BrowserContext`).
- Do **not** import `getBrowserContext` from `'./browser'` inside a module — that belongs in the
  flow that wires modules together (which the caller writes).
- Keep `await page.goto(...)` in the module that logically owns the navigation.
- Annotate fragile class-based selectors with `// UNCERTAIN:` or `// BRITTLE:` comments,
  matching the convention used in `collect.ts` and `update.ts`.

## Step 8 — Report back

Tell the user:
- The list of files written and the single action each encapsulates
- Which recorded steps were trimmed (setup before the real flow)
- A short composed-flow snippet showing how all the new modules chain together
- A note that class-based selectors should be treated as fragile and annotated with
  `// UNCERTAIN:` per the project convention
