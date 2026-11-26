import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { E2E_DATA, E2E_REPO, E2E_TOKEN } from './paths';

const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
const WAITING_TASK = 'Settle the retry window';
const QUESTION = 'How long should a customer keep access?';
const Projects = z.array(z.object({ id: z.string(), name: z.string() }));

/** The `e2e` project with the greeting area, made by an earlier spec or here: the question belongs to it. */
async function projectId(request: APIRequestContext): Promise<string> {
  const listed = Projects.parse(
    await (await request.get(`${daemonUrl}/projects`, { headers: auth })).json(),
  );
  // Other specs in the same shard add projects of their own; this one seeds into the project with its area.
  const own = listed.find((p) => p.name === 'e2e');
  if (own) return own.id;
  const created = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name: 'e2e',
      repoPath: E2E_REPO,
      gateCommand: 'true',
      areas: [{ name: 'greeting', globs: ['src/greeting/**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'local',
    },
  });
  expect(created.ok()).toBe(true);
  return z.object({ id: z.string() }).parse(await created.json()).id;
}

/** Writes the question card straight into the idle daemon's database; a lane would raise it with ask_human. */
function seedQuestion(project: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-question-card.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId: project,
        title: QUESTION,
        body: 'The spec says retry and notify but not how long the account stays active.',
        options: [
          { label: 'Seven days', description: '' },
          { label: 'The whole billing period', description: '' },
        ],
        // Two signed-in workspaces and Dana, who has a contact in Globex only. Slack is off in this daemon,
        // so they are listed and nothing reaches them.
        workspaces: [
          { teamId: 'T-ACME', teamName: 'Acme' },
          { teamId: 'T-GLOBEX', teamName: 'Globex' },
        ],
        people: [
          {
            handle: 'dana',
            name: 'Dana Ruiz',
            slack: [{ teamId: 'T-GLOBEX', userId: 'U-DANA', sendMode: 'review', dailyLimit: 10 }],
          },
        ],
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
}

/** Writes a task whose run waits on a question already sent to Mark, who has asked a question back; nothing reaches Slack. */
function seedWaiting(project: string, asked: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-waiting-question.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId: project,
        taskTitle: WAITING_TASK,
        area: 'greeting',
        asked: { text: asked },
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
}

// No Slack and no judge run in this daemon (TENDB_SLACK=off, TENDB_JUDGE=off), so the leg that reaches a
// person is covered by the daemon's own tests and the builder's live acceptance. This is the part that is
// the builder's alone: a person who is not in Slack, a route made from a card, and the table that shows it.
test('routes a question to someone outside Slack from its card, and the table shows the route', async ({
  page,
  request,
}) => {
  const project = await projectId(request);
  seedQuestion(project);
  await claudeIsInstalled(page);

  // Settings › Integrations: this daemon runs with Slack and the benchmarks off, and each card says so.
  // The old Sign-ins and project Integrations addresses land on it.
  await page.goto('/settings/sign-ins');
  await expect(page).toHaveURL(/\/settings\/integrations/);
  await expect(page.getByText('Off: 10db was started with TENDB_SLACK=off')).toBeVisible();
  await expect(page.getByText('Off: 10db was started with TENDB_BENCHMARKS=off')).toBeVisible();
  // Settings › Remote Access: this daemon runs the fake Tailscale CLI, so the page shows its checklist; Devices,
  // with nothing paired, says so and offers pairing.
  await page.goto('/settings/remote-access');
  await expect(page.getByText('Share on your tailnet')).toBeVisible();
  await page.goto('/settings/devices');
  await expect(page.getByText('No devices paired')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Pair a Device|Finish Remote Access first/ }),
  ).toBeVisible();
  await page.goto('/settings/integrations');
  // Both workspaces are listed under the Off line, read-only: no menu on a row, no Add Workspace.
  const slackCard = page.getByRole('group', { name: 'Slack', exact: true });
  await expect(slackCard.getByText('Acme', { exact: true })).toBeVisible();
  await expect(slackCard.getByText('Globex', { exact: true })).toBeVisible();
  await expect(slackCard.getByRole('button', { name: /options/ })).toHaveCount(0);
  await expect(slackCard.getByRole('button', { name: 'Add Workspace' })).toHaveCount(0);
  // The project's Slack reads Off; choosing Acme is kept across a reload.
  const projectSlack = slackCard.getByRole('combobox', { name: 'Slack for e2e', exact: true });
  await expect(projectSlack).toHaveValue('Off');
  await projectSlack.click();
  await page.getByRole('option', { name: 'Acme' }).click();
  await expect(projectSlack).toHaveValue('Acme');
  await page.reload();
  await expect(
    page.getByRole('group', { name: 'Slack', exact: true }).getByRole('combobox', {
      name: 'Slack for e2e',
      exact: true,
    }),
  ).toHaveValue('Acme');
  // The project stays on Acme: the question below is routed with it bound.
  await expectAccessible(page, 'integrations, dark');
  await page.goto('/settings/project-integrations');
  await expect(page).toHaveURL(/\/settings\/integrations/);
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();

  // Settings › People: add Priya, who is not in Slack. With Slack off the modal opens on a name.
  await page.goto('/settings/people');
  await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add Person' }).click();
  const person = page.getByRole('dialog', { name: 'Add Person' });
  await expect(person.getByText("10db can't message them.", { exact: false })).toBeVisible();
  await person.getByLabel('Name').fill('Priya Shah');
  await person.getByRole('button', { name: 'Save Person' }).click();
  await expect(person).toBeHidden();
  const priya = page.getByRole('row', { name: /Priya Shah/ });
  await expect(priya).toContainText('Not on Slack');
  await expect(priya).toContainText('You pass it on');
  await expectAccessible(page, 'people, dark');

  // Dana has a contact in Globex only: one chip, and a modal with that one contact that offers Acme.
  const dana = page.getByRole('row', { name: /Dana Ruiz/ });
  await expect(dana).toContainText('Globex');
  await expect(dana).not.toContainText('Acme');
  await page.getByRole('button', { name: 'Edit Dana Ruiz' }).click();
  const danaModal = page.getByRole('dialog', { name: 'Edit Dana Ruiz' });
  await expect(danaModal.getByText('Globex', { exact: true })).toBeVisible();
  await expect(danaModal.getByRole('radio', { name: 'Show Me Each Message First' })).toBeChecked();
  await expect(
    danaModal.getByRole('textbox', { name: 'New questions a day in Globex' }),
  ).toBeVisible();
  await expect(danaModal.getByRole('button', { name: 'Add Acme' })).toBeVisible();
  await expect(danaModal.getByRole('button', { name: 'Add Globex' })).toHaveCount(0);
  await expectAccessible(page, 'person modal with a contact per workspace, dark');
  await danaModal.getByRole('button', { name: 'Cancel' }).click();
  await expect(danaModal).toBeHidden();

  // The question card offers Ask Someone; Priya, Product, on the whole project.
  // Earlier specs leave cards that fill the panel's first page, so the list is narrowed to the question.
  await page.goto(`/inbox?q=${encodeURIComponent(QUESTION)}`);
  // The question is a row in the panel, and its card is the content once the row is selected.
  const questionRow = page.getByRole('option', { name: new RegExp(QUESTION) });
  await expect(questionRow).toBeVisible();
  await questionRow.click();
  await page.getByRole('button', { name: 'Ask Someone', exact: true }).click();
  let ask = page.getByRole('dialog');
  // The project is bound to Acme, where Dana has no contact: she is listed, and the card copies for her.
  await ask.getByRole('combobox', { name: 'Person' }).click();
  await expect(page.getByRole('option', { name: "Dana Ruiz · not in Acme's Slack" })).toBeVisible();
  await page.getByRole('option', { name: /Dana Ruiz/ }).click();
  await ask.getByRole('checkbox', { name: /Always send these kinds/ }).uncheck();
  await ask.getByRole('button', { name: 'Ask Dana Ruiz' }).click();
  await expect(page.getByRole('button', { name: 'Copy for Dana Ruiz' })).toBeVisible();
  await expect(page.getByText("Dana Ruiz isn't in Acme's Slack", { exact: false })).toBeVisible();
  await expectAccessible(page, 'inbox, routed to a person not in the project workspace, dark');

  // Change it to Priya, who is not in Slack at all.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  ask = page.getByRole('dialog');
  await ask.getByRole('combobox', { name: 'Person' }).click();
  await page.getByRole('option', { name: /Priya Shah/ }).click();
  // The card's own kind is ticked already.
  await expect(ask.getByRole('checkbox', { name: 'Product' })).toBeChecked();
  await ask.getByRole('combobox', { name: 'On', exact: true }).click();
  await page.getByRole('option', { name: 'the whole project' }).click();
  await ask.getByRole('button', { name: 'Ask Priya Shah' }).click();

  // The card now offers to copy the message for her, and the builder answers it with her answer.
  await expect(page.getByRole('button', { name: 'Copy for Priya Shah' })).toBeVisible();

  // The daemon remembers whom the card was asked of: after a reload Copy is still there.
  await page.reload();
  const reselect = page.getByRole('option', { name: new RegExp(QUESTION) });
  await expect(reselect).toBeVisible();
  await reselect.click();
  await expect(page.getByRole('button', { name: 'Copy for Priya Shah' })).toBeVisible();
  await expect(page.getByText('Product question → Priya Shah · chosen by you')).toBeVisible();
  await expectAccessible(page, 'inbox, routed to a person not in Slack, dark');
  await page.getByRole('radio', { name: /Seven days/ }).check();
  await page.getByRole('button', { name: 'Send Answer' }).click();
  // Other cards may be open; this one is gone.
  await expect(page.getByRole('option', { name: new RegExp(QUESTION) })).toHaveCount(0);

  // Question Routing shows the route the card wrote.
  await page.goto('/settings/routing-rules');
  await expect(page.getByRole('heading', { name: 'Question Routing', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: /Priya Shah/ });
  await expect(row).toContainText('Project');
  await expect(row).toContainText('Product');
  await expectAccessible(page, 'who answers, dark');
});

test('a question Mark asked back reaches the Inbox, and the Board says the task waits on the builder', async ({
  page,
  request,
}) => {
  seedWaiting(await projectId(request), 'what is this for?');
  await claudeIsInstalled(page);
  await page.goto('/board');
  const card = page.getByTestId('task-card').filter({ hasText: WAITING_TASK });
  // Mark has asked a question back, so the task waits on the builder and says where to answer.
  await expect(card).toContainText('Waiting on you: answer in Inbox');
  await expect(card).toHaveAttribute('data-state-color', 'yellow');
  await expectAccessible(page, 'board, waiting on someone, dark');

  // Mark's question came back to the Inbox: the words are quoted, and with Slack off the reply box is disabled
  // and says why. Answering the card with an option resolves it and it leaves the list.
  await page.goto('/inbox?q=Which%20retry%20window');
  const row = page.getByRole('option', { name: /Which retry window/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText('Mark Ellis asked', { exact: true })).toBeVisible();
  await expect(page.getByText('what is this for?', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Reply To Mark')).toBeDisabled();
  await expect(page.getByText('Slack is off on this daemon', { exact: false })).toBeVisible();
  await page.getByRole('radio', { name: /Seven days/ }).check();
  await page.getByRole('button', { name: 'Send Answer' }).click();
  await expect(page.getByRole('option', { name: /Which retry window/ })).toHaveCount(0);

  // The run is a seeded one with no session behind it; cancel it so later specs see no stray lane.
  const runs = z
    .array(z.object({ id: z.string(), taskTitle: z.string() }))
    .parse(await (await request.get(`${daemonUrl}/workstreams`, { headers: auth })).json());
  const run = runs.find((w) => w.taskTitle === WAITING_TASK);
  expect(run).toBeDefined();
  const cancelled = await request.post(`${daemonUrl}/workstreams/${run?.id ?? ''}/cancel`, {
    headers: auth,
  });
  expect(cancelled.ok()).toBe(true);
});
