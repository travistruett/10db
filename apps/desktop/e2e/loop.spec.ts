import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_REPO } from './paths';

const TASK = 'Write the greeting';
const OTHER = 'Tidy the readme';
const QUESTION = 'Which greeting?';
const VIEWS = ['Board', 'Factory', 'Inbox', 'Settings'] as const;

async function expectAccessible(page: Page, label: string): Promise<void> {
  // The palette is Selenized exactly, so its contrast is Selenized's, not a WCAG ratio
  // (docs/architecture/decisions/2026-10-28-selenized-exactly.md). Every other rule still runs.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast'])
    .analyze();
  // Each entry names the rule and the offending nodes, so a failure says what to fix.
  const found = results.violations.map(
    (v) => `${label}: ${v.id} (${v.help}) on ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(found).toEqual([]);
}

/** The Board has no page heading, so its link in the sidebar marks it as the open view. */
async function expectView(page: Page, view: (typeof VIEWS)[number]): Promise<void> {
  if (view === 'Board') {
    await expect(page.getByRole('link', { name: 'Board', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    return;
  }
  if (view === 'Settings') {
    // Settings has no page title: it takes over the sidebar, led by a way back.
    await expect(page.getByRole('link', { name: 'Back to Board' })).toBeVisible();
    return;
  }
  await expect(page.getByRole('heading', { name: view, level: 2 })).toBeVisible();
}

async function open(page: Page, view: (typeof VIEWS)[number]): Promise<void> {
  await page
    .getByRole('link', { name: new RegExp(`^(Back to )?${view}( \\d+ open cards?)?$`) })
    .click();
  await expectView(page, view);
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
    await page.getByRole('button', { name: 'New Task' }).click();
    const taskDialog = page.getByRole('dialog', { name: 'New Task' });
    await taskDialog.getByLabel('Title').fill(title);
    await taskDialog.getByLabel('Acceptance criteria').fill('src/greeting/hello.txt exists');
    await taskDialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(taskDialog).toBeHidden();
  }

  // Reorder with the keyboard, and check that it persisted.
  const ready = page.getByRole('list', { name: 'Ready tasks' });
  await expect(ready.getByRole('listitem')).toHaveCount(2);
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(OTHER);
  // The whole card is the drag handle: focus it, pick it up with Space, move, drop with Space.
  const card = ready.getByRole('button', { name: TASK, exact: true });
  await card.focus();
  await expect(card).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(TASK);
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem').nth(0),
  ).toHaveAccessibleName(TASK);

  // Enter ends a keyboard drag without also opening the card's details.
  const reloaded = page
    .getByRole('list', { name: 'Ready tasks' })
    .getByRole('button', { name: TASK, exact: true });
  await reloaded.focus();
  await page.keyboard.press('Space');
  // The card in flight is faded in its list; it is solid again once dropped.
  const slot = page.getByRole('list', { name: 'Ready tasks' }).getByRole('listitem').first();
  await expect(slot).toHaveCSS('opacity', '0.3');
  await page.keyboard.press('Enter');
  await expect(slot).toHaveCSS('opacity', '1');
  await expect(page.getByRole('dialog', { name: 'Task' })).toBeHidden();

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

  // Start through the batch sheet. The project delivers locally, so it starts each ticked task.
  await page.getByRole('button', { name: 'More board actions' }).click();
  await page.getByRole('menuitem', { name: /Start Ready Tasks/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a batch' });
  // Planning the other task put it at the top of Ready, so board order proposes it. Both claim the
  // only area, so the picker leaves this task out and says why.
  await expect(sheet.getByRole('checkbox', { name: OTHER })).toBeChecked();
  await expect(sheet.getByRole('checkbox', { name: TASK })).not.toBeChecked();
  await expect(
    sheet.getByText(`Area greeting is shared with ${OTHER}, picked before it`),
  ).toBeVisible();
  await expect(sheet.getByRole('table', { name: `Steps for ${TASK}` })).toBeVisible();
  // The drawer fades in as it slides; axe would measure contrast mid-fade.
  await expect(sheet).toHaveCSS('opacity', '1');
  await expectAccessible(page, 'batch sheet, dark');
  await sheet.getByRole('checkbox', { name: OTHER }).uncheck();
  await sheet.getByRole('checkbox', { name: TASK }).check();
  await sheet.getByRole('button', { name: 'Start 1 task' }).click();
  await expect(sheet).toBeHidden();

  // The agent's question reaches the inbox; answer it from the keyboard.
  await open(page, 'Inbox');
  await expect(page.getByText(QUESTION)).toBeVisible();
  // The fake's first probe recorded the default account's identity and said so in a card; that card
  // sits above the question until it is dismissed.
  await expect(page.getByText('Claude plan runs as builder@example.com')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Claude plan runs as builder@example.com')).toBeHidden();
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
  await expectView(page, 'Board');
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
    .getByRole('button', { name: TASK, exact: true });
  await locked.focus();
  await expect(locked).toBeFocused();
  await expect(locked).toHaveAccessibleDescription(
    /Done cards stay where they finished; they can’t be dragged$/,
  );

  // Settings: add a human column, a planned section says it is not built yet, and accounts work.
  await open(page, 'Settings');
  await expectAccessible(page, 'settings, general, dark');
  await page.getByRole('link', { name: /Board columns/ }).click();
  await page.getByLabel('New column').fill('Exploring');
  const addColumn = page.getByRole('button', { name: 'Add Column' });
  await addColumn.click();
  await expect(
    page.getByRole('table', { name: 'Board columns' }).getByText('Exploring'),
  ).toBeVisible();
  // Axe reads colors, so let the Add column button leave its loading state and fade its label back in.
  await expect(addColumn).toBeEnabled();
  await expect(addColumn.locator('.mantine-Button-inner')).toHaveCSS('opacity', '1');
  await expectAccessible(page, 'settings, board columns, dark');

  // Accounts: the default account is Ready only because the loop above already ran a task; the first
  // session's probe recorded its identity (the fake adapter reports builder@example.com).
  await page.getByRole('link', { name: /Accounts/ }).click();
  const accounts = page.getByRole('table', { name: 'Accounts' });
  await expect(accounts.getByRole('row', { name: /Claude plan/ }).getByText('Ready')).toBeVisible();
  await expectAccessible(page, 'settings, accounts, dark');

  // A second subscription: its drawer names the config directory to sign in to.
  await page.getByRole('button', { name: 'Add Account' }).click();
  const addAccount = page.getByRole('dialog', { name: 'Add Account' });
  await addAccount.getByRole('textbox', { name: 'Label' }).fill('Company A');
  await addAccount.getByRole('button', { name: 'Create' }).click();
  await expect(addAccount).toBeHidden();
  const drawer = page.getByRole('dialog', { name: 'Company A' });
  await expect(drawer.getByText(/CLAUDE_CONFIG_DIR=.* claude \/login/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Check sign-in' }).click();
  await drawer.getByRole('button', { name: 'Confirm builder@example.com' }).click();
  await expect(drawer).toHaveAccessibleName('Company A · builder@example.com');
  await expect(drawer.getByRole('button', { name: 'Confirm builder@example.com' })).toBeHidden();
  await expectAccessible(page, 'settings, accounts drawer, dark');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  const companyA = accounts.getByRole('row', { name: /Company A/ });
  await expect(companyA).toContainText('builder@example.com');
  await expect(companyA.getByText('Ready')).toBeVisible();

  // An API key account starts without a secret. Saving one would write the login Keychain, so the
  // end to end run stops at "No secret yet".
  await page.getByRole('button', { name: 'Add Account' }).click();
  await addAccount.getByLabel('Kind').click();
  await page.getByRole('option', { name: 'Anthropic API key' }).click();
  await addAccount.getByRole('textbox', { name: 'Label' }).fill('Client B');
  await addAccount.getByRole('textbox', { name: 'Monthly cap (USD)' }).fill('500');
  await addAccount.getByRole('button', { name: 'Create' }).click();
  await expect(addAccount).toBeHidden();
  const clientB = page.getByRole('dialog', { name: /Client B/ });
  await expect(clientB.getByText('No secret yet')).toBeVisible();
  await clientB.getByRole('button', { name: 'Close' }).click();
  await expect(clientB).toBeHidden();
  await expect(
    accounts.getByRole('row', { name: /Client B/ }).getByText('Needs a secret'),
  ).toBeVisible();

  await open(page, 'Board');
  await expect(page.getByRole('list', { name: 'Exploring tasks' })).toBeAttached();

  // Light mode must be just as usable.
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  for (const view of VIEWS) {
    await open(page, view);
    await expectAccessible(page, `${view.toLowerCase()}, light`);
  }
  // The other task is still ready, so the sheet proposes it; close it without starting anything.
  await open(page, 'Board');
  await page.getByRole('button', { name: 'More board actions' }).click();
  await page.getByRole('menuitem', { name: /Start Ready Tasks/ }).click();
  const lightSheet = page.getByRole('dialog', { name: 'Start a batch' });
  await expect(lightSheet.getByRole('checkbox', { name: OTHER })).toBeChecked();
  await expect(lightSheet).toHaveCSS('opacity', '1');
  await expectAccessible(page, 'batch sheet, light');
  await page.keyboard.press('Escape');
  await expect(lightSheet).toBeHidden();
  await open(page, 'Settings');
  await page.getByRole('link', { name: /Board columns/ }).click();
  await expect(page.getByRole('table', { name: 'Board columns' })).toBeVisible();
  await expectAccessible(page, 'settings, board columns, light');
  await page.getByRole('link', { name: /Accounts/ }).click();
  await expect(page.getByRole('table', { name: 'Accounts' })).toBeVisible();
  // Axe must not scan rows that are still loading.
  await expect(
    page
      .getByRole('table', { name: 'Accounts' })
      .getByRole('row', { name: /Client B/ })
      .getByText('Needs a secret'),
  ).toBeVisible();
  await expectAccessible(page, 'settings, accounts, light');
});
