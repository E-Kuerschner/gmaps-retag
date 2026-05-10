import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

export async function ensureBrowser(): Promise<void> {
  let execPath = '';
  try {
    execPath = chromium.executablePath();
  } catch { /* path calculation failed — browser not yet downloaded */ }

  if (execPath && existsSync(execPath)) return;

  console.log('\n  Chromium not found. Downloading browser for first-time setup (~150 MB).');
  console.log('  This is cached and only happens once.\n');

  // Try available package-manager CLIs in order of preference.
  const candidates: [string, string[]][] = [
    ['bun', ['x', 'playwright', 'install', 'chromium']],
    ['npx', ['--yes', 'playwright', 'install', 'chromium']],
  ];

  for (const [cmd, args] of candidates) {
    try {
      const result = Bun.spawnSync([cmd, ...args], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      if (result.exitCode === 0) {
        console.log('\n  Chromium installed successfully.\n');
        return;
      }
    } catch { /* command not found — try next */ }
  }

  console.error('\n  Could not auto-install Chromium. Install it manually with:\n');
  console.error('    npx playwright install chromium\n');
  process.exit(1);
}
