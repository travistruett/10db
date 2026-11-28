import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { DESKTOP_DIR, E2E_DATA, E2E_DIR } from './paths';
import { test } from './routed-test';
import { auth } from './shape-project';

// Activity against the real daemon: abandoning a batch whose branch holds nothing makes 10db delete the branch
// and post one notice. It shows in the Factory's Activity drawer, and neither Open's count nor the rail's badge moves. It runs in a
// project of its own, on its own repository, with one batch seeded the way a real start would leave it.

const PROJECT_NAME = 'e2e-activity';
const REPO = join(E2E_DIR, 'activity-repo');
const BRANCH = '10db/activity-e2e';
const BATCH_TITLE = 'Say goodbye';
const NOTICE_LINE = `Batch "${BATCH_TITLE}" abandoned: ${BRANCH} deleted`;

const Created = z.looseObject({ id: z.string() });
const Page_ = z.looseObject({ total: z.number() });
const Notices = z.object({
  rows: z.array(z.looseObject({ line: z.string(), body: z.string() })),
});
const OpenCards = z.array(z.looseObject({ id: z.string(), projectId: z.string() }));
const Batches = z.array(z.looseObject({ id: z.string(), title: z.string() }));

const SystemAnswer = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      path: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
});

/** Every tool the system check looks for is found, so the rail's badge is the daemon's count alone. */
async function toolsAreInstalled(page: Page): Promise<void> {
  await page.route(`${daemonUrl}/system*`, async (route) => {
    const response = await route.fetch({ maxRetries: 2 });
    const body = SystemAnswer.parse(await response.json());
    for (const tool of body.tools) {
      tool.path ??= `/usr/local/bin/${tool.name}`;
      tool.version ??= '1.0.0';
    }
    await route.fulfill({ response, json: body });
  });
}

let projectId = '';

/** A disposable repository, its git config from nowhere but itself, with the batch's branch cut at `HEAD`. */
function createRepository(): void {
  mkdirSync(REPO, { recursive: true });
  const globalConfig = join(E2E_DIR, 'activity-gitconfig');
  writeFileSync(globalConfig, '');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: REPO, env, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'receive.autogc', 'false');
  git('config', 'user.email', 'e2e@10db.invalid');
  git('config', 'user.name', '10db e2e');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(REPO, 'README.md'), '# activity e2e\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial commit');
  // The batch's branch holds no commits beyond HEAD.
  git('branch', BRANCH);
}

const head = (): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  }).trim();

async function seedProject(request: APIRequestContext): Promise<string> {
  createRepository();
  const created = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name: PROJECT_NAME,
      repoPath: REPO,
      gateCommand: 'true',
      areas: [{ name: 'docs', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'pull_request',
      workspaceMode: 'shared',
    },
  });
  expect(created.ok()).toBe(true);
  const id = Created.parse(await created.json()).id;
  const task = await request.post(`${daemonUrl}/projects/${id}/tasks`, {
    headers: auth,
    data: { title: BATCH_TITLE, acceptanceCriteria: ['it is done'], areas: ['docs'] },
  });
  expect(task.ok()).toBe(true);
  // Starting a real batch needs a GitHub origin and a signed-in gh, so the batch is written into the idle
  // daemon's database, on the branch and base commit a start would have cut.
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-worktree-batches.ts',
      join(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId: id,
        worktreeRoot: E2E_DIR,
        open: [
          {
            taskId: Created.parse(await task.json()).id,
            title: BATCH_TITLE,
            // Held, so no lane picks it up and fails it into a card of its own.
            state: 'HELD',
            worktree: false,
            branch: BRANCH,
            baseSha: head(),
          },
        ],
        shipped: [],
      }),
    ],
    { cwd: resolve(DESKTOP_DIR, '../daemon'), stdio: 'inherit' },
  );
  return id;
}

async function openTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get(
    `${daemonUrl}/inbox/page?state=open&pageSize=1&project=${projectId}`,
    { headers: auth, maxRetries: 2 },
  );
  return Page_.parse(await response.json()).total;
}

async function openCardIds(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(`${daemonUrl}/inbox?state=OPEN`, {
    headers: auth,
    maxRetries: 2,
  });
  return OpenCards.parse(await response.json())
    .filter((card) => card.projectId === projectId)
    .map((card) => card.id);
}

async function noticeBodies(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(`${daemonUrl}/activity/page?project=${projectId}`, {
    headers: auth,
    maxRetries: 2,
  });
  return Notices.parse(await response.json())
    .rows.filter((row) => row.line === NOTICE_LINE)
    .map((row) => row.body);
}

test.beforeAll(async ({ request }) => {
  projectId = await seedProject(request);
});

test('a deleted empty branch shows in the Factory Activity drawer, and Open and the badge do not move', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // The rail's badge also counts 10db's own cards, one for each tool the system check does not find; with
  // every tool found it is the daemon's count.
  await toolsAreInstalled(page);
  await page.goto(`/inbox?project=${projectId}`);
  const badge = page.getByRole('navigation').getByRole('link', { name: /^Inbox/ });
  const badgeText = async (): Promise<string> =>
    (await badge.getByText(/open cards?/i).count()) === 0
      ? ''
      : await badge.getByText(/open cards?/i).innerText();
  const settled = await badgeText();

  const openBefore = await openTotal(request);
  const cardsBefore = await openCardIds(request);

  const batches = Batches.parse(
    await (
      await request.get(`${daemonUrl}/projects/${projectId}/batches`, {
        headers: auth,
        maxRetries: 2,
      })
    ).json(),
  );
  const batch = batches.find((entry) => entry.title === BATCH_TITLE);
  expect(batch).toBeDefined();
  const abandoned = await request.post(`${daemonUrl}/batches/${batch?.id ?? ''}/abandon`, {
    headers: auth,
  });
  expect(abandoned.ok()).toBe(true);
  await expect.poll(() => noticeBodies(request), { timeout: 30_000 }).toHaveLength(1);

  for (const mode of ['dark', 'light'] as const) {
    await page.addInitScript((value: string) => {
      window.localStorage.setItem('mantine-color-scheme-value', value);
    }, mode);
    // The notice is in the Factory's Activity drawer; the Inbox never lists it.
    await page.goto(`/factory?project=${projectId}`);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Activity' });
    const row = drawer.getByRole('button', { name: new RegExp(NOTICE_LINE) });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId('activity-content')).toContainText(
      `The branch ${BRANCH} held no commits beyond main`,
    );
    await expectAccessible(page, `activity, ${mode}`);
  }

  // The abandon notice reports no decision, so Decided For You leaves it out, in the drawer and in the daemon's page.
  const decided = await request.get(
    `${daemonUrl}/activity/page?project=${projectId}&decided=true`,
    { headers: auth, maxRetries: 2 },
  );
  expect(
    Notices.parse(await decided.json()).rows.filter((row) => row.line === NOTICE_LINE),
  ).toHaveLength(0);
  await page.goto(`/factory?project=${projectId}`);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Activity' });
  await expect(drawer.getByRole('button', { name: new RegExp(NOTICE_LINE) })).toBeVisible();
  await drawer.getByLabel('Decided For You').check();
  await expect(drawer.getByRole('button', { name: new RegExp(NOTICE_LINE) })).toHaveCount(0);

  expect(await openTotal(request)).toBe(openBefore);
  expect(await openCardIds(request)).toEqual(cardsBefore);
  expect(await badgeText()).toBe(settled);
});
