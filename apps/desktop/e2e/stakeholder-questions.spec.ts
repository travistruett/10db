import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { E2E_DATA, E2E_REPO, E2E_TOKEN } from './paths';

const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
const WAITING_TASK = 'Settle the retry window';
const QUESTION = 'How long should a customer keep access?';
const Projects = z.array(z.object({ id: z.string() }));

/** The project the earlier specs left, or a new one: the question belongs to it. */
async function projectId(request: APIRequestContext): Promise<string> {
  const listed = Projects.parse(
    await (await request.get(`${daemonUrl}/projects`, { headers: auth })).json(),
  );
  const first = listed[0];
  if (first) return first.id;
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
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
}

/** Writes a task whose run waits on a question already sent to Mark; nothing reaches Slack. */
function seedWaiting(project: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-waiting-question.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({ projectId: project, taskTitle: WAITING_TASK, area: 'greeting' }),
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

  // Settings › People: add Priya, who is not in Slack.
  await page.goto('/settings/people');
  await expect(page.getByRole('heading', { name: 'People', level: 3 })).toBeVisible();
  await page.getByRole('button', { name: 'Add Person' }).click();
  const person = page.getByRole('dialog', { name: 'Add Person' });
  await person.getByRole('radio', { name: 'Someone not in Slack' }).check();
  await person.getByLabel('Name').fill('Priya Shah');
  await person.getByRole('button', { name: 'Save Person' }).click();
  await expect(person).toBeHidden();
  await expect(page.getByRole('row', { name: /Priya Shah/ })).toContainText('not in Slack');
  await expectAccessible(page, 'people, dark');

  // The question card offers Ask Someone…; Priya, Product, on the whole project.
  await page.goto('/inbox');
  await expect(page.getByText(QUESTION)).toBeVisible();
  // The first row opens by itself; with 10db's own cards above it, it is a row to select.
  const questionRow = page.getByRole('button', { name: new RegExp(QUESTION) });
  if ((await questionRow.count()) > 0) await questionRow.click();
  await page.getByRole('button', { name: 'Ask Someone…' }).click();
  const ask = page.getByRole('dialog');
  await ask.getByRole('combobox', { name: 'Person' }).click();
  await page.getByRole('option', { name: /Priya Shah/ }).click();
  // The card's own kind is ticked already.
  await expect(ask.getByRole('checkbox', { name: 'Product' })).toBeChecked();
  await ask.getByRole('combobox', { name: 'On', exact: true }).click();
  await page.getByRole('option', { name: 'the whole project' }).click();
  await ask.getByRole('button', { name: 'Ask Priya Shah' }).click();

  // The card now offers to copy the message for her, and the builder answers it with her answer.
  await expect(page.getByRole('button', { name: 'Copy for Priya Shah' })).toBeVisible();
  await expect(page.getByText('Product question → Priya Shah · chosen by you')).toBeVisible();
  await expectAccessible(page, 'inbox, routed to a person not in Slack, dark');
  await page.getByRole('radio', { name: /Seven days/ }).check();
  await page.getByRole('button', { name: 'Send answer' }).click();
  // Other cards may be open; this one is gone, with the message copied for Priya.
  await expect(page.getByText(QUESTION)).toHaveCount(0);

  // Who Answers shows the route the card wrote.
  await page.goto('/settings/routing-rules');
  await expect(page.getByRole('heading', { name: 'Who Answers', level: 3 })).toBeVisible();
  const row = page.getByRole('row', { name: /Priya Shah/ });
  await expect(row).toContainText('Project');
  await expect(row).toContainText('Product');
  await expectAccessible(page, 'who answers, dark');
});

test('the Board says a task waits on Mark in Slack, without a yellow border', async ({
  page,
  request,
}) => {
  seedWaiting(await projectId(request));
  await claudeIsInstalled(page);
  await page.goto('/board');
  const card = page.getByTestId('task-card').filter({ hasText: WAITING_TASK });
  await expect(card).toContainText('Waiting on Mark Ellis in Slack · 3h');
  // The builder is not asked for anything, so the card keeps its plain border.
  await expect(card).not.toHaveAttribute('data-state-color', 'yellow');
  await expect(card.getByTestId('state-dot')).toHaveAttribute('data-color', 'yellow');
  await expectAccessible(page, 'board, waiting on someone, dark');

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
