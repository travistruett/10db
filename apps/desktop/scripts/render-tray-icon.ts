import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

// Renders tray-icon.svg to the menu-bar template image: black glyphs on a transparent background,
// which macOS tints to match the menu bar. The PNG is 36 px tall, the menu bar's 18 pt at 2x.
const desktop = resolve(import.meta.dirname, '..');
const svg = readFileSync(resolve(desktop, 'tray-icon.svg'), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.locator('svg').screenshot({
    path: resolve(desktop, 'src-tauri', 'tray-icon.png'),
    omitBackground: true,
  });
} finally {
  await browser.close();
}
