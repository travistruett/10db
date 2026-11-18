import { test as base } from '@playwright/test';

/**
 * Playwright's test, with a page that drops its routes when the test ends. The app keeps polling
 * `/system`, which `claudeIsInstalled` answers through a route; a callback still running when the test
 * ends would otherwise fail that test, or the next one in the worker, with "Test ended" or "Response has
 * been disposed".
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
});
