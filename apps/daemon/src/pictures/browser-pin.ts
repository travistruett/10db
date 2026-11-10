import type { PinnedRelease } from '../environment';

/**
 * The browser that takes the Workbench's pictures: Chrome for Testing's headless shell at the build
 * the daemon's `playwright-core` names in its `browsers.json`, fetched from Playwright's CDN and
 * checked against the checksum recorded here. It moves only with `playwright-core`, in a PR of its own
 * whose live test (`TENDB_LIVE_BROWSER=1 src/pictures/browser.live.test.ts`) passed.
 */
export const BROWSER_PIN: PinnedRelease = {
  tool: 'chromium-headless-shell',
  label: 'Chromium for pictures',
  version: '158.0.8127.18',
  sha512:
    'sha512-EV2ZxFMmAb23CzuFyXFl79WahT/b2s4ZZ8bv9MnIDgb8xllkJo7I6SqK+uRWnwMu7FnVY5BU/vwG2QxMlSEgkg==',
  tarballUrl:
    'https://cdn.playwright.dev/builds/cft/158.0.8127.18/mac-arm64/chrome-headless-shell-mac-arm64.zip',
  member: 'chrome-headless-shell-mac-arm64',
  strip: 1,
  executable: 'chrome-headless-shell',
};
