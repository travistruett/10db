import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { inConversationColumn } from './conversation-column';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { auth, createProject } from './shape-project';

// Runs after loop.spec.ts (files run in name order with one worker); it adds its own project, on its
// own repository, and selects it. The daemon answers Shape sessions from the fake adapter: it echoes
// what it heard, and on Propose it proposes a goal, two loose tasks and a decision.

const Tasks = z.array(z.looseObject({ id: z.string(), title: z.string() }));
const LongView = z.looseObject({
  conversationId: z.string(),
  proposals: z.array(z.looseObject({})),
});
const LongItems = z.looseObject({
  items: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
});

const MESSAGE = 'Make the cards denser. Thin out the scrollbars';

async function taskTitles(request: APIRequestContext, projectId: string): Promise<string[]> {
  const listed = await request.get(`${daemonUrl}/projects/${projectId}/tasks`, { headers: auth });
  return Tasks.parse(await listed.json()).map((t) => t.title);
}

async function openShape(page: Page, projectId: string, scheme: 'dark' | 'light'): Promise<void> {
  await claudeIsInstalled(page);
  await page.addInitScript(
    ([id = '', value = '']: string[]) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
      window.localStorage.setItem('mantine-color-scheme-value', value);
    },
    [projectId, scheme],
  );
  await page.goto('/shape');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
}

test.describe.configure({ mode: 'serial' });

const projects = new Map<string, string>();

for (const scheme of ['dark', 'light'] as const) {
  test(`a builder talks, proposes and converts from the keyboard in ${scheme}, and every state passes axe`, async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `shape-${scheme}`);
    projects.set(scheme, projectId);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShape(page, projectId, scheme);

    // The first run: the input has focus and says what nothing does until you act.
    const input = page.getByRole('textbox', { name: 'Message' });
    await expect(input).toBeFocused();
    await inConversationColumn(
      page.getByRole('region', { name: 'Conversation' }),
      input,
      `Plan at 1440, ${scheme}`,
    );
    await expect(
      page.getByText(
        'Nothing is proposed until you press Propose. Nothing starts until you Convert.',
      ),
    ).toBeVisible();
    await expectAccessible(page, `first run, ${scheme}`);

    // ⌘↩ sends: Claude echoes what it heard in the sidebar.
    await page.keyboard.type(MESSAGE);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page).toHaveURL(/\/shape\/shp_/);
    const sidebar = page.getByRole('region', { name: 'Proposed' });
    await expect(sidebar.getByText('Heard so far')).toBeVisible();
    await expect(sidebar.getByText('Make the cards denser')).toBeVisible();
    await expectAccessible(page, `listening, ${scheme}`);

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
    await expectAccessible(page, `proposed, ${scheme}`);

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
    await expectAccessible(page, `a row open, ${scheme}`);

    // Convert says nothing starts, and writes the ticked rows to the Board's Backlog.
    await page.getByRole('button', { name: 'Convert' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Convert' });
    await expect(dialog.getByText('Nothing starts. Tasks wait on the Board.')).toBeVisible();
    await expectAccessible(page, `convert, ${scheme}`);
    const before = (await taskTitles(request, projectId)).length;
    await dialog.getByRole('button', { name: 'Convert 4' }).click();
    await expect(dialog).toBeHidden();
    await expect(sidebar.getByText('Converted · on the Board')).toHaveCount(3);
    await expect(sidebar.getByText('Converted · in Knowledge')).toHaveCount(1);
    const titles = await taskTitles(request, projectId);
    expect(titles).toHaveLength(before + 4);
    expect(titles).toEqual(expect.arrayContaining(['Compact card density', 'Thin scrollbars']));
    await expectAccessible(page, `converted, ${scheme}`);

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
}

test('under 1100 px the sidebar is a drawer, and the summary line stays on screen', async ({
  page,
}) => {
  // Plan measures its own width, and the rail takes 60 px of the window's.
  await page.setViewportSize({ width: 1140, height: 720 });
  const projectId = projects.get('dark');
  if (projectId === undefined) throw new Error('The dark run makes the project this test opens');
  await openShape(page, projectId, 'dark');
  // Like the runs above, wait for the screen to finish loading before typing: a draft entered while it
  // is still loading can be lost, and then the key sends nothing.
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toBeFocused();
  await expect(
    page.getByText(
      'Nothing is proposed until you press Propose. Nothing starts until you Convert.',
    ),
  ).toBeVisible();
  // The nav says Plan and lists no conversations; the earlier run's conversation is under the composer.
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Plan' })).toBeVisible();
  await expect(page.getByRole('navigation').getByText('No conversations yet')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Recent conversations' })).toBeVisible();
  await expectAccessible(page, 'new conversation with recent conversations');
  await input.fill(MESSAGE);
  await expect(input).toHaveValue(MESSAGE);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/\/shape\/shp_/);
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Summary' })).toHaveText(
    '1 goal · 2 loose · 1 to record',
  );
  const toggle = page.getByRole('button', { name: 'Proposed', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expectAccessible(page, 'drawer closed');
  await toggle.click();
  await expect(page.getByRole('region', { name: 'Proposed' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Summary' })).toBeVisible();
  await expectAccessible(page, 'drawer open');
});

const FRAMES = 240;
const SCROLL_PER_FRAME = 300;
const SLOWEST_MEDIAN_FRAME_MS = 100;
/** A window of blocks at 900 px, overscan included; the conversation has 2,000. */
const NEAR_THE_VIEWPORT = 60;

/** Each third reply is long, so measured heights differ from the estimate. */
const longBody = (i: number): string =>
  i % 3 === 0
    ? `Message ${String(i)}. ${'A long reply that wraps. '.repeat(30)}`
    : `Message ${String(i)}`;

test('a 2,000-message conversation mounts only the blocks near the viewport as WebKit scrolls', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const projectId = projects.get('dark');
  if (projectId === undefined) throw new Error('The dark run makes the project this test opens');
  await openShape(page, projectId, 'dark');
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toBeFocused();
  await expect(
    page.getByText(
      'Nothing is proposed until you press Propose. Nothing starts until you Convert.',
    ),
  ).toBeVisible();
  await input.fill(MESSAGE);
  await expect(input).toHaveValue(MESSAGE);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/\/shape\/shp_/);
  await page.getByRole('button', { name: 'Propose', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Summary' })).toHaveText(
    '1 goal · 2 loose · 1 to record',
  );

  // The daemon's real conversation, with 2,000 messages in it and a row that came from one far down.
  const shapeId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const WHY_TARGET = 1500;
  const viewed = await page.request.get(`${daemonUrl}/shapes/${shapeId}`, { headers: auth });
  const { conversationId } = LongView.parse(await viewed.json());
  const real = await page.request.get(`${daemonUrl}/conversations/${conversationId}/items`, {
    headers: auth,
  });
  const template = LongItems.parse(await real.json()).items.find((i) => i.kind === 'message');
  if (template === undefined) throw new Error('The conversation has its first message');
  const items = Array.from({ length: 2000 }, (_, i) => ({
    ...template,
    // Still a UUID v7, which the schema asks for: only its last digits differ.
    id: `${template.id.slice(0, -4)}${i.toString(16).padStart(4, '0')}`,
    seq: i + 1,
    author: i % 2 === 0 ? 'builder' : 'agent',
    kind: i % 2 === 0 ? 'message' : 'agent_message',
    text: longBody(i),
  }));
  await page.route(`${daemonUrl}/conversations/${conversationId}/items*`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { items, nextAfterSeq: null } });
  });
  await page.route(`${daemonUrl}/shapes/${shapeId}`, async (route) => {
    const response = await route.fetch();
    const view = LongView.parse(await response.json());
    const proposals = view.proposals.map((p) => ({
      ...p,
      sourceMessageIds: [items[WHY_TARGET]?.id],
    }));
    await route.fulfill({ response, json: { ...view, proposals } });
  });
  await page.reload();

  const transcript = page.getByRole('group', { name: 'Messages' });
  const blocks = transcript.locator('[data-message-id]');
  // It opens at its newest message, as a chat does, mounting only the blocks near it.
  await expect(transcript.getByText('Message 1999', { exact: false })).toBeInViewport();
  expect(await blocks.count()).toBeLessThan(NEAR_THE_VIEWPORT);
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(transcript.getByText('Message 0.', { exact: false })).toBeVisible();
  expect(await blocks.count()).toBeLessThan(NEAR_THE_VIEWPORT);

  // A block wraps to the pane: the list's absolute positioning must not widen it.
  const widths = await transcript.evaluate((el) => {
    const block = el.querySelector('[data-message-id]');
    return {
      pane: el.clientWidth,
      block: block?.getBoundingClientRect().width ?? 0,
      scroll: el.scrollWidth,
    };
  });
  expect(widths.block).toBeLessThan(widths.pane);
  expect(widths.scroll).toBe(widths.pane);

  // Down the conversation a step a frame, and back up through blocks that were measured and let go.
  const run = await transcript.evaluate(
    (el, { frames, step }) =>
      new Promise<{ mostMounted: number; gaps: number; frameMs: number[] }>((resolve) => {
        let frame = 0;
        let mostMounted = 0;
        let gaps = 0;
        let last = performance.now();
        const frameMs: number[] = [];
        const tick = (now: number): void => {
          frameMs.push(now - last);
          last = now;
          const mounted = el.querySelectorAll('[data-message-id]');
          mostMounted = Math.max(mostMounted, mounted.length);
          const pane = el.getBoundingClientRect();
          const covered = [...mounted].some((block) => {
            const box = block.getBoundingClientRect();
            return (
              box.bottom > pane.top + pane.height / 2 - 40 &&
              box.top < pane.top + pane.height / 2 + 40
            );
          });
          if (!covered) gaps += 1;
          if (frame === frames) {
            resolve({ mostMounted, gaps, frameMs: frameMs.slice(1) });
            return;
          }
          el.scrollTop += frame < frames / 2 ? step : -step;
          frame += 1;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { frames: FRAMES, step: SCROLL_PER_FRAME },
  );
  expect(run.mostMounted).toBeLessThan(NEAR_THE_VIEWPORT);
  expect(run.gaps).toBe(0);
  const sorted = run.frameMs.toSorted((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
  await testInfo.attach('scroll frames', {
    contentType: 'application/json',
    body: JSON.stringify({
      frames: sorted.length,
      medianMs,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      worstMs: sorted.at(-1),
      mostMounted: run.mostMounted,
    }),
  });
  // A wide bound, for a loaded CI machine: it catches a scroll that drags, not a dropped frame.
  expect(medianMs).toBeLessThan(SLOWEST_MEDIAN_FRAME_MS);

  // Why? reaches a block that is not mounted, past blocks whose real heights are not known yet.
  // 'Thin scrollbars' is a task inside the goal, not a row of its own: the goal row has the menu.
  await page.getByRole('button', { name: 'Actions for Board polish' }).click();
  await page.getByRole('menuitem', { name: 'Why?' }).click();
  const target = transcript.locator('[data-highlighted]');
  await expect(target).toContainText(`Message ${String(WHY_TARGET)}`);
  await expect(target).toBeInViewport();
  expect(await blocks.count()).toBeLessThan(NEAR_THE_VIEWPORT);
});
