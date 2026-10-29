import type { Page } from '@playwright/test';
import { z } from 'zod';
import { daemonUrl } from './daemon-url';

const SystemAnswer = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      path: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
});

/** The Playwright image may have no Claude Code, so the check is answered as if it were found. */
export async function claudeIsInstalled(page: Page): Promise<void> {
  await page.route(`${daemonUrl}/system*`, async (route) => {
    const response = await route.fetch();
    const body = SystemAnswer.parse(await response.json());
    for (const tool of body.tools) {
      if (tool.name === 'claude') {
        tool.path = '/usr/local/bin/claude';
        tool.version = '2.1.299 (Claude Code)';
      }
    }
    await route.fulfill({ response, json: body });
  });
}
