import type { Browser } from 'playwright-core';
import type { BrowserLaunch } from './browser-host';

/**
 * Launches Chromium through Playwright, loaded on first use so a daemon that takes no picture never
 * loads it. The build leaves the package out of the bundle and copies it beside `daemon.mjs`
 * (`scripts/build.ts`), since Playwright reads its own `package.json` and `browsers.json` from disk.
 */
export async function launchChromium(options: BrowserLaunch): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ ...options, args: [...options.args], env: { ...options.env } });
}
