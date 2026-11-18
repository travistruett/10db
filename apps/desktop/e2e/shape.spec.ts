import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { inConversationColumn } from './conversation-column';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { auth, createProject } from './shape-project';

// Core flow 6: shaping a goal. Runs after loop.spec.ts (files run in name order with one worker); it adds
// its own project, on its own repository, and selects it. The daemon answers Shape sessions from the fake
// adapter: it echoes what it heard, and on Propose it proposes a goal, two loose tasks and a decision.

const Tasks = z.array(z.looseObject({ id: z.string(), title: z.string() }));

const MESSAGE = 'Make the cards denser. Thin out the scrollbars';

async function taskTitles(request: APIRequestContext, projectId: string): Promise<string[]> {
  const listed = await request.get(`${daemonUrl}/projects/${projectId}/tasks`, { headers: auth });
  return Tasks.parse(await listed.json()).map((t) => t.title);
}

async function openShape(page: Page, projectId: string): Promise<void> {
  await claudeIsInstalled(page);
  await page.addInitScript(
    ([id = '', value = '']: string[]) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
      window.localStorage.setItem('mantine-color-scheme-value', value);
    },
    [projectId, 'dark'],
  );
  await page.goto('/shape');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
}

test('a builder talks, proposes and converts from the keyboard, and every state passes axe', async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, 'shape-dark');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShape(page, projectId);

  // The first run: the input has focus and says what nothing does until you act.
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toBeFocused();
  await inConversationColumn(
    page.getByRole('region', { name: 'Conversation' }),
    input,
    'Plan at 1440',
  );
  await expect(
    page.getByText(
      'Nothing is proposed until you press Propose. Nothing starts until you Convert.',
    ),
  ).toBeVisible();
  await expectAccessible(page, 'first run');

  // ⌘↩ sends: Claude echoes what it heard in the sidebar.
  await page.keyboard.type(MESSAGE);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/\/shape\/shp_/);
  const sidebar = page.getByRole('region', { name: 'Proposed' });
  await expect(sidebar.getByText('Heard so far')).toBeVisible();
  await expect(sidebar.getByText('Make the cards denser')).toBeVisible();
  await expectAccessible(page, 'listening');

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
  await expectAccessible(page, 'proposed');

  // ↑/↓ move between rows; Enter opens one, read-only.
  // Only the rows themselves: each row's Actions menu button is also collapsed.
  const rows = sidebar
    .getByRole('list', { name: 'Proposed rows' })
    .locator('button[data-shape-row][aria-expanded="false"]');
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sidebar.getByText('The board is denser and calmer to scan.')).toBeVisible();
  await expectAccessible(page, 'a row open');

  // Convert says nothing starts, and writes the ticked rows to the Board's Backlog.
  await page.getByRole('button', { name: 'Convert' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Convert' });
  await expect(dialog.getByText('Nothing starts. Tasks wait on the Board.')).toBeVisible();
  await expectAccessible(page, 'convert');
  const before = (await taskTitles(request, projectId)).length;
  await dialog.getByRole('button', { name: 'Convert 4' }).click();
  await expect(dialog).toBeHidden();
  await expect(sidebar.getByText('Converted · on the Board')).toHaveCount(3);
  await expect(sidebar.getByText('Converted · in Knowledge')).toHaveCount(1);
  const titles = await taskTitles(request, projectId);
  expect(titles).toHaveLength(before + 4);
  expect(titles).toEqual(expect.arrayContaining(['Compact card density', 'Thin scrollbars']));
  await expectAccessible(page, 'converted');

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
