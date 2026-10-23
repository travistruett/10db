import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_REPO } from './paths';

const TASK = 'Write the greeting';
const OTHER = 'Tidy the readme';
const QUESTION = 'Which greeting?';
const VIEWS = ['Board', 'Factory', 'Inbox', 'Settings'] as const;

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  // Each entry names the rule and the offending nodes, so a failure says what to fix.
  const found = results.violations.map(
    (v) => `${label}: ${v.id} (${v.help}) on ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(found).toEqual([]);
}

async function open(page: Page, view: (typeof VIEWS)[number]): Promise<void> {
  await page.getByRole('link', { name: new RegExp(`^${view}( \\d+ open cards?)?$`) }).click();
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

  // A new project starts with an Icebox column for parked work.
  // An empty list has no height, so it is attached rather than visible.
  await expect(page.getByRole('list', { name: 'Icebox tasks' })).toBeAttached();

  // Create two tasks; the only area is preselected. The first never runs.
  for (const title of [OTHER, TASK]) {
    await page.getByRole('button', { name: 'New task' }).click();
    const taskDialog = page.getByRole('dialog', { name: 'New task' });
    await taskDialog.getByLabel('Title').fill(title);
    await taskDialog.getByLabel('Acceptance criteria').fill('src/greeting/hello.txt exists');
    await taskDialog.getByRole('button', { name: 'Create task' }).click();
    await expect(taskDialog).toBeHidden();
  }

  // Reorder with the keyboard, and check that it persisted.
  const ready = page.getByRole('list', { name: 'Ready tasks' });
  await expect(ready.getByRole('listitem')).toHaveCount(2);
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(OTHER);
  const handle = ready.getByRole('button', { name: `Drag ${TASK}` });
  await handle.focus();
  await expect(handle).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(TASK);
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem').nth(0),
  ).toHaveAccessibleName(TASK);

  // Park the other task from its menu and plan it again; parking survives a reload.
  const iceboxList = page.getByRole('list', { name: 'Icebox tasks' });
  await page.getByRole('button', { name: `Actions for ${OTHER}` }).click();
  await page.getByRole('menuitem', { name: 'Move to Icebox' }).click();
  await expect(iceboxList.getByRole('listitem', { name: OTHER })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Icebox tasks' }).getByRole('listitem', { name: OTHER }),
  ).toBeVisible();
  await expectAccessible(page, 'board, parked, dark');
  await page.getByRole('button', { name: `Actions for ${OTHER}` }).click();
  await page.getByRole('menuitem', { name: 'Move to Ready' }).click();
  await expect(
    page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem', { name: OTHER }),
  ).toBeVisible();

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

  // A locked card's reason is reachable from the keyboard, not only on hover.
  await open(page, 'Board');
  const locked = page
    .getByRole('list', { name: 'Done tasks' })
    .getByRole('button', { name: `Can’t drag ${TASK}` });
  await locked.focus();
  await expect(locked).toBeFocused();
  await expect(locked).toHaveAccessibleDescription(
    'Done cards stay where they finished; they can’t be dragged',
  );

  // Settings: add a human column, and a planned section says it is not built yet.
  await open(page, 'Settings');
  await expectAccessible(page, 'settings, general, dark');
  await page.getByRole('link', { name: /Board columns/ }).click();
  await page.getByLabel('New column').fill('Exploring');
  const addColumn = page.getByRole('button', { name: 'Add column' });
  await addColumn.click();
  await expect(
    page.getByRole('table', { name: 'Human columns' }).getByText('Exploring'),
  ).toBeVisible();
  // Axe reads colors, so let the Add column button leave its loading state and fade its label back in.
  await expect(addColumn).toBeEnabled();
  await expect(addColumn.locator('.mantine-Button-inner')).toHaveCSS('opacity', '1');
  await expectAccessible(page, 'settings, board columns, dark');
  await page.getByRole('link', { name: /Accounts/ }).click();
  await expect(page.getByText('Not built yet')).toBeVisible();
  await open(page, 'Board');
  await expect(page.getByRole('list', { name: 'Exploring tasks' })).toBeAttached();

  // Light mode must be just as usable.
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  for (const view of VIEWS) {
    await open(page, view);
    await expectAccessible(page, `${view.toLowerCase()}, light`);
  }
  await open(page, 'Settings');
  await page.getByRole('link', { name: /Board columns/ }).click();
  await expect(page.getByRole('table', { name: 'Human columns' })).toBeVisible();
  await expectAccessible(page, 'settings, board columns, light');
});
