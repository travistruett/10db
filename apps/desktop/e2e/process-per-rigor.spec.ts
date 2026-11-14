import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { auth, createProject } from './shape-project';

// Each rigor's process through the real daemon and the fake agent (script-book.json, keyed by task
// title): the row drawer on Settings › Models, then a Critical task that waits for the builder's
// approval of its plan, with Send Back. Runs after plan-record.spec.ts; each task has its own project.

const Id = z.looseObject({ id: z.string() });

test.describe.configure({ mode: 'serial' });

async function openPage(page: Page, path: string, projectId?: string): Promise<void> {
  await claudeIsInstalled(page);
  if (projectId !== undefined)
    await page.addInitScript((id: string) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
    }, projectId);
  await page.goto(path);
}

/** A project with one Critical task, started; its steps are the Critical row's, the global default. */
async function startCritical(
  request: APIRequestContext,
  project: string,
  title: string,
): Promise<string> {
  const projectId = await createProject(request, project);
  const created = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: auth,
    data: {
      title,
      acceptanceCriteria: ['the file is written'],
      areas: ['repo'],
      rigor: 'critical',
    },
  });
  expect(created.ok()).toBe(true);
  const started = await request.post(
    `${daemonUrl}/tasks/${Id.parse(await created.json()).id}/start`,
    {
      headers: auth,
    },
  );
  expect(started.ok()).toBe(true);
  return projectId;
}

/** The one plan card, opened in the Inbox. */
async function openPlanCard(page: Page, title: string, planText: string) {
  const row = page.getByRole('button', {
    name: new RegExp(`Plan ready for you to approve: ${title}`),
  });
  await row.click();
  await expect(page.getByText(planText)).toBeVisible();
  return row;
}

test('a rigor row shows its process in its drawer, and an edit changes the row header and resets', async ({
  page,
  request,
}) => {
  // Alone, the window opens on the first run until a project exists.
  const projectId = await createProject(request, 'prr-settings');
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/settings/models', projectId);
  const main = page.getByRole('main');
  const standard = main.getByRole('button', { name: 'Standard steps' });
  await expect(standard).toContainText('1 round · resumed fix');

  await main.getByRole('button', { name: 'Critical steps' }).click();
  const critical = page.getByRole('dialog', { name: 'Critical: process' });
  await expect(
    critical.getByRole('radiogroup', { name: 'Review rounds' }).getByRole('radio', { name: '2' }),
  ).toBeChecked();
  await expect(critical.getByRole('combobox', { name: 'A send-back is fixed by' })).toHaveValue(
    'A fresh build session',
  );
  await expect(
    critical.getByRole('switch', { name: 'The builder approves the plan' }),
  ).toBeChecked();
  // The drawer fades in as it slides; axe would measure contrast mid-fade.
  await expect(critical).toHaveCSS('opacity', '1');
  await expectAccessible(page, 'settings models, critical process drawer');
  await critical.getByRole('button', { name: 'Done' }).click();
  await expect(critical).toBeHidden();

  await standard.click();
  const drawer = page.getByRole('dialog', { name: 'Standard: process' });
  await drawer
    .getByRole('radiogroup', { name: 'Review rounds' })
    .getByText('2', { exact: true })
    .click();
  await expect(standard).toContainText('2 rounds · resumed fix');
  await drawer.getByRole('button', { name: 'Reset: review rounds' }).click();
  await expect(standard).toContainText('1 round · resumed fix');
  await expect(
    drawer.getByRole('radiogroup', { name: 'Review rounds' }).getByRole('radio', { name: '1' }),
  ).toBeChecked();
});

test('a Critical task waits for the plan to be approved, then builds and finishes', async ({
  page,
  request,
}) => {
  const title = 'Pair the device';
  const projectId = await startCritical(request, 'prr-approve', title);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/inbox', projectId);

  // Plan and Plan Review approved; Build has not started, so the plan is the only card for the task.
  const planText = 'PLAN ONE: write notes/pair.txt.';
  await openPlanCard(page, title, planText);
  await expect(page.getByText(/Plan ready for you to approve/)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await expectAccessible(page, 'inbox, plan card');

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(planText)).toBeHidden();

  // Build commits, Review and QA approve, and the task is done.
  await page.getByRole('link', { name: /^Board/ }).click();
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: title }),
  ).toBeVisible();
});

test('Send Back needs a note, and with one plans again', async ({ page, request }) => {
  const title = 'Pair the second device';
  const projectId = await startCritical(request, 'prr-send-back', title);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/inbox', projectId);
  await openPlanCard(page, title, 'PLAN FIRST: write notes/second.txt.');

  await page.getByRole('button', { name: 'Send Back', exact: true }).click();
  const send = page.getByRole('button', { name: 'Send It Back' });
  await expect(send).toBeDisabled();
  await page.getByLabel('What needs to change in the plan').fill('Add a header to the file.');
  await send.click();

  // Plan runs again with the note, and Plan Review approves it; the new plan is a new card, whose
  // row is opened to read it. The first plan's card is gone.
  await openPlanCard(page, title, 'PLAN REVISED: write notes/second.txt with a header.');
  await expect(page.getByText('PLAN FIRST: write notes/second.txt.')).toBeHidden();
  await expect(page.getByText(/Plan ready for you to approve/)).toHaveCount(1);

  // Finish the task so no card is left for the specs after this one.
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('link', { name: /^Board/ }).click();
  await expect(
    page.getByRole('list', { name: 'Done tasks' }).getByRole('listitem', { name: title }),
  ).toBeVisible();
});
