import type { BrowserType } from 'playwright-core';

/**
 * Playwright's Chromium driver, loaded on first use, so a daemon that takes no picture never loads
 * Playwright. The build leaves the package out of the bundle and copies it beside `daemon.mjs`
 * (`scripts/build.ts`), since Playwright reads its own `package.json` and `browsers.json` from disk.
 */
export async function loadChromium(): Promise<BrowserType> {
  const playwright = await import('playwright-core');
  return playwright.chromium;
}
