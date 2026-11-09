import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { DESKTOP_DIR, E2E_DATA, E2E_DIR, E2E_TOKEN } from './paths';

// Runs after loop.spec.ts (files run in name order with one worker); it adds its own project, on its
// own repository, and selects it.

const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
const Created = z.looseObject({ id: z.string() });

/** Where the full-window screenshots go; unset, they are not taken. */
const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

const WORKTREE_REPO = join(E2E_DIR, 'worktree-repo');
const OPEN_BATCHES = [
  { title: 'Rename the greeting', state: 'RUNNING' },
  { title: 'Add the farewell', state: 'VERIFYING' },
  { title: 'Document the greeting', state: 'QUEUED' },
] as const;
const FINISHED_BATCH = 'Fix the typo';

/** One goal whose task has not started, so the project holds a goal beside the running goal-less tasks. */
const GOAL_TITLE = 'Greet properly';
const GOAL_BRIEF = `---
title: ${GOAL_TITLE}
objective: Every greeting reads well.
tasks:
  - key: polish-greeting
    title: Polish the greeting
    areas: [docs]
---
`;

const GOALS_REPO = join(E2E_DIR, 'goals-repo');

/** A disposable repository for a project; git config comes from nowhere but this repo. */
function createRepository(repo: string = WORKTREE_REPO): void {
  mkdirSync(repo, { recursive: true });
  const globalConfig = join(E2E_DIR, 'worktree-gitconfig');
  writeFileSync(globalConfig, '');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'user.email', 'e2e@10db.invalid');
  git('config', 'user.name', '10db e2e');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# worktree e2e\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial commit');
}

/**
 * A worktree-mode project with three open batches, one task each, and a shipped one. Starting real
 * batches needs a GitHub origin and a signed-in gh, so the daemon-side seed script writes the
 * batches and workstreams into the database directly.
 */
async function seedProject(request: Page['request']): Promise<string> {
  createRepository();
  const project = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name: 'worktrees',
      repoPath: WORKTREE_REPO,
      gateCommand: 'true',
      areas: [{ name: 'docs', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'pull_request',
      workspaceMode: 'worktree',
    },
  });
  expect(project.ok()).toBe(true);
  const projectId = Created.parse(await project.json()).id;
  const adopted = await request.post(`${daemonUrl}/projects/${projectId}/goals/adopt`, {
    headers: auth,
    data: { text: GOAL_BRIEF },
  });
  expect(adopted.status()).toBe(201);
  const open = [];
  for (const batch of OPEN_BATCHES) {
    const task = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
      headers: auth,
      data: { title: batch.title, acceptanceCriteria: ['it is done'], areas: ['docs'] },
    });
    expect(task.ok()).toBe(true);
    open.push({ taskId: Created.parse(await task.json()).id, ...batch });
  }
  const daemonDir = resolve(DESKTOP_DIR, '../daemon');
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-worktree-batches.ts',
      join(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId,
        worktreeRoot: join(E2E_DIR, 'worktrees'),
        open,
        shipped: [{ title: FINISHED_BATCH, prUrl: 'https://github.com/acme/widgets/pull/7' }],
      }),
    ],
    { cwd: daemonDir, stdio: 'inherit' },
  );
  return projectId;
}

/** The columns' minimum height, as the Board declares it. */
const COLUMNS_MIN_HEIGHT = 320;

/** Puts a banner of this height above the Board, as the reconnecting banner does, and waits for it to lay out. */
async function addBannerAbove(page: Page, height: number): Promise<void> {
  await page.evaluate((px: number) => {
    const banner = document.createElement('div');
    banner.dataset['testid'] = 'test-banner';
    banner.style.cssText = `flex: none; height: ${String(px)}px; background: #888;`;
    document.querySelector('main')?.prepend(banner);
  }, height);
  await expect(page.getByTestId('test-banner')).toBeVisible();
}

async function boxOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`${testId} has no box`);
  return box;
}

/** How far below the window's bottom edge the columns' minimum height reaches; negative when it fits. */
async function overflowOfMinimum(page: Page): Promise<number> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  const columns = await boxOf(page, 'board-columns');
  return columns.y + COLUMNS_MIN_HEIGHT - viewport.height;
}

function columnHeader(page: Page) {
  return page.getByTestId('board-columns').getByText('In progress', { exact: true }).first();
}

async function expectColumnsUsable(page: Page): Promise<void> {
  await expect(page.getByTestId('board-columns')).toBeVisible();

  // The columns are laid out.
  await expect(page.getByRole('list', { name: 'Ready tasks' })).toBeAttached();
  expect((await boxOf(page, 'board-columns')).height).toBeGreaterThanOrEqual(COLUMNS_MIN_HEIGHT);

  // Nothing sits above the columns: no goal strip, no batch strip (the batch history is Factory's,
  // not the Board's), and with All goals chosen no goal line either.
  await expect(page.getByTestId('board-above-columns')).toHaveCount(0);
  await expect(page.getByTestId('goal-strip')).toHaveCount(0);
  await expect(page.getByTestId('goal-line')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Batches \(\d+\)$/ })).toHaveCount(0);
  for (const { title } of OPEN_BATCHES) {
    await expect(page.getByRole('listitem', { name: title })).toBeAttached();
  }
}

/** The page can be scrolled until the columns' bottom edge is on screen. */
async function expectColumnsBottomReachable(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  await page.getByTestId('board-columns').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const columns = await boxOf(page, 'board-columns');
  expect(columns.y + columns.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(columns.height).toBeGreaterThanOrEqual(COLUMNS_MIN_HEIGHT);
}

/**
 * `roomy` windows have height to spare for the strips and the columns' minimum on every platform;
 * a short one may not (Linux's fonts run taller than macOS's), so there only reachability holds.
 */
const SIZES = [
  { width: 1440, height: 900, roomy: true },
  { width: 1280, height: 720, roomy: false },
] as const;

/** What the columns' header, hint and footer need above the declared minimum height. */
const CONTENT_ALLOWANCE = 30;

/** Taller than any real banner on its own, so the columns cannot fit beside it. */
const TALL_BANNER = 300;

test.describe.configure({ mode: 'serial' });

test.describe('the Board with several open batches', () => {
  let projectId = '';

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    projectId = await seedProject(request);
    await request.dispose();
  });

  // A test can end with the app's /system read still in the route; drop it rather than fail.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  async function openBoard(page: Page, size: { width: number; height: number }): Promise<void> {
    await page.setViewportSize(size);
    await claudeIsInstalled(page);
    await page.addInitScript((id: string) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
    }, projectId);
    await page.goto('/board');
    await expect(page.getByTestId('board-columns')).toBeVisible();
  }

  for (const size of SIZES) {
    const label = `${String(size.width)}x${String(size.height)}`;

    test(`flexes open columns between 260 and 380 px and folds empty ones to rails at ${label}`, async ({
      page,
    }) => {
      await openBoard(page, size);
      await expectColumnsUsable(page);
      // Ready is open even when empty (it holds Add Task); the seeded open tasks sit in open columns.
      const ready = page
        .getByRole('list', { name: 'Ready tasks' })
        .locator('xpath=ancestor::*[contains(@class, "mantine-Paper-root")][1]');
      const open = await ready.boundingBox();
      expect(open).not.toBeNull();
      expect(open?.width).toBeGreaterThanOrEqual(260);
      expect(open?.width).toBeLessThanOrEqual(381);
      // Every rail is 44 px wide, and the label and count stay readable on it.
      for (const rail of await page.getByRole('group', { name: /, collapsed$/ }).all()) {
        expect((await rail.boundingBox())?.width).toBeCloseTo(44, 0);
      }
    });

    test(`keeps the columns visible at ${label}`, async ({ page }) => {
      await openBoard(page, size);
      await expectColumnsUsable(page);
      await expect(columnHeader(page)).toBeInViewport();
      if (size.roomy) {
        // Nothing above the columns: the Board fills the window and the page does not scroll.
        expect(await overflowOfMinimum(page)).toBeLessThanOrEqual(0);
        const scrolls = await page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight,
        );
        expect(scrolls).toBeLessThanOrEqual(1);
      }
      await expectColumnsBottomReachable(page);
    });

    // A short window may have no room to give back.
    if (size.roomy) {
      test(`shrinks to the space an alert leaves at ${label}`, async ({ page }) => {
        await openBoard(page, size);
        const slack = -(await overflowOfMinimum(page));
        expect(slack).toBeGreaterThan(CONTENT_ALLOWANCE);
        // The minimum height still fits beside the banner (with room for what the columns' own content
        // needs beyond it), so the Board gives up height instead of overflowing.
        await addBannerAbove(page, Math.floor(slack - CONTENT_ALLOWANCE));
        await expectColumnsUsable(page);
        await expect(columnHeader(page)).toBeInViewport();
        const columns = await boxOf(page, 'board-columns');
        expect(columns.y + columns.height).toBeLessThanOrEqual(size.height);
      });
    }

    test(`lets the page scroll to the columns' end under a tall alert at ${label}`, async ({
      page,
    }) => {
      await openBoard(page, size);
      await addBannerAbove(page, TALL_BANNER);
      await expectColumnsUsable(page);
      // The alert pushes the columns below the fold; scrolling the page reaches both ends.
      await columnHeader(page).scrollIntoViewIfNeeded();
      await expect(columnHeader(page)).toBeInViewport();
      await expectColumnsBottomReachable(page);
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `e2e-board-${String(size.width)}.png`) });
      }
    });

    test(`lists the goal and the running tasks in Factory at ${label}, accessibly in dark and light`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await claudeIsInstalled(page);
      await page.addInitScript((id: string) => {
        window.localStorage.setItem('tendb.project', JSON.stringify(id));
      }, projectId);
      await page.goto('/factory');
      await expect(page.getByRole('heading', { name: 'Factory', level: 2 })).toBeVisible();

      // Every row starts collapsed. The queued task is not running: only two of the three count.
      const goal = page.getByRole('button', { name: new RegExp(`^${GOAL_TITLE}`) });
      const ungrouped = page.getByRole('button', { name: /^Not in a goal/ });
      await expect(goal).toHaveAttribute('aria-expanded', 'false');
      await expect(ungrouped).toHaveAttribute('aria-expanded', 'false');
      await expect(goal).toContainText('Not started');
      await expect(ungrouped).toContainText('2 running');
      await expect(ungrouped).not.toContainText('3 running');

      for (const scheme of ['dark', 'light'] as const) {
        if (scheme === 'light') {
          await page.getByRole('button', { name: 'Switch to light mode' }).click();
          await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
        }
        await expectAccessible(page, `factory, collapsed, ${scheme}`);

        await goal.click();
        const goalRegion = page.getByRole('region', { name: GOAL_TITLE });
        await expect(goalRegion.getByText('Tasks', { exact: true })).toBeVisible();
        await expect(goalRegion.getByRole('button', { name: 'Start Ready Tasks…' })).toBeVisible();
        // The window has loaded once its summary is on the Since you last looked line.
        await expect(
          goalRegion.getByRole('button', { name: /^Since you last looked.+/ }),
        ).toBeVisible();
        await expectAccessible(page, `factory, goal open, ${scheme}`);

        // One at a time: opening Not in a goal closes the goal, and the queued task is not among its sessions.
        await ungrouped.click();
        await expect(goal).toHaveAttribute('aria-expanded', 'false');
        const sessions = page.getByRole('region', { name: 'Not in a goal' }).getByRole('table');
        await expect(
          sessions.getByRole('row', { name: new RegExp(OPEN_BATCHES[0].title) }),
        ).toBeVisible();
        await expect(sessions.getByText(OPEN_BATCHES[2].title)).toHaveCount(0);
        await expect(sessions.getByText('Queued')).toHaveCount(0);
        await expectAccessible(page, `factory, ungrouped open, ${scheme}`);

        // Escape closes the open row.
        await page.keyboard.press('Escape');
        await expect(ungrouped).toHaveAttribute('aria-expanded', 'false');
      }
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `e2e-factory-${String(size.width)}.png`) });
      }
    });
  }
});

const GOAL_TITLES = ['Greet the visitor', 'Say farewell', 'Tidy the rooms'] as const;

/** A brief with two tasks, so its goal has open tasks. */
function briefOf(title: string, n: number): string {
  return [
    '---',
    `title: ${title}`,
    'objective: Every visitor is looked after.',
    'tasks:',
    `  - key: first-${String(n)}`,
    `    title: ${title}, part one`,
    '    areas: [docs]',
    `  - key: second-${String(n)}`,
    `    title: ${title}, part two`,
    '    areas: [docs]',
    '---',
    '',
  ].join('\n');
}

/** A project with three goals, each with open tasks, adopted from briefs through the daemon's own route. */
async function seedGoals(request: Page['request']): Promise<string> {
  createRepository(GOALS_REPO);
  const project = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name: 'goals',
      repoPath: GOALS_REPO,
      gateCommand: 'true',
      areas: [{ name: 'docs', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
    },
  });
  expect(project.ok()).toBe(true);
  const projectId = Created.parse(await project.json()).id;
  for (const [n, title] of GOAL_TITLES.entries()) {
    const adopted = await request.post(`${daemonUrl}/projects/${projectId}/goals/adopt`, {
      headers: auth,
      data: { text: briefOf(title, n) },
    });
    expect(adopted.status()).toBe(201);
  }
  return projectId;
}

test.describe('the Board with three goals', () => {
  let projectId = '';

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    projectId = await seedGoals(request);
    await request.dispose();
  });

  // The test ends on Factory, whose /system read may still be in the route; drop it rather than fail.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  for (const size of SIZES) {
    const label = `${String(size.width)}x${String(size.height)}`;

    test(`shows no goal strips, one line for a chosen goal, and keeps the columns' minimum height at ${label}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await claudeIsInstalled(page);
      await page.addInitScript((id: string) => {
        window.localStorage.setItem('tendb.project', JSON.stringify(id));
      }, projectId);
      await page.goto('/board');
      await expect(page.getByTestId('board-columns')).toBeVisible();

      // No strip per goal above the columns, and no goal among the cards.
      await expect(page.getByTestId('board-above-columns')).toHaveCount(0);
      await expect(page.getByTestId('goal-strip')).toHaveCount(0);
      await expect(page.getByTestId('goal-line')).toHaveCount(0);
      for (const title of GOAL_TITLES) {
        // The goal's title shows in the columns only as the badge in the indicator row of its two
        // tasks' cards (these titles are short enough to show whole).
        // A Mantine badge puts its text in an inner span, so the test id sits on the span's parent.
        const columns = page.getByTestId('board-columns');
        await expect(
          columns.getByTestId('indicator-goal').filter({ hasText: new RegExp(`^${title}$`) }),
        ).toHaveCount(2);
        await expect(columns.getByText(title, { exact: true })).toHaveCount(2);
      }

      // The columns keep their minimum height; where the window is short the page scrolls.
      await expect(page.getByRole('list', { name: 'Ready tasks' })).toBeAttached();
      expect((await boxOf(page, 'board-columns')).height).toBeGreaterThanOrEqual(
        COLUMNS_MIN_HEIGHT,
      );
      await expectColumnsBottomReachable(page);
      if (size.roomy) expect(await overflowOfMinimum(page)).toBeLessThanOrEqual(0);

      // Choosing a goal shows its one line beside the select, with no drawer.
      await page.getByRole('combobox', { name: 'Goal' }).click();
      await page.getByRole('option', { name: GOAL_TITLES[0] }).click();
      const line = page.getByTestId('goal-line');
      await expect(line).toBeVisible();
      await expect(line.getByRole('button', { name: 'Start Ready…' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Goal' })).toHaveCount(0);
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `e2e-board-goals-${String(size.width)}.png`) });
      }

      // Open in Factory lands on that goal expanded.
      await line.getByRole('button', { name: /^Open in Factory/ }).click();
      await expect(page).toHaveURL(/\/factory\?goal=/);
      await expect(
        page.getByRole('button', { name: new RegExp(`^${GOAL_TITLES[0]}`) }),
      ).toHaveAttribute('aria-expanded', 'true');
    });
  }
});
