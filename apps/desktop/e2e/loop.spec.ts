import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { E2E_DATA, E2E_DIR, E2E_REPO, E2E_TOKEN } from './paths';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';

const Runs = z.array(z.object({ id: z.string(), taskTitle: z.string() }));
const Changes = z.object({ commits: z.array(z.string()) });
const YourWatchpoints = z.array(z.looseObject({ key: z.string(), loudness: z.string() }));
const ProjectEntries = z.object({
  entries: z.array(z.looseObject({ key: z.string(), off: z.literal(true).optional() })),
});
const Batches = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    state: z.string(),
    baseBranch: z.string(),
    gateExitCode: z.number().nullable(),
    gateLogPath: z.string().nullable(),
    worktreePath: z.string().nullable(),
  }),
);

const TASK = 'Write the greeting';
const OTHER = 'Tidy the readme';
const COPY_TASK = 'Add the farewell';
const QUESTION = 'Which greeting?';
type View = 'Board' | 'Factory' | 'Inbox' | 'Knowledge' | 'Settings';

/** The Board draws no title, so its link in the rail marks it as the open view. */
async function expectView(page: Page, view: View): Promise<void> {
  if (view === 'Board') {
    await expect(page.getByRole('link', { name: 'Board', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    return;
  }
  if (view === 'Settings') {
    // Settings lists its sections in the panel beside the rail.
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    return;
  }
  if (view === 'Inbox') {
    // The Inbox's panel head says Inbox; its title names the list it shows.
    await expect(page.getByRole('region', { name: 'Inbox panel' })).toBeVisible();
    return;
  }
  await expect(page.getByRole('heading', { name: view, level: 1 })).toBeVisible();
  // Axe must not scan a list that is still loading.
  if (view === 'Knowledge') await expect(page.getByLabel(/^Loading /)).toHaveCount(0);
}

/** Settings shows one scope at a time; the builder picks it in the panel's switch. */
async function chooseScope(page: Page, scope: 'This Project' | 'All Projects'): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Settings scope' }).getByText(scope).click();
}

async function open(page: Page, view: View): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sections' })
    // A count or the Factory's status dot follows the name.
    .getByRole('link', { name: new RegExp(`^${view}(\\s|$)`) })
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
      // The area covers the eval file too: the run's agent lowers its bar.
      areas: [{ name: 'greeting', globs: ['src/greeting/**', 'evals/**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'local',
    },
  });
  expect(created.ok()).toBe(true);
  const projectId = z.object({ id: z.string() }).parse(await created.json()).id;
  // The builder watches the greeting folder in this project and asks to look at it; the fake agent writes a file there.
  const watched = await request.put(`${daemonUrl}/projects/${projectId}/watchpoints`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: [
      {
        key: 'greetings',
        label: 'Greetings',
        why: 'What users read first.',
        globs: ['src/greeting/**'],
        guidance: 'Check the wording is friendly.',
        loudness: 'ask',
      },
      {
        key: 'evals',
        label: 'Evals',
        why: 'A lowered bar hides a regression.',
        globs: ['**/evals/**'],
        guidance: '',
        loudness: 'show',
      },
    ],
  });
  expect(watched.ok()).toBe(true);
  // The project's evals as an assessment records them: one suite covering the greeting folder (snapshotted as
  // the run starts, and nothing has run it since) and one defined by evals/gate.py, so a run that changes
  // that file is read as an eval change.
  const recorded = await request.put(`${daemonUrl}/projects/${projectId}/evals/manifest`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: {
      suites: [
        {
          key: 'greeting.tone',
          label: 'Greeting tone',
          coveredPaths: ['src/greeting/**'],
          liveCommand: 'make eval-greeting',
        },
        { key: 'gate', definitionPaths: ['evals/gate.py'] },
      ],
      gaps: [],
    },
  });
  expect(recorded.ok()).toBe(true);
  await page.goto('/board');

  // A new project starts with an Icebox column for parked work. While it is empty it is folded to a rail.
  await expect(page.getByRole('group', { name: 'Icebox, collapsed' })).toBeVisible();

  // Create two tasks; the only area is preselected. The first never runs. The second is made through the
  // API so that it carries a Linear link, whose issue the reporter then writes to once the task is done.
  await page.getByRole('button', { name: 'New Task' }).click();
  const taskDialog = page.getByRole('dialog', { name: 'New Task' });
  await taskDialog.getByLabel('Title', { exact: true }).fill(OTHER);
  await expectAccessible(page, 'new task, dark');
  await taskDialog
    .getByLabel('Acceptance Criteria', { exact: true })
    .fill('src/greeting/hello.txt exists');
  await taskDialog.getByRole('button', { name: 'Create Task' }).click();
  await expect(taskDialog).toBeHidden();
  const linked = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: {
      title: TASK,
      acceptanceCriteria: ['src/greeting/hello.txt exists'],
      areas: ['greeting'],
      external: {
        kind: 'linear',
        id: 'AMP-7',
        issueId: 'e2e-linear-issue-1',
        url: 'https://linear.app/ampsio/issue/AMP-7',
      },
    },
  });
  expect(linked.ok()).toBe(true);

  // Reorder with the keyboard, and check that it persisted.
  const ready = page.getByRole('list', { name: 'Ready tasks' });
  await expect(ready.getByRole('listitem')).toHaveCount(2);
  await expect(ready.getByRole('listitem').nth(0)).toHaveAccessibleName(OTHER);
  // The whole card is the drag handle: focus it, pick it up with Space, move, drop with Space.
  const card = ready.getByRole('button', { name: TASK, exact: true });
  await card.focus();
  await expect(card).toBeFocused();
  // The pick-up is handled on the card itself, not by the sensor's timed listener, so it is sent once.
  await page.keyboard.press('Space');
  await expect(ready.getByRole('listitem').nth(1)).toHaveCSS('opacity', '0.3');
  // The drop targets are measured after the pick-up renders; the card is announced over itself once
  // they are.
  await expect(
    page.getByRole('status').filter({ hasText: `${TASK} is over ${TASK}.` }),
  ).toHaveCount(1);
  // dnd-kit's sensor listens for the move and drop keys only from a timer the pick-up starts, so a key
  // sent before the timer fires is lost. Each such key is sent again until its effect shows.
  await expect(async () => {
    await page.keyboard.press('ArrowUp');
    await expect(
      page.getByRole('status').filter({ hasText: `${TASK} is over ${OTHER}.` }),
    ).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  // A drop shows as the card turning solid. Space on a card that has dropped would pick it up again, so
  // the drop is sent again only while the card is still faded.
  const inFlight = ready.getByRole('listitem', { name: TASK, exact: true });
  await expect(async () => {
    await page.keyboard.press('Space');
    await expect(inFlight).toHaveCSS('opacity', '1', { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
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
  // Enter opens the card only when no drag is under way, so an Enter sent again while the card is still
  // faded ends the drag and leaves its details closed.
  await expect(async () => {
    await page.keyboard.press('Enter');
    await expect(slot).toHaveCSS('opacity', '1', { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
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
  const sheet = page.getByRole('dialog', { name: 'Start a Batch' });
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

  // The work went on, committed, passed 10db's gate and is DONE.
  await open(page, 'Board');
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: TASK }),
  ).toBeVisible();
  // The Board carries no acceptance counts; Factory's Metrics holds them. The finished task raised no
  // card, and the e2e daemon runs with the judge off, so nothing is checking and the panel says why.
  await expect(page.getByText(/last 7 days/)).toHaveCount(0);
  await open(page, 'Factory');
  await page.getByRole('radiogroup', { name: 'Factory view' }).getByText('Metrics').click();
  await expect(
    page.getByRole('table', { name: 'Completed runs' }).getByRole('button', { name: TASK }),
  ).toBeVisible();
  await expect(
    page.getByText("Acceptance isn't checking: no account can answer decisions"),
  ).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Factory view' }).getByText('Live').click();
  // Factory shows each project as a row with its bar, whose verdict is the row's name; the finished task is
  // under the project's merged today, and with no goals anywhere the project holds no goal list.
  await open(page, 'Factory');
  const projectRow = page.getByRole('button', { name: /^e2e / });
  await expect(projectRow).toHaveAccessibleName(/1 merged today/);
  if ((await projectRow.getAttribute('aria-expanded')) !== 'true') await projectRow.click();
  const project = page.getByRole('region', { name: /^e2e / });
  await expect(project.getByRole('group', { name: /goals$/ })).toHaveCount(0);
  await project.getByRole('button', { name: /merged today/ }).click();
  await expectAccessible(page, 'factory, projects, dark');
  // A line opens its task's drawer over Factory, and the link keeps it.
  await project
    .getByRole('button', { name: new RegExp(TASK) })
    .first()
    .click();
  const taskDrawer = page.getByRole('dialog', { name: 'Task' });
  await expect(taskDrawer).toBeVisible();
  await expect(page).toHaveURL(/\/factory\?.*task=/);
  // What the build wrote last is on the card under its own phase, apart from the review's verdict.
  const report = taskDrawer.getByTestId('task-report');
  await expect(report.getByText('Implementation Report')).toBeVisible();
  await expect(report.getByText('Wrote src/greeting/hello.txt and committed it.')).toBeVisible();
  // For You is the first section: the watchpoint the run's file hit, with the agent's reason, the reviewer's
  // check and the hunk, kept with the run.
  const forYou = taskDrawer.getByTestId('for-you');
  await expect(forYou.getByText('For You', { exact: true })).toBeVisible();
  // An ask watchpoint's fold starts open.
  await expect(forYou.getByText('Adds the greeting file the gate looks for.')).toBeVisible();
  await expect(forYou.getByText('✓ A plain text file, as the gate expects.')).toBeVisible();
  await expect(forYou.getByText('src/greeting/hello.txt')).toBeVisible();
  await expect(forYou.getByText('added line 1: hello')).toBeAttached();
  // Evals sits beside it: the suite the change touched hasn't run since, with its live command to copy.
  const evals = taskDrawer.getByTestId('eval-coverage');
  await expect(evals.getByText('Greeting tone')).toBeVisible();
  await expect(evals.getByText('not run', { exact: true })).toBeVisible();
  await expect(evals.getByText('Changes src/greeting/hello.txt')).toBeVisible();
  await expect(evals.getByText('make eval-greeting')).toBeVisible();
  // The run lowered the eval's bar, and the Evals watchpoint says so, naming the line it read.
  await forYou.getByRole('button', { name: /Evals/ }).click();
  await expect(forYou.getByText('bar lowered (GATE = dict(minimum_rate=0.5))')).toBeVisible();
  // A Board task nobody watches is never asked anything: the agent's question was answered at once. The
  // task is done, so the drawer lists it and the Inbox raised no card for it.
  await expect(
    taskDrawer.getByRole('list', { name: 'Questions It Would Have Asked' }).getByText(QUESTION),
  ).toBeVisible();
  await taskDrawer.getByRole('tab', { name: /Reviews/ }).click();
  await expect(taskDrawer.getByTestId('review-phase').first()).toHaveText('Review');

  // The task is linked to a Linear issue, so the reporter writes to it. Its updates are due 30 s after the
  // events, on the daemon's real clock; the Linear tab lists them and settles with none left waiting.
  await taskDrawer.getByRole('tab', { name: 'Linear' }).click();
  const updates = taskDrawer.getByRole('list', { name: 'Linear updates' });
  await expect(updates.getByRole('listitem', { name: 'Run Ended' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(updates.getByText('Waiting', { exact: true })).toHaveCount(0, { timeout: 90_000 });
  await expect(updates.getByText('Failed', { exact: true })).toHaveCount(0);
  await expect(
    updates.getByRole('listitem', { name: 'Run Ended' }).getByText('Recorded'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Settings › Integrations: Linear is on for the project; turning it off leaves the switch off.
  await page.goto('/settings/integrations');
  const reportSwitch = page.getByRole('switch', {
    name: 'Linear for e2e',
    exact: true,
  });
  await expect(reportSwitch).toBeChecked();
  // A switch with no visible label has its track over the input: click the label that holds both, as a person does.
  await reportSwitch.locator('xpath=..').click();
  await expect(reportSwitch).not.toBeChecked();

  // Settings › Watchpoints: All Projects holds your list; a project page follows it, sets one here or turns it off
  // here, and never writes your list.
  const watchAuth = { Authorization: `Bearer ${E2E_TOKEN}` };
  const readYours = async () =>
    YourWatchpoints.parse(
      await (
        await request.get(`${daemonUrl}/settings/watchpoints`, {
          headers: watchAuth,
          maxRetries: 2,
        })
      ).json(),
    );
  const readHere = async () =>
    ProjectEntries.parse(
      await (
        await request.get(`${daemonUrl}/projects/${projectId}/watchpoints`, {
          headers: watchAuth,
          maxRetries: 2,
        })
      ).json(),
    ).entries;
  const yoursBefore = await readYours();
  await page.goto('/settings/all-watchpoints');
  await page
    .getByRole('radiogroup', { name: 'When Prompts matches' })
    .getByText('Ask', { exact: true })
    .click();
  await expect
    .poll(async () => (await readYours()).find((w) => w.key === 'prompts')?.loudness)
    .toBe('ask');
  await chooseScope(page, 'This Project');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Watchpoints', exact: true })
    .click();
  const promptsHere = page.getByRole('radiogroup', { name: 'When Prompts matches' });
  // Default names what All Projects has now.
  await expect(promptsHere.getByText('Default · Ask', { exact: true })).toBeVisible();
  await expectAccessible(page, 'project watchpoints, dark');
  await promptsHere.getByText('Off', { exact: true }).click();
  await expect
    .poll(async () => (await readHere()).find((e) => e.key === 'prompts'))
    .toEqual({ key: 'prompts', off: true });
  await promptsHere.getByText('Default · Ask', { exact: true }).click();
  await expect.poll(async () => (await readHere()).some((e) => e.key === 'prompts')).toBe(false);
  // The project page changed only the project's entries: your list is as All Projects left it.
  expect((await readYours()).find((w) => w.key === 'prompts')?.loudness).toBe('ask');
  expect((await readHere()).map((e) => e.key)).toEqual(['greetings', 'evals']);
  // Later specs run under your list, so it goes back to how it was.
  const restored = await request.put(`${daemonUrl}/settings/watchpoints`, {
    headers: watchAuth,
    data: yoursBefore,
  });
  expect(restored.ok()).toBe(true);
  // The project's settings list Board Columns, which the rail's Board link would also match.
  await page.goto('/board');
  await expectView(page, 'Board');
  // The Board's card for the finished task carries the same marker.
  await expect(
    page.getByTestId('task-card').filter({ hasText: TASK }).getByTestId('eval-marker'),
  ).toHaveText('Greeting tone · not run');

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
  await decisions.getByRole('button', { name: 'Open Which greeting file? → hello.txt' }).click();
  const provenance = page.getByRole('dialog', { name: 'Decision' });
  await expect(provenance.getByText('The gate looks for it.')).toBeVisible();
  await expect(provenance.getByText('Claude Code')).toBeVisible();
  await expect(provenance.getByText('keep it hello.txt')).toBeVisible();
  await expectAccessible(page, 'knowledge, provenance, dark');
  await page.keyboard.press('Escape');
  await expect(provenance).toBeHidden();

  // The MCP commit really landed: the finished run's changes hold the one commit it made.
  const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
  const runs = await request.get(`${daemonUrl}/workstreams?active=false`, {
    headers: auth,
    maxRetries: 2,
  });
  const run = Runs.parse(await runs.json()).find((w) => w.taskTitle === TASK);
  expect(run).toBeDefined();
  const changes = await request.get(`${daemonUrl}/workstreams/${run?.id ?? ''}/changes`, {
    headers: auth,
    maxRetries: 2,
  });
  expect(changes.ok()).toBe(true);
  expect(Changes.parse(await changes.json()).commits).toHaveLength(1);

  // A lane's browser_screenshot would leave one picture and its evidence on the task; the e2e daemon runs
  // no browser, so they are seeded. The drawer shows the picture under its note, with the page it came from.
  const LANE_NOTE = 'The greeting page after saving';
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-lane-screen.ts',
      E2E_DATA,
      JSON.stringify({
        workstreamId: run?.id,
        url: 'http://127.0.0.1:4455/greeting',
        title: 'Greeting',
        note: LANE_NOTE,
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
  await page.goto('/board');
  await expectView(page, 'Board');
  await page
    .getByRole('list', { name: 'Done tasks' })
    .getByRole('listitem', { name: TASK })
    .click();
  const laneGroup = page.getByRole('dialog', { name: 'Task' }).getByRole('group', {
    name: 'Lane Screenshots',
  });
  await expect(laneGroup.getByText(LANE_NOTE)).toBeVisible();
  await expect(laneGroup.getByText('http://127.0.0.1:4455/greeting')).toBeVisible();
  await expect(laneGroup.getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');

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
  // The ask watchpoint left one Look card for the task, written as the run moved on. It shows the same hunk and
  // notes as For You, and Looks right closes it.
  const lookTitle = page.getByText(`Look at these changes: ${TASK}`);
  await lookTitle.first().click();
  // The detail pane beside the list is the Look card itself: its folds, a way back to the task and a note box.
  await expect(page.getByRole('button', { name: 'Open the task' })).toBeVisible();
  await page.getByRole('button', { name: 'Send back with a note' }).click();
  await expect(page.getByRole('textbox', { name: 'What Needs to Change' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Adds the greeting file the gate looks for.')).toBeVisible();
  await expect(page.getByText('added line 1: hello')).toBeAttached();
  await page.getByRole('button', { name: 'Looks right' }).click();
  await expect(lookTitle).toHaveCount(0);

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

  // A separate copy: Settings turns Separate Copies on with a teardown command and a passing gate, the task is
  // placed in a copy, runs on the fake adapter, and lands on the base only after review and a gate on its commit.
  await open(page, 'Settings');
  await chooseScope(page, 'This Project');
  await page
    .getByRole('textbox', { name: 'Gate Command' })
    .fill('test -f src/greeting/farewell.txt');
  await page.getByRole('switch', { name: 'Separate Copies' }).check({ force: true });
  await page
    .getByRole('textbox', { name: 'Teardown Command' })
    .fill('echo torn-down-$TENDB_COPY_ID');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const copyTask = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: {
      title: COPY_TASK,
      acceptanceCriteria: ['src/greeting/farewell.txt exists'],
      areas: ['greeting'],
    },
  });
  expect(copyTask.ok()).toBe(true);
  await page.goto('/board');
  await expectView(page, 'Board');
  await page.getByRole('button', { name: COPY_TASK, exact: true }).click();
  await page.getByRole('dialog', { name: 'Task' }).getByRole('tab', { name: 'Edit' }).click();
  await page
    .getByRole('radiogroup', { name: `Where ${COPY_TASK} runs` })
    .getByText('Separate copy')
    .click();
  await expect(page.getByRole('radio', { name: 'Separate copy' })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More board actions' }).click();
  await page.getByRole('menuitem', { name: /Start Ready Tasks/ }).click();
  const copySheet = page.getByRole('dialog', { name: 'Start a Batch' });
  await copySheet.getByRole('checkbox', { name: OTHER }).uncheck();
  await copySheet.getByRole('checkbox', { name: COPY_TASK }).check();
  await copySheet.getByRole('button', { name: 'Start 1 task' }).click();
  await expect(copySheet).toBeHidden();

  const authHeader = { Authorization: `Bearer ${E2E_TOKEN}` };
  const copyBatch = async () => {
    const response = await request.get(`${daemonUrl}/projects/${projectId}/batches`, {
      headers: authHeader,
      maxRetries: 2,
    });
    return Batches.parse(await response.json()).find((b) => b.title.includes(COPY_TASK));
  };
  // SHIPPED is the landing's own write, made after the gate passed on the exact commit.
  await expect.poll(async () => (await copyBatch())?.state, { timeout: 180_000 }).toBe('SHIPPED');
  const landed = await copyBatch();
  expect(landed?.gateExitCode).toBe(0);
  const gateLog = landed?.gateLogPath ?? '';
  expect(existsSync(gateLog)).toBe(true);
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: E2E_REPO, env: gitEnv, encoding: 'utf8' }).trim();
  const base = landed?.baseBranch ?? '';
  expect(git('log', base, '--format=%s')).toContain('Add the farewell');
  // The base moved only after the gate's evidence was written, and the builder's folder shows the work.
  const movedAt = Number(
    /@\{(\d+)\}/.exec(git('reflog', 'show', base, '--date=unix', '--format=%gd', '-n', '1'))?.[1],
  );
  expect(Math.floor(statSync(gateLog).mtimeMs / 1000)).toBeLessThanOrEqual(movedAt);
  expect(readFileSync(resolve(E2E_REPO, 'src/greeting/farewell.txt'), 'utf8')).toBe('goodbye\n');
  expect(git('status', '--porcelain')).toBe('');
  // Retiring runs the pinned teardown, then removes the copy's worktree.
  const tornDown = (): string | undefined => {
    const dir = resolve(E2E_DATA, 'logs', 'teardown');
    if (!existsSync(dir)) return undefined;
    const log = readdirSync(dir).find((f) => f.startsWith(`batch-${landed?.id ?? ''}-`));
    return log === undefined ? undefined : readFileSync(resolve(dir, log), 'utf8');
  };
  await expect.poll(tornDown, { timeout: 60_000 }).toMatch(/torn-down-[0-9a-f]{12}/);
  await expect.poll(async () => (await copyBatch())?.worktreePath, { timeout: 60_000 }).toBeNull();
  expect(git('worktree', 'list', '--porcelain')).not.toContain(landed?.id ?? 'no-batch');
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: COPY_TASK }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(E2E_DIR, 'copy-landed.png') });

  // Settings: add a human column, and accounts work.
  await open(page, 'Settings');
  await expectAccessible(page, 'settings, overview, dark');
  await chooseScope(page, 'This Project');
  await page.getByRole('link', { name: /Board Columns/ }).click();
  await page.getByLabel('New Column').fill('Exploring');
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
  await chooseScope(page, 'All Projects');
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
  await drawer.getByRole('button', { name: 'Sign In from Terminal Instead' }).click();
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
  // end to end run stops at "No Secret Yet".
  await page.getByRole('button', { name: 'Add Account' }).click();
  await addAccount.getByLabel('Kind').click();
  await page.getByRole('option', { name: 'Anthropic API key' }).click();
  await addAccount.getByRole('textbox', { name: 'Label' }).fill('Client B');
  await addAccount.getByRole('textbox', { name: 'Monthly Cap (USD)' }).fill('500');
  await addAccount.getByRole('button', { name: 'Create' }).click();
  await expect(addAccount).toBeHidden();
  const clientB = page.getByRole('dialog', { name: /Client B/ });
  await expect(clientB.getByText('No Secret Yet')).toBeVisible();
  await clientB.getByRole('button', { name: 'Close' }).click();
  await expect(clientB).toBeHidden();
  await expect(
    accounts.getByRole('row', { name: /Client B/ }).getByText('Needs a Secret'),
  ).toBeVisible();

  // An OpenRouter account runs Codex, so a project's Billing picker offers it. Saving its key would write
  // the login Keychain, so the key's request is dropped: the account exists, and says its key wasn't saved.
  await page.route(/\/accounts\/[^/]+\/secret$/, (route) => route.abort());
  await page.getByRole('button', { name: 'Add Account' }).click();
  await addAccount.getByLabel('Kind').click();
  await page.getByRole('option', { name: 'OpenRouter Key' }).click();
  await addAccount.getByRole('textbox', { name: 'Label' }).fill('Router C');
  await addAccount.getByLabel('OpenRouter Key').fill('not-a-key');
  await addAccount.getByRole('button', { name: 'Create' }).click();
  await expect(addAccount.getByRole('alert')).toContainText("key wasn't saved");
  await addAccount.getByRole('button', { name: 'Open Account' }).click();
  await expect(addAccount).toBeHidden();
  const routerC = page.getByRole('dialog', { name: /Router C/ });
  await expect(routerC.getByText('No Secret Yet')).toBeVisible();
  await routerC.getByRole('button', { name: 'Close' }).click();
  await expect(accounts.getByRole('row', { name: /Router C/ })).toContainText('Runs Codex');
  await page.unroute(/\/accounts\/[^/]+\/secret$/);
  await chooseScope(page, 'This Project');
  await page.getByRole('link', { name: /Billing/ }).click();
  await page.getByRole('combobox', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('option', { name: /Router C/ })).toBeEnabled();
  await page.keyboard.press('Escape');
  await chooseScope(page, 'All Projects');

  await open(page, 'Board');
  // The new column is empty, so the Board folds it to a rail.
  await expect(page.getByRole('group', { name: 'Exploring, collapsed' })).toBeVisible();
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
    .getByRole('button', { name: /^Open / })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Principle' });
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
  await retire.getByRole('radio', { name: 'It No Longer Applies' }).check();
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
  await expect(page.getByRole('heading', { name: 'Knowledge', level: 1 })).toBeVisible();
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
