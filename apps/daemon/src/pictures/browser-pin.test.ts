import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BROWSER_PIN } from './browser-pin';

/** The browsers the installed `playwright-core` was built against, as its `browsers.json` lists them. */
const BrowsersJson = z.object({
  browsers: z.array(z.object({ name: z.string(), browserVersion: z.string().optional() })),
});

describe('the pinned browser', () => {
  it('is the headless shell the installed playwright-core drives', () => {
    const packageDir = dirname(
      createRequire(import.meta.url).resolve('playwright-core/package.json'),
    );
    const listed = BrowsersJson.parse(
      JSON.parse(readFileSync(join(packageDir, 'browsers.json'), 'utf8')),
    ).browsers.find((b) => b.name === 'chromium-headless-shell');
    expect(listed?.browserVersion).toBe(BROWSER_PIN.version);
    expect(BROWSER_PIN.tarballUrl).toContain(`/${BROWSER_PIN.version}/mac-arm64/`);
  });
});
