import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { E2E_DIR, E2E_TOKEN } from './paths';

// Runs after loop.spec.ts (files run in name order with one worker); it adds its own project, on its
// own repository, and selects it. The daemon answers Shape sessions from the fake adapter: it echoes
// what it heard, and on Propose it proposes a goal, two loose tasks and a decision.

const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
const Created = z.looseObject({ id: z.string() });
const Tasks = z.array(z.looseObject({ id: z.string(), title: z.string() }));

const MESSAGE = 'Make the cards denser. Thin out the scrollbars';

/** A disposable repository for the project; git config comes from nowhere but this repo. */
function createRepository(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const globalConfig = join(E2E_DIR, 'shape-gitconfig');
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
  writeFileSync(join(repo, 'README.md'), '# shape e2e\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial commit');
}

/** A project on its own repository, so one scheme's converted tasks never meet the other's. */
async function createProject(request: APIRequestContext, name: string): Promise<string> {
  const repo = join(E2E_DIR, `${name}-repo`);
  createRepository(repo);
  const created = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name,
      repoPath: repo,
      gateCommand: 'true',
      areas: [{ name: 'repo', globs: ['**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'local',
    },
  });
  expect(created.ok()).toBe(true);
  return Created.parse(await created.json()).id;
}

async function taskTitles(request: APIRequestContext, projectId: string): Promise<string[]> {
  const listed = await request.get(`${daemonUrl}/projects/${projectId}/tasks`, { headers: auth });
  return Tasks.parse(await listed.json()).map((t) => t.title);
}

async function openShape(page: Page, projectId: string, scheme: 'dark' | 'light'): Promise<void> {
  await claudeIsInstalled(page);
  await page.addInitScript(
    ([id = '', value = '']: string[]) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
      window.localStorage.setItem('mantine-color-scheme-value', value);
    },
    [projectId, scheme],
  );
  await page.goto('/shape');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
}

test.describe.configure({ mode: 'serial' });

const projects = new Map<string, string>();

for (const scheme of ['dark', 'light'] as const) {
  test(`a builder talks, proposes and converts from the keyboard in ${scheme}, and every state passes axe`, async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `shape-${scheme}`);
    projects.set(scheme, projectId);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShape(page, projectId, scheme);

    // The first run: the input has focus and says what nothing does until you act.
    const input = page.getByRole('textbox', { name: 'Message' });
    await expect(input).toBeFocused();
    await expect(
      page.getByText(
        'Nothing is proposed until you press Propose. Nothing starts until you Convert.',
      ),
    ).toBeVisible();
    await expectAccessible(page, `first run, ${scheme}`);

    // ⌘↩ sends: Claude echoes what it heard in the sidebar.
    await page.keyboard.type(MESSAGE);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page).toHaveURL(/\/shape\/shp_/);
    const sidebar = page.getByRole('region', { name: 'Proposed' });
    await expect(sidebar.getByText('Heard so far')).toBeVisible();
    await expect(sidebar.getByText('Make the cards denser')).toBeVisible();
    await expectAccessible(page, `listening, ${scheme}`);

    // ⌘⇧↩ proposes; the round's summary is announced and focus stays in the input.
    await expect(page.getByRole('button', { name: 'Propose', exact: true })).toBeEnabled();
    await input.focus();
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(page.getByRole('status', { name: 'Round summary' })).toHaveText(
      'Round 1: 4 changes',
    );
    await expect(input).toBeFocused();
    await expect(page.getByRole('group', { name: 'Summary' })).toHaveText(
      '1 goal · 2 loose · 1 to record',
    );
    await expect(page.getByRole('button', { name: 'Propose Again' })).toBeVisible();
    await expectAccessible(page, `proposed, ${scheme}`);

    // ↑/↓ move between rows; Enter opens one, read-only.
    const rows = sidebar.getByRole('list', { name: 'Proposed rows' }).getByRole('button', {
      expanded: false,
    });
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sidebar.getByText('The board is denser and calmer to scan.')).toBeVisible();
    await expectAccessible(page, `a row open, ${scheme}`);

    // Convert says nothing starts, and writes the ticked rows to the Board's Backlog.
    await page.getByRole('button', { name: 'Convert…' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Convert' });
    await expect(dialog.getByText('Nothing starts. Tasks wait on the Board.')).toBeVisible();
    await expectAccessible(page, `convert, ${scheme}`);
    const before = (await taskTitles(request, projectId)).length;
    await dialog.getByRole('button', { name: 'Convert 4' }).click();
    await expect(dialog).toBeHidden();
    await expect(sidebar.getByText('Converted · on the Board')).toHaveCount(3);
    await expect(sidebar.getByText('Converted · in Knowledge')).toHaveCount(1);
    const titles = await taskTitles(request, projectId);
    expect(titles).toHaveLength(before + 4);
    expect(titles).toEqual(expect.arrayContaining(['Compact card density', 'Thin scrollbars']));
    await expectAccessible(page, `converted, ${scheme}`);

    // Remove Draft Goal takes the goal and its tasks back, and the goal is proposed again.
    await page.getByRole('button', { name: 'Actions for Board polish' }).click();
    await page.getByRole('menuitem', { name: 'Remove Draft Goal' }).click();
    await page
      .getByRole('dialog', { name: 'Remove Draft Goal' })
      .getByRole('button', { name: 'Remove Draft Goal' })
      .click();
    await expect(sidebar.getByText('Converted · on the Board')).toHaveCount(2);
    expect(await taskTitles(request, projectId)).toHaveLength(before + 2);
  });
}

test('under 1100 px the sidebar is a drawer, and the summary line stays on screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const projectId = projects.get('dark');
  if (projectId === undefined) throw new Error('The dark run makes the project this test opens');
  await openShape(page, projectId, 'dark');
  await page.getByRole('textbox', { name: 'Message' }).fill(MESSAGE);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/\/shape\/shp_/);
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Summary' })).toHaveText(
    '1 goal · 2 loose · 1 to record',
  );
  const toggle = page.getByRole('button', { name: 'Proposed', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expectAccessible(page, 'drawer closed');
  await toggle.click();
  await expect(page.getByRole('region', { name: 'Proposed' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Summary' })).toBeVisible();
  await expectAccessible(page, 'drawer open');
});
