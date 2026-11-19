import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { daemonUrl } from './daemon-url';
import { E2E_DATA } from './paths';
import { auth, createProject } from './shape-project';

// Core flow 3: the builder answers Inbox cards from the keyboard. The questions are written into the
// idle daemon's database, into a project of their own, and answered again when the spec ends so no
// later spec reads them.

const PROJECT_NAME = 'e2e-inbox';

const OpenCards = z.array(
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    options: z.array(z.looseObject({ label: z.string() })),
  }),
);

test.describe.configure({ mode: 'serial' });

let projectId = '';

/** Answers every card this spec left open, so later specs read no stray cards. */
async function resolveOwnCards(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${daemonUrl}/inbox?state=OPEN`, { headers: auth });
  const own = OpenCards.parse(await response.json()).filter((card) => card.projectId === projectId);
  for (const card of own) {
    const answered = await request.post(`${daemonUrl}/inbox/${card.id}/answer`, {
      headers: auth,
      // A flag closes on any word; a question needs one of its options, and records nothing.
      data:
        card.options[0] === undefined
          ? { choice: 'dismissed' }
          : { choice: card.options[0].label, record: null },
    });
    expect(answered.ok()).toBe(true);
  }
}

const SystemAnswer = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      path: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
});

/**
 * The rail's badge counts 10db's own cards, one for each tool the system check does not find, and the check's
 * answer changes as it settles. With every tool found, the badge is the daemon's count.
 */
async function toolsAreInstalled(page: Page): Promise<void> {
  await page.route(`${daemonUrl}/system*`, async (route) => {
    const response = await route.fetch();
    const body = SystemAnswer.parse(await response.json());
    for (const tool of body.tools) {
      tool.path ??= `/usr/local/bin/${tool.name}`;
      tool.version ??= '1.0.0';
    }
    await route.fulfill({ response, json: body });
  });
}

const rowsOf = (page: Page) => page.locator('[data-inbox-row]');
const inboxUrl = (search: string) => `/inbox?project=${projectId}${search}`;

test.beforeAll(async ({ request }) => {
  projectId = await createProject(request, PROJECT_NAME, [
    { name: 'greeting', globs: ['src/greeting/**'] },
  ]);
});

test.afterAll(async ({ request }) => {
  await resolveOwnCards(request);
});

test('answering a question with a digit and Enter selects the next row and lowers the badge', async ({
  page,
}) => {
  for (const title of ['Keep the cache?', 'Retry the sync?', 'Show the banner?']) {
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/seed-question-card.ts',
        resolve(E2E_DATA, '10db.sqlite'),
        JSON.stringify({
          projectId,
          title,
          body: 'Seeded for the answer check.',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        }),
      ],
      { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await toolsAreInstalled(page);
  await page.goto(inboxUrl('&kind=question'));
  await expect(rowsOf(page)).toHaveCount(3);
  const badge = page.getByRole('navigation').getByRole('link', { name: /^Inbox/ });
  // The badge reads its number twice, once for the eye and once for assistive tech: the phrase is the whole count.
  const count = async (): Promise<number> =>
    Number(
      /^(\d+) open cards?/i.exec(await badge.getByText(/open cards?/i).innerText())?.[1] ?? '0',
    );
  // The badge also counts 10db's own cards, which arrive as its system check settles: read it once it has.
  let before = await count();
  await expect
    .poll(
      async () => {
        const previous = before;
        before = await count();
        return before === previous;
      },
      { intervals: [1500] },
    )
    .toBe(true);
  expect(before).toBeGreaterThanOrEqual(3);
  await expect(rowsOf(page).first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(rowsOf(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(rowsOf(page).first()).toContainText('Retry the sync?');
  await expect.poll(count).toBe(before - 1);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
