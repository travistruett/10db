import { expect, test, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { E2E_REPO, E2E_TOKEN } from './paths';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';

const Runs = z.array(z.object({ id: z.string(), taskTitle: z.string() }));
const Changes = z.object({ commits: z.array(z.string()) });

const TASK = 'Write the greeting';
const OTHER = 'Tidy the readme';
const QUESTION = 'Which greeting?';
const VIEWS = ['Board', 'Factory', 'Inbox', 'Knowledge', 'Settings'] as const;

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
  // Axe must not scan a list that is still loading.
  if (view === 'Knowledge') await expect(page.getByLabel(/^Loading /)).toHaveCount(0);
}

/** Settings shows one scope at a time; the builder picks it in the sidebar's switch. */
async function chooseScope(page: Page, scope: 'This project' | 'All projects'): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Settings scope' }).getByText(scope).click();
}

async function open(page: Page, view: (typeof VIEWS)[number]): Promise<void> {
  await page
    .getByRole('link', { name: new RegExp(`^(Back to )?${view}( \\d+ open cards?)?$`) })
    .click();
  await expectView(page, view);
}

/**
 * Visible with none of its text clipped; a line clamp leaves the rest in the DOM, out of sight.
 * The pixel of slack allows for rounding, far less than a clipped line.
 */
async function expectFullyShown(text: Locator): Promise<void> {
  await expect(text).toBeVisible();
  const clipped = await text.evaluate(
    (element) =>
      element.scrollHeight > element.clientHeight + 1 ||
      element.scrollWidth > element.clientWidth + 1,
  );
  expect(clipped).toBe(false);
}

/**
 * Opens a row's Actions menu and chooses an item. Opening a menu shows one menu: an earlier row's menu
 * that is still in the page, or a second one for the same row, fails here at once, naming what is
 * there, instead of as a strict-mode error on whichever item the test happens to look for next.
 */
async function chooseAction(page: Page, actions: Locator, item: string): Promise<void> {
  await actions.click();
  const menuitem = page.getByRole('menuitem', { name: item });
  await expect(menuitem).toBeVisible();
  // Counted once, not retried: a menu that is still leaving the page must fail this, not pass it late.
  const menus = await page.getByRole('menu').count();
  const items = await page.getByRole('menuitem', { name: item }).count();
  expect({ menus, [item]: items }).toEqual({ menus: 1, [item]: 1 });
  await menuitem.click();
}

test.describe.configure({ mode: 'serial' });

test('runs a task from the UI to verified done, and a reload loses nothing', async ({
  page,
  request,
}) => {
  // The window opens on the first run while there is no project (first-run.spec.ts covers it), so
  // the project on the disposable repo is created through the API before the page loads.
  const created = await request.post(`${daemonUrl}/projects`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: {
      name: 'e2e',
      repoPath: E2E_REPO,
      gateCommand:
        "test -f src/greeting/hello.txt && git diff --quiet HEAD && git log -1 --format=%s | grep -qx 'Add the greeting'",
      areas: [{ name: 'greeting', globs: ['src/greeting/**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'local',
    },
  });
  expect(created.ok()).toBe(true);
  const projectId = z.object({ id: z.string() }).parse(await created.json()).id;
  await page.goto('/board');

  // A new project starts with an Icebox column for parked work. While it is empty it is folded to a rail.
  await expect(page.getByRole('group', { name: 'Icebox, collapsed' })).toBeVisible();

  // Create two tasks; the only area is preselected. The first never runs.
  for (const title of [OTHER, TASK]) {
    await page.getByRole('button', { name: 'New Task' }).click();
    const taskDialog = page.getByRole('dialog', { name: 'New Task' });
    await taskDialog.getByLabel('Title').fill(title);
    if (title === OTHER) await expectAccessible(page, 'new task, dark');
    await taskDialog
      .getByLabel('Acceptance criteria', { exact: true })
      .fill('src/greeting/hello.txt exists');
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
  // The fake's first probe recorded the default account's identity and said so in a card. That card
  // offers Record again, so it is a question the daemon acts on and has no Dismiss; it sits above
  // the question and is the open row, so the question's row is opened by selecting it.
  await expect(page.getByText('Claude plan runs as builder@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(QUESTION) }).click();
  await expect(page.getByRole('radio', { name: /Howdy/ })).toBeVisible();
  await expectAccessible(page, 'inbox, question, dark');
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).click();
  await page.keyboard.press('2');
  await expect(page.getByRole('radio', { name: /Howdy/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page.getByText(QUESTION)).toBeHidden();

  // The work resumes, commits, passes 10db's gate and is DONE.
  await open(page, 'Board');
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: TASK }),
  ).toBeVisible();
  // Finished work with no goal is not Factory's: it shows the guide and nothing under Not in a goal.
  await open(page, 'Factory');
  await expect(page.getByText(/^Goals are outcomes 10db pursues/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Not in a goal/ })).toHaveCount(0);
  await expectAccessible(page, 'factory, no goals, dark');

  // Knowledge: a decision written through the API (as Claude Code would) appears in the open view
  // without a reload, with where it came from.
  await open(page, 'Knowledge');
  await page.getByRole('tab', { name: 'Decisions' }).click();
  const written = await request.post(`${daemonUrl}/projects/${projectId}/decisions`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: {
      question: 'Which greeting file?',
      choice: 'hello.txt',
      rationale: 'The gate looks for it.',
      source: { via: 'claude_code', quote: 'keep it hello.txt' },
    },
  });
  expect(written.ok()).toBe(true);
  const decisions = page.getByRole('table', { name: 'Decisions' });
  await expect(decisions.getByText('hello.txt')).toBeVisible();
  await expectAccessible(page, 'knowledge, decisions, dark');
  await decisions.getByRole('button', { name: /^Where .* came from$/ }).click();
  const provenance = page.getByRole('dialog', { name: 'Where it came from' });
  await expect(provenance.getByText('Claude Code')).toBeVisible();
  await expect(provenance.getByText('keep it hello.txt')).toBeVisible();
  await expectAccessible(page, 'knowledge, provenance, dark');
  await page.keyboard.press('Escape');
  await expect(provenance).toBeHidden();

  // The MCP commit really landed: the finished run's changes hold the one commit it made.
  const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
  const runs = await request.get(`${daemonUrl}/workstreams?active=false`, { headers: auth });
  const run = Runs.parse(await runs.json()).find((w) => w.taskTitle === TASK);
  expect(run).toBeDefined();
  const changes = await request.get(`${daemonUrl}/workstreams/${run?.id ?? ''}/changes`, {
    headers: auth,
  });
  expect(changes.ok()).toBe(true);
  expect(Changes.parse(await changes.json()).commits).toHaveLength(1);

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
  // A passing gate raises no card: the only answer it could offer was one that closed it.
  await expect(page.getByText(`Review: ${TASK}`)).toHaveCount(0);
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

  // Settings: add a human column, and accounts work.
  await open(page, 'Settings');
  await expectAccessible(page, 'settings, overview, dark');
  await chooseScope(page, 'This project');
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
  await chooseScope(page, 'All projects');
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
  await drawer.getByRole('button', { name: 'Sign in from Terminal instead' }).click();
  await expect(drawer.getByText(/CLAUDE_CONFIG_DIR=.* claude \/login/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Check sign-in' }).click();
  await drawer.getByRole('button', { name: 'Confirm' }).click();
  await expect(drawer).toHaveAccessibleName('Company A · builder@example.com');
  await expect(drawer.getByRole('button', { name: 'Confirm' })).toBeHidden();
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
  // The new column is empty, so the Board folds it to a rail.
  await expect(page.getByRole('group', { name: 'Exploring, collapsed' })).toBeVisible();

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
  await chooseScope(page, 'This project');
  await page.getByRole('link', { name: /Board columns/ }).click();
  await expect(page.getByRole('table', { name: 'Board columns' })).toBeVisible();
  await expectAccessible(page, 'settings, board columns, light');
  await chooseScope(page, 'All projects');
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

/** Shows a Knowledge list's shelf, chosen in its first column's filter. */
async function showShelf(page: Page, column: string, shelf: 'Current' | 'Past'): Promise<void> {
  await page.getByRole('button', { name: `Filter ${column}` }).click();
  // The segment's radio is hidden under its label, which is what a click lands on.
  await page.locator('label', { hasText: new RegExp(`^${shelf}$`) }).click();
  const pastNote = page.getByText(/^Showing past /);
  await (shelf === 'Past' ? expect(pastNote).toBeVisible() : expect(pastNote).toBeHidden());
  // Past adds the State column, which redraws the headers and closes the filter; Current leaves it open.
  if ((await page.getByRole('radio', { name: shelf, exact: true }).count()) > 0)
    await page.keyboard.press('Escape');
}

test('records, edits, retires and withdraws knowledge, and a reload loses nothing', async ({
  page,
}) => {
  // The loop test left the `e2e` project and one decision in it.
  await page.goto('/board');
  await open(page, 'Knowledge');
  await expectAccessible(page, 'knowledge, principles, dark');

  // A rule for the project, written by the builder, then edited: the old text moves to Past.
  await page.getByRole('button', { name: 'New Principle' }).click();
  const newPrinciple = page.getByRole('dialog', { name: 'New Principle' });
  await newPrinciple.getByLabel('Statement').fill('Never sleep in tests');
  await newPrinciple.getByRole('radio', { name: /^Rule/ }).click();
  await expectAccessible(page, 'knowledge, new principle, dark');
  await newPrinciple.getByRole('button', { name: 'Save' }).click();
  await expect(newPrinciple).toBeHidden();
  const principles = page.getByRole('table', { name: 'Principles' });
  await expect(principles.getByText('Never sleep in tests')).toBeVisible();

  await chooseAction(
    page,
    principles.getByRole('button', { name: 'Actions for "Never sleep in tests"' }),
    'Edit',
  );
  const editPrinciple = page.getByRole('dialog', { name: 'Edit Principle' });
  await editPrinciple.getByLabel('Statement').fill('Tests never sleep');
  await editPrinciple.getByRole('button', { name: 'Save' }).click();
  await expect(editPrinciple).toBeHidden();
  await expect(principles.getByText('Tests never sleep')).toBeVisible();
  await expect(principles.getByText('Never sleep in tests')).toBeHidden();

  // A new principle on a current one's topic names what it replaces before anything is written.
  await page.getByRole('button', { name: 'New Principle' }).click();
  await newPrinciple.getByLabel('Statement').fill('Never sleep in tests');
  await newPrinciple.getByRole('radio', { name: /^Rule/ }).click();
  await newPrinciple.getByRole('button', { name: 'Save' }).click();
  await expectFullyShown(newPrinciple.getByText(/“Tests never sleep” has the same topic/));
  await expectAccessible(page, 'knowledge, replaces, dark');
  await newPrinciple.getByRole('button', { name: 'Cancel' }).click();
  await expect(newPrinciple).toBeHidden();

  await showShelf(page, 'Principle', 'Past');
  await expect(principles.getByText('Superseded')).toBeVisible();
  await expect(principles.getByText('Never sleep in tests')).toBeVisible();
  await expectAccessible(page, 'knowledge, past principles, dark');

  // Each version's provenance links to the other.
  await principles
    .getByRole('row', { name: /Never sleep in tests/ })
    .getByRole('button', { name: /^Where .* came from$/ })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Where it came from' });
  await expect(drawer.getByText('The app')).toBeVisible();
  await drawer.getByRole('button', { name: 'Replaced by: Tests never sleep' }).click();
  await expect(
    drawer.getByRole('button', { name: 'Replaced: Never sleep in tests' }),
  ).toBeVisible();
  await expectAccessible(page, 'knowledge, provenance, dark');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // The older version cannot be removed: its dialog names the newest one.
  await chooseAction(
    page,
    principles.getByRole('button', { name: 'Actions for "Never sleep in tests"' }),
    'Remove',
  );
  const older = page.getByRole('dialog', { name: 'Remove Principle' });
  await expect(older.getByText(/has a newer version/)).toBeVisible();
  await expect(older.getByText('Tests never sleep')).toBeVisible();
  await older.getByRole('button', { name: 'Cancel' }).click();
  await expect(older).toBeHidden();

  // Retire the current one: it no longer applies, and says why.
  await showShelf(page, 'Principle', 'Current');
  await chooseAction(
    page,
    principles.getByRole('button', { name: 'Actions for "Tests never sleep"' }),
    'Remove',
  );
  const retire = page.getByRole('dialog', { name: 'Remove Principle' });
  await retire.getByRole('radio', { name: 'It no longer applies' }).check();
  await retire.getByRole('button', { name: 'Remove' }).click();
  await expect(retire.getByText('Say why.')).toBeVisible();
  await retire.getByLabel('Reason').fill('Fake timers make waiting free');
  await retire.getByRole('button', { name: 'Remove' }).click();
  await expect(retire).toBeHidden();
  await expect(principles.getByText('Tests never sleep')).toBeHidden();

  // A decision at the project, edited, then the edit withdrawn: the first answer is current again.
  await page.getByRole('tab', { name: 'Decisions' }).click();
  await page.getByRole('button', { name: 'New Decision' }).click();
  const record = page.getByRole('dialog', { name: 'New Decision' });
  await record.getByLabel('Question').fill('Which greeting style?');
  await record.getByLabel('Choice').fill('Howdy');
  await record.getByLabel('Rationale').fill('Friendly');
  await record.getByRole('button', { name: 'Record' }).click();
  await expect(record).toBeHidden();
  const decisions = page.getByRole('table', { name: 'Decisions' });
  await expect(decisions.getByText('Howdy')).toBeVisible();

  await chooseAction(
    page,
    decisions.getByRole('button', { name: 'Actions for "Which greeting style?"' }),
    'Edit',
  );
  const edit = page.getByRole('dialog', { name: 'Edit Decision' });
  await edit.getByLabel('Choice').fill('Hello');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(decisions.getByText('Hello', { exact: true })).toBeVisible();
  await expect(decisions.getByText('Howdy')).toBeHidden();

  await chooseAction(
    page,
    decisions.getByRole('button', { name: 'Actions for "Which greeting style?"' }),
    'Remove',
  );
  const withdraw = page.getByRole('dialog', { name: 'Remove Decision' });
  await expect(
    withdraw.getByText(/“Which greeting style\? → Howdy” becomes current again/),
  ).toBeVisible();
  await withdraw.getByLabel('Reason').fill('Hello is too formal');
  await withdraw.getByRole('button', { name: 'Remove' }).click();
  await expect(withdraw).toBeHidden();
  await expect(decisions.getByText('Howdy')).toBeVisible();
  await expect(decisions.getByText('Hello', { exact: true })).toBeHidden();

  // Reopening the window loses nothing: every record, its state and its history.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Knowledge', level: 2 })).toBeVisible();
  const reloadedPrinciples = page.getByRole('table', { name: 'Principles' });
  await showShelf(page, 'Principle', 'Past');
  await expect(
    reloadedPrinciples.getByRole('row', { name: /Tests never sleep/ }).getByText('Retired'),
  ).toBeVisible();
  await expect(
    reloadedPrinciples.getByRole('row', { name: /Never sleep in tests/ }).getByText('Superseded'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Decisions' }).click();
  const reloadedDecisions = page.getByRole('table', { name: 'Decisions' });
  await expect(reloadedDecisions.getByText('Howdy')).toBeVisible();
  await showShelf(page, 'Decision', 'Past');
  await expect(
    reloadedDecisions.getByRole('row', { name: /Hello/ }).getByText('Withdrawn'),
  ).toBeVisible();
});
