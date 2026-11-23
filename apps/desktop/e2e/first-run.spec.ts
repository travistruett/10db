import { join } from 'node:path';
import { expect } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
import { expectAccessible } from './expect-accessible';
import { E2E_DIR } from './paths';
import { createProject, createRepository } from './shape-project';

// Core flow 1: the first run through to a project on the Board. It runs before every other spec in its
// shard (files run in name order with one worker), because the first run shows only while the daemon
// has no project. The Board shows the first project by name, so this one sorts after the `e2e` project
// that loop.spec.ts and the specs after it use. It adds its project on a repository of its own: a
// repository is one project at most, and those specs add theirs on the shared one.
const PROJECT = 'e2e-first-run';
const REPO = join(E2E_DIR, 'first-run-repo');

// A second project on its own repository, archived and restored at the end of the flow.
const ARCHIVED = 'e2e-first-run-archive';

test('a fresh install walks Welcome, the setup check and Add a project, and lands on the Board with the project', async ({
  page,
  request,
}) => {
  createRepository(REPO, {});
  await claudeIsInstalled(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Welcome to 10db' })).toBeVisible();
  await expectAccessible(page, 'welcome');

  await page.getByRole('button', { name: 'Get Started' }).click();
  await expect(page.getByRole('heading', { name: 'Check Your Setup' })).toBeVisible();
  await expect(page.getByText(/^Tasks will run as /)).toBeVisible();
  await expectAccessible(page, 'check your setup');

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(REPO);
  await page.getByRole('textbox', { name: 'Folder path' }).press('Enter');
  // The areas are proposed from the repository's files and history before the form is complete.
  await expect(page.getByRole('group', { name: 'Area 1' })).toBeVisible();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeVisible();
  await expectAccessible(page, 'add a project');

  await name.fill(PROJECT);
  const create = page.getByRole('button', { name: 'Create Project' });
  await expect(create).toBeEnabled();
  await create.click();

  // The first run gives way to the app: the Board opens on the new project, and a reload keeps it.
  await expect(page.getByRole('heading', { name: 'Welcome to 10db' })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Board', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.reload();
  await expect(page.getByRole('link', { name: 'Board', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'Welcome to 10db' })).toBeHidden();

  // Archiving a project takes it out of the switcher; Restore in Settings > Overview brings it back.
  await createProject(request, ARCHIVED);
  const archivedOption = page.getByRole('option', { name: new RegExp(ARCHIVED) });
  const openSwitcher = async () => {
    await page.getByRole('button', { name: /^Project: .*\. Switch project$/ }).click();
  };
  await page.reload();
  await openSwitcher();
  await archivedOption.click();
  await page.goto('/settings/general');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Board', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await openSwitcher();
  await expect(page.getByRole('option', { name: new RegExp(PROJECT) })).toBeVisible();
  await expect(archivedOption).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/settings/overview');
  await page.getByRole('button', { name: `Restore ${ARCHIVED}` }).click();
  await expect(page.getByRole('button', { name: `Restore ${ARCHIVED}` })).toHaveCount(0);
  await openSwitcher();
  await expect(archivedOption).toBeVisible();
});
