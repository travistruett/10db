import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { E2E_DATA } from './paths';
import { auth, createProject } from './shape-project';

// The Inbox's panel against the real daemon with thousands of cards (app shell spec §4.1 "Performance"). The
// cards are written into the idle daemon's database by `seed-inbox-cards.ts`, into a project of their own, and
// every page here is narrowed to it, so no other spec sees them; they are answered again when the spec ends.

const PROJECT_NAME = 'e2e-inbox';
const SCALE = 2000;
const GROUPED_SETS = 50;
const FIRST_ROW_BUDGET_MS = 2000;
const LOOKUP_BUDGET_MS = 500;

const OpenCards = z.array(
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    options: z.array(z.looseObject({ label: z.string() })),
  }),
);

test.describe.configure({ mode: 'serial' });

let projectId = '';

function seed(input: Record<string, unknown>): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-inbox-cards.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({ projectId, ...input }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
}

/** Answers every card this spec left open, so later specs read no stray cards. */
async function resolveOwnCards(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${daemonUrl}/inbox?state=OPEN`, { headers: auth });
  const own = OpenCards.parse(await response.json()).filter((card) => card.projectId === projectId);
  const batch = 25;
  for (let at = 0; at < own.length; at += batch) {
    await Promise.all(
      own.slice(at, at + batch).map(async (card) => {
        const answered = await request.post(`${daemonUrl}/inbox/${card.id}/answer`, {
          headers: auth,
          // A flag closes on any word; a question needs one of its options, and records nothing.
          data:
            card.options[0] === undefined
              ? { choice: 'dismissed' }
              : { choice: card.options[0].label, record: null },
        });
        expect(answered.ok()).toBe(true);
      }),
    );
  }
}

async function scheme(page: Page, value: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((v: string) => {
    window.localStorage.setItem('mantine-color-scheme-value', v);
  }, value);
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

/** The wait from the list's first page being asked for to its first row showing; the page's own load is not it. */
async function firstRowAfterRequest(
  page: Page,
  url: string,
): Promise<{ ms: number; pageSize: string | null }> {
  const asked = page.waitForRequest((request) => {
    const query = new URL(request.url());
    return (
      query.pathname === '/inbox/page' &&
      query.searchParams.get('project') === projectId &&
      query.searchParams.has('pageSize') &&
      query.searchParams.get('pageSize') !== '1'
    );
  });
  await page.goto(url);
  const request = await asked;
  const started = Date.now();
  await expect(rowsOf(page).first()).toBeVisible();
  return {
    ms: Date.now() - started,
    pageSize: new URL(request.url()).searchParams.get('pageSize'),
  };
}

test.beforeAll(async ({ request }) => {
  projectId = await createProject(request, PROJECT_NAME, [
    { name: 'greeting', globs: ['src/greeting/**'] },
  ]);
  seed({ count: SCALE, state: 'open', grouped: GROUPED_SETS });
  seed({ count: SCALE, state: 'resolved' });
});

test.afterAll(async ({ request }) => {
  await resolveOwnCards(request);
});

test('Open at scale: the first page shows fast, 50 rows ask, few rows draw, and a group reads ×3', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { ms, pageSize } = await firstRowAfterRequest(page, inboxUrl(''));
  expect(pageSize).toBe('50');
  expect(ms).toBeLessThan(FIRST_ROW_BUDGET_MS);
  expect(await rowsOf(page).count()).toBeLessThan(100);
  const grouped = rowsOf(page).filter({ hasText: 'Open card 0002 repeated' });
  await expect(grouped).toContainText('×3');
});

test('Resolved at scale: the first row is fast and scrolling to the end asks for the next page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { ms } = await firstRowAfterRequest(page, inboxUrl('&state=resolved'));
  expect(ms).toBeLessThan(FIRST_ROW_BUDGET_MS);
  await expect(rowsOf(page).first()).toContainText('Resolved card 1999');

  const next = page.waitForRequest((request) => {
    const query = new URL(request.url());
    return query.pathname === '/inbox/page' && query.searchParams.has('after');
  });
  const viewport = page
    .getByRole('listbox', { name: 'Inbox' })
    .locator('xpath=ancestor::*[@data-scrollarea-viewport][1]');
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await next;
  // 50 rows were loaded (1999 down to 1950); once the next page lands, the end of the list holds older ones.
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(
    rowsOf(page)
      .filter({ hasText: /Resolved card 19[0-4]\d/ })
      .first(),
  ).toBeVisible();
});

test('one lookup: a card asks for its row alone and answers fast, and a dismissed group leaves', async ({
  page,
  request,
}) => {
  // The lookup the Inbox makes after an event, timed on its own: the whole-list reads that notifications still
  // make after every Inbox event (`GET /inbox`, which the daemon serves one at a time) queue ahead of a lookup
  // made from the page and would be measured with it.
  const grouped = z
    .object({ items: z.array(z.object({ id: z.string() })).min(1) })
    .parse(
      await (
        await request.get(
          `${daemonUrl}/inbox/page?state=open&pageSize=1&project=${projectId}&q=${encodeURIComponent('Open card 0003 repeated')}`,
          { headers: auth },
        )
      ).json(),
    );
  const id = grouped.items[0]?.id ?? '';
  const asked = Date.now();
  const looked = await request.get(
    `${daemonUrl}/inbox/page?state=open&pageSize=1&project=${projectId}&card=${id}`,
    { headers: auth },
  );
  const lookupMs = Date.now() - asked;
  expect(looked.ok()).toBe(true);
  expect(
    z.object({ rows: z.array(z.object({ ids: z.array(z.string()) })) }).parse(await looked.json())
      .rows[0]?.ids,
  ).toHaveLength(3);
  expect(lookupMs).toBeLessThan(LOOKUP_BUDGET_MS);

  await page.setViewportSize({ width: 1280, height: 900 });
  await firstRowAfterRequest(page, inboxUrl(''));
  const group = rowsOf(page).filter({ hasText: 'Open card 0002 repeated' });
  await group.hover();
  const lookup = page.waitForResponse((response) => {
    const query = new URL(response.url());
    return query.pathname === '/inbox/page' && query.searchParams.has('card');
  });
  await group.getByRole('button', { name: /^Dismiss All/ }).click();
  expect((await lookup).ok()).toBe(true);
  await expect(group).toHaveCount(0);
});

test('search finds one seeded card and the URL holds it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await firstRowAfterRequest(page, inboxUrl(''));
  await page.getByRole('textbox', { name: 'Search the Inbox' }).fill('Open card 0555');
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page).first()).toContainText('Open card 0555');
  await expect(page).toHaveURL(/q=Open\+card\+0555/);
});

for (const mode of ['dark', 'light'] as const) {
  test(`the panel is accessible, ${mode}`, async ({ page }) => {
    await scheme(page, mode);
    await page.setViewportSize({ width: 1280, height: 900 });
    await firstRowAfterRequest(page, inboxUrl(''));
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', mode);
    // A flag's row holds its Dismiss button inside the option, which axe reports as nested-interactive; the
    // rows are left out of the scan until the button moves beside the option, and everything else is scanned.
    await expectAccessible(page, `inbox panel, ${mode}`, ['[data-inbox-row]']);
  });
}

test('Resolved with a search, then the Board, then the rail: the Inbox returns to that search and row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await firstRowAfterRequest(page, inboxUrl('&state=resolved'));
  await page.getByRole('textbox', { name: 'Search the Inbox' }).fill('Resolved card 011');
  await expect(rowsOf(page)).toHaveCount(10);
  await rowsOf(page).nth(3).click();
  const picked = await rowsOf(page).nth(3).innerText();
  await expect(rowsOf(page).nth(3)).toHaveAttribute('aria-selected', 'true');
  const here = page.url();

  const rail = page.getByRole('navigation');
  await rail.getByRole('link', { name: /^Board/ }).click();
  await expect(page).toHaveURL(/\/board/);
  await rail.getByRole('link', { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(here);
  await expect(rowsOf(page)).toHaveCount(10);
  await expect(rowsOf(page).nth(3)).toHaveAttribute('aria-selected', 'true');
  expect(await rowsOf(page).nth(3).innerText()).toBe(picked);
});

test('the list keeps its scroll position through a visit to the Board', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await firstRowAfterRequest(page, inboxUrl(''));
  const viewport = page
    .getByRole('listbox', { name: 'Inbox' })
    .locator('xpath=ancestor::*[@data-scrollarea-viewport][1]');
  await rowsOf(page).first().hover();
  // The first wheel can land before the list takes input; the wheel is repeated until the list has moved.
  await expect(async () => {
    await page.mouse.wheel(0, 1500);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(1400);
  }).toPass();
  const left = await viewport.evaluate((el) => el.scrollTop);

  const rail = page.getByRole('navigation');
  await rail.getByRole('link', { name: /^Board/ }).click();
  await expect(page).toHaveURL(/\/board/);
  await rail.getByRole('link', { name: /^Inbox/ }).click();
  await expect(rowsOf(page).first()).toBeVisible();
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(left - 100);
});

const Picture = z.object({
  naturalWidth: z.number(),
  naturalHeight: z.number(),
  colours: z.number(),
  png: z.string(),
});

/** What a conversation's picture really holds, read back from its pixels. */
async function pictureOf(page: Page, name: RegExp): Promise<z.infer<typeof Picture>> {
  const image = page.getByRole('img', { name });
  await expect(image).toBeVisible();
  return Picture.parse(
    await image.evaluate(async (node: HTMLImageElement) => {
      await node.decode();
      const canvas = document.createElement('canvas');
      canvas.width = node.naturalWidth;
      canvas.height = node.naturalHeight;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no canvas');
      context.drawImage(node, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      return {
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
        colours: new Set(new Uint32Array(data.buffer)).size,
        png: canvas.toDataURL('image/png'),
      };
    }),
  );
}

// The frame a session's see_screen draws is the app in render mode, where the panel's rows are drawn for a
// picture: the picture of the Inbox must hold them, not an empty column.
test('a picture of the Inbox, drawn in render mode, shows its rows', async ({ page }) => {
  test.setTimeout(240_000);
  await claudeIsInstalled(page);
  await page.addInitScript((id: string) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
  }, projectId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/shape');
  await expect(page.getByRole('button', { name: /^Project: e2e-inbox/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Please see the inbox at 900');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByText('I saw the inbox: 1 picture.')).toBeVisible({ timeout: 100_000 });
  const inbox = await pictureOf(page, /The Inbox at 900×900/);
  const png = Buffer.from(inbox.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  await test.info().attach('inbox', { body: png, contentType: 'image/png' });
  const keepIn = process.env['E2E_SCREENSHOT_DIR'];
  if (keepIn !== undefined) writeFileSync(join(keepIn, 'inbox-render.png'), png);
  expect(inbox.naturalWidth).toBe(900);
  // Text anti-aliases into many shades: a picture of rows is far past a handful of colours.
  expect(inbox.colours).toBeGreaterThan(16);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('answering a question with a digit and Enter selects the next row and lowers the badge', async ({
  page,
  request,
}) => {
  await resolveOwnCards(request);
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
