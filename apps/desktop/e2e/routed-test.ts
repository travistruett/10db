import { test as base } from '@playwright/test';
import { withResetRetries } from './retrying-request';

/**
 * Playwright's test, with two changes every spec gets:
 *
 * - A page that drops its routes when the test ends. The app keeps polling `/system`, which
 *   `claudeIsInstalled` answers through a route; a callback still running when the test ends would
 *   otherwise fail that test, or the next one in the worker, with "Test ended" or "Response has been
 *   disposed".
 * - A request context that retries a reset connection on every call, so an API request that reuses a
 *   keep-alive socket the daemon closed does not fail the spec.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
  request: async ({ request }, use) => {
    await use(withResetRetries(request));
  },
});
