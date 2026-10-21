import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_REPO } from './paths';

const TASK = 'Write the greeting';
const QUESTION = 'Which greeting?';
const VIEWS = ['Board', 'Factory', 'Inbox'] as const;

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  // Each entry names the rule and the offending nodes, so a failure says what to fix.
  const found = results.violations.map(
    (v) => `${label}: ${v.id} (${v.help}) on ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(found).toEqual([]);
}

async function open(page: Page, view: (typeof VIEWS)[number]): Promise<void> {
  await page.getByRole('link', { name: view }).click();
  await expect(page.getByRole('heading', { name: view, level: 2 })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('runs a task from the UI to verified done, and a reload loses nothing', async ({ page }) => {
  await page.goto('/board');
  await expect(page.getByText('No projects yet. Create one to start.')).toBeVisible();
  await expectAccessible(page, 'board, empty, dark');

  // Create the project on the disposable repo.
  await page.getByRole('button', { name: 'New project' }).click();
  const projectDialog = page.getByRole('dialog', { name: 'New project' });
  await projectDialog.getByLabel('Name', { exact: true }).fill('e2e');
  await projectDialog.getByLabel('Repository path').fill(E2E_REPO);
  await projectDialog
    .getByLabel('Gate command')
    .fill(
      "test -f src/greeting/hello.txt && git diff --quiet HEAD && git log -1 --format=%s | grep -qx 'Add the greeting'",
    );
  await projectDialog.getByLabel('Areas').fill('greeting: src/greeting/**');
  await projectDialog.getByRole('button', { name: 'Create project' }).click();
  await expect(projectDialog).toBeHidden();

  // Create the task; its only area is preselected.
  await page.getByRole('button', { name: 'New task' }).click();
  const taskDialog = page.getByRole('dialog', { name: 'New task' });
  await taskDialog.getByLabel('Title').fill(TASK);
  await taskDialog.getByLabel('Acceptance criteria').fill('src/greeting/hello.txt exists');
  await taskDialog.getByRole('button', { name: 'Create task' }).click();
  await expect(taskDialog).toBeHidden();

  const card = page.getByRole('listitem', { name: TASK });
  await card.getByRole('button', { name: `Actions for ${TASK}` }).click();
  await page.getByRole('menuitem', { name: 'Start' }).click();

  // The agent's question reaches the inbox; answer it from the keyboard.
  await open(page, 'Inbox');
  await expect(page.getByText(QUESTION)).toBeVisible();
  await expectAccessible(page, 'inbox, question, dark');
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).click();
  await page.keyboard.press('2');
  await expect(page.getByRole('radio', { name: /Howdy/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page.getByText(QUESTION)).toBeHidden();

  // The work resumes, commits, passes 10db's gate and is DONE.
  await open(page, 'Factory');
  await page.getByRole('switch', { name: 'Show finished' }).check();
  await expect(page.getByRole('switch', { name: 'Show finished' })).toBeChecked();
  const factoryRow = page.getByRole('row', { name: new RegExp(TASK) });
  await expect(factoryRow.getByText('Done', { exact: true })).toBeVisible();
  await expectAccessible(page, 'factory, done, dark');

  await open(page, 'Board');
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: TASK }),
  ).toBeVisible();

  // Reopening the window loses nothing: the state comes back from the daemon.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Board', level: 2 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: TASK }),
  ).toBeVisible();
  await open(page, 'Inbox');
  await expect(page.getByText(`Review: ${TASK}`)).toBeVisible();
  // The MCP commit really landed: the runner counts the commits it recorded before the gate.
  await expect(page.getByText('Gate passed with 1 commit(s).')).toBeVisible();
  await expect(page.getByText(QUESTION)).toHaveCount(0);

  // Light mode must be just as usable.
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  for (const view of VIEWS) {
    await open(page, view);
    await expectAccessible(page, `${view.toLowerCase()}, light`);
  }
});
