import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { daemonUrl } from './daemon-url';
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

/** A disposable repository for the worktree-mode project; git config comes from nowhere but this repo. */
function createRepository(): void {
  mkdirSync(WORKTREE_REPO, { recursive: true });
  const globalConfig = join(E2E_DIR, 'worktree-gitconfig');
  writeFileSync(globalConfig, '');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: WORKTREE_REPO, env, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'user.email', 'e2e@10db.invalid');
  git('config', 'user.name', '10db e2e');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(WORKTREE_REPO, 'README.md'), '# worktree e2e\n');
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

async function expectColumnsUsable(page: Page): Promise<void> {
  const columns = page.getByTestId('board-columns');
  const above = page.getByTestId('board-above-columns');
  await expect(columns).toBeVisible();
  await expect(above).toBeVisible();

  const viewport = page.viewportSize();
  const columnsBox = await columns.boundingBox();
  const aboveBox = await above.boundingBox();
  expect(viewport).not.toBeNull();
  expect(columnsBox).not.toBeNull();
  expect(aboveBox).not.toBeNull();
  if (!viewport || !columnsBox || !aboveBox) return;

  expect(columnsBox.height).toBeGreaterThanOrEqual(320);
  // In the viewport: the columns' top edge and at least their minimum height are on screen.
  expect(columnsBox.y).toBeGreaterThanOrEqual(0);
  expect(columnsBox.y + 320).toBeLessThanOrEqual(viewport.height);
  // The strips and history take at most a third of the board, with a little rounding room.
  const boardBox = await above.locator('..').boundingBox();
  expect(boardBox).not.toBeNull();
  if (!boardBox) return;
  expect(aboveBox.height).toBeLessThanOrEqual(boardBox.height / 3 + 1);

  // A column header is on screen, so the columns are not merely sized but laid out.
  await expect(page.getByRole('list', { name: 'Ready tasks' })).toBeAttached();
  await expect(columns.getByText('Running', { exact: true }).first()).toBeInViewport();

  // Every strip is reachable: scrolling the region brings each title into view.
  for (const { title } of OPEN_BATCHES) {
    const strip = above.getByText(title, { exact: true });
    await strip.scrollIntoViewIfNeeded();
    await expect(strip).toBeInViewport();
  }

  // The history is collapsed until asked for.
  const history = above.getByRole('button', { name: /^Batches \(\d+\)$/ });
  await history.scrollIntoViewIfNeeded();
  await expect(history).toHaveText('Batches (1)');
  await expect(history).toHaveAttribute('aria-expanded', 'false');
  await expect(above.getByRole('list', { name: 'Batches' })).toBeHidden();
}

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
] as const;

test.describe.configure({ mode: 'serial' });

test.describe('the Board with several open batches', () => {
  let projectId = '';

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    projectId = await seedProject(request);
    await request.dispose();
  });

  for (const size of SIZES) {
    test(`keeps the columns visible at ${String(size.width)}x${String(size.height)}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.addInitScript((id: string) => {
        window.localStorage.setItem('tendb.project', JSON.stringify(id));
      }, projectId);
      await page.goto('/board');
      await expect(page.getByTestId('board-columns')).toBeVisible();
      await expectColumnsUsable(page);
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `e2e-board-${String(size.width)}.png`) });
      }
    });
  }
});
