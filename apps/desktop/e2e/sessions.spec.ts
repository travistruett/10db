import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { inConversationColumn } from './conversation-column';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { E2E_DIR } from './paths';
import { auth, createProject } from './shape-project';

// Runs after see-screen.spec.ts and before shape.spec.ts (files run in name order with one worker). It
// adds its own project and drives one chat on the real daemon: the fake adapter answers the first
// message from script-book.json's "Chat: Why does login fail after sleep?", which reads, runs a
// command, names the session, replies in markdown, and after "File as Tasks" files a task, starts it,
// and asks to remove the builder's own task, which waits on a card.

const FIRST_LINE = 'Why does login fail after sleep?';

const FILES: Readonly<Record<string, string>> = {
  'src/login.ts': 'export const login = () => null;\n',
  'docs/a b.md': '# Notes\n',
};

const Tasks = z.array(z.looseObject({ id: z.string(), title: z.string() }));
const Workstreams = z.array(z.looseObject({ id: z.string(), projectId: z.string() }));

async function setScheme(page: Page, scheme: 'dark' | 'light'): Promise<void> {
  const html = page.locator('html');
  if ((await html.getAttribute('data-mantine-color-scheme')) === scheme) return;
  await page.getByRole('button', { name: `Switch to ${scheme} mode` }).click();
  await expect(html).toHaveAttribute('data-mantine-color-scheme', scheme);
}

/** axe over what is drawn, dark then light, at each width. */
async function scan(
  page: Page,
  widths: readonly number[],
  what: string,
  exclude: readonly string[] = [],
): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const scheme of ['dark', 'light'] as const) {
      await setScheme(page, scheme);
      await expectAccessible(page, `${what}, ${String(width)} ${scheme}`, exclude);
    }
  }
  await setScheme(page, 'dark');
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The polite region's messages, as the page recorded them from its first paint. */
function record(): void {
  const announced: string[] = [];
  Object.assign(window, { announced });
  new MutationObserver(() => {
    const said = document.querySelector('[aria-label="Sessions announcements"]')?.textContent ?? '';
    if (said !== '' && announced.at(-1) !== said) announced.push(said);
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

const sessionsBadge = (page: Page) =>
  page.getByRole('navigation').getByRole('link', { name: /^Sessions/ });

test('a chat end to end: a mention, a reply, the tasks it files, a judge’s card in the tab and the Inbox, the keys, a reload and Archive', async ({
  page,
  request,
}) => {
  // Fourteen axe scans and a real daemon turn are more than the default two minutes.
  test.setTimeout(300_000);
  const projectId = await createProject(
    request,
    'sessions',
    [{ name: 'repo', globs: ['**'] }],
    FILES,
  );
  const made = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: auth,
    data: { title: 'Hold the line', acceptanceCriteria: ['It holds'], areas: ['repo'] },
  });
  expect(made.ok()).toBe(true);

  await claudeIsInstalled(page);
  await page.addInitScript((id) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
    if (window.localStorage.getItem('mantine-color-scheme-value') === null)
      window.localStorage.setItem('mantine-color-scheme-value', 'dark');
  }, projectId);
  await page.addInitScript(record);

  // ⌘T from the Board opens Sessions on a fresh tab.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/board');
  await expect(page.getByRole('button', { name: /^Project: sessions/ })).toBeVisible();
  await page.keyboard.press('Meta+t');
  await expect(page).toHaveURL(/\/sessions\?fresh=/);
  await expect(page.getByText(/A chat reads sessions/)).toBeVisible();
  await scan(page, [1280, 480], 'a fresh tab');

  // The first line, then an @ file, then Enter: the tab is a chat, named by the agent once it calls set_title (the first-line title is gone before a
  // browser can look).
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.click();
  await composer.pressSequentially(`${FIRST_LINE} @log`);
  await page.getByRole('option', { name: /login\.ts/ }).click();
  await composer.press('Enter');
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toBeVisible();
  await inConversationColumn(page.getByRole('tabpanel'), composer, 'Sessions at 1280');

  // The reply, in an article headed by the agent's label; its settled work is one Worked row that
  // opens to a read row and a search row.
  const reply = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Claude Code' }) });
  await expect(reply.getByRole('heading', { name: 'What I found' })).toBeVisible();
  await expect(reply.getByText('const retry = once;')).toBeVisible();
  // The agent's todo list and what it left running sit above the composer.
  await expect(page.getByText('Plan · 1 of 3 done')).toBeVisible();
  await expect(page.getByLabel('Find why the retry is skipped, interrupted')).toBeVisible();
  await expect(page.getByText('Running in the background · 2')).toBeVisible();
  await expect(page.getByText('Subagent · Explore')).toBeVisible();
  await expect(page.getByText('pnpm exec vitest run login.test.ts')).toBeVisible();
  await expect(page.getByText(/Read 1 file/)).toHaveCount(0);
  await reply
    .getByRole('button', { name: /^Worked/ })
    .first()
    .click();
  await expect(page.getByText(/Read 1 file/).first()).toBeVisible();
  await expect(page.getByText(/searched/i).first()).toBeVisible();
  await scan(page, [1280], 'the conversation');

  // A link asks first, in the builder's words, and Cancel leaves the page alone.
  await reply.getByRole('link', { name: 'the retry notes' }).click();
  const confirm = page.getByRole('dialog', { name: 'Open example.com in your browser?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();

  // File as Tasks: the task row, its start row, then the judge's card for the builder's own task.
  await page.getByRole('button', { name: 'File as Tasks' }).click();
  await expect(page.getByText('Retry login once on a 401').first()).toBeVisible();
  await expect(page.getByText('Added to Ready')).toBeVisible();
  await expect(page.getByText(/Started Retry login once on a 401/)).toBeVisible();
  const card = page.getByRole('region', { name: 'Waiting for your answer' });
  await expect(card).toBeVisible();
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toHaveAttribute(
    'data-ring',
    'yellow',
  );
  await expect(sessionsBadge(page)).toContainText('1 session needs you');
  // With a card waiting, the plan and the background tasks fold to their headings, so on a short narrow
  // window the composer stays on screen.
  await page.setViewportSize({ width: 480, height: 600 });
  // The narrow layout settles after the resize, so the composer is read until it is in view: the
  // whole box, from the textbox down to the controls under it.
  const composerBottom = async (): Promise<number> =>
    page.getByRole('textbox', { name: 'Message' }).evaluate((field) => {
      const whole = field.closest('[data-composer-frame]')?.parentElement ?? field;
      return whole.getBoundingClientRect().bottom;
    });
  await expect
    .poll(composerBottom, { message: 'the composer’s bottom edge' })
    .toBeLessThanOrEqual(600);
  await page.setViewportSize({ width: 1280, height: 900 });
  await scan(page, [1280, 480], 'a waiting card');

  // ⌘J from a second tab selects the tab that needs the builder; the Inbox lists the card too.
  await page.keyboard.press('Meta+t');
  await expect(page).toHaveURL(/\/sessions\?fresh=/);
  await page.keyboard.press('Meta+j');
  await expect(page).toHaveURL(/\/sessions\?chat=/);
  await page.getByRole('navigation').getByRole('link', { name: 'Inbox' }).click();
  const inboxCard = page.getByRole('button', { name: /Remove “Hold the line”\?/ });
  if ((await inboxCard.count()) > 0) await inboxCard.first().click();
  await expect(page.getByRole('button', { name: 'Open Session' })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: /^Sessions/ })
    .click();

  // Deny in the tab: the ring and the badge clear, the builder's task stays and the turn ends.
  await card.getByRole('radio', { name: /Deny/ }).check();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).not.toHaveAttribute(
    'data-ring',
    /.+/,
  );
  await expect(sessionsBadge(page)).not.toContainText('need');
  await expect(page.getByText('I left the other task alone.')).toBeVisible();
  const listed = Tasks.parse(
    await (await request.get(`${daemonUrl}/projects/${projectId}/tasks`, { headers: auth })).json(),
  );
  expect(listed.map((t) => t.title)).toContain('Hold the line');

  // The started task opens on the Board from its row.
  await page.getByRole('link', { name: 'Open on Board' }).first().click();
  await expect(page).toHaveURL(/\/board/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: /^Sessions/ })
    .click();

  // / lists the session's commands; Esc closes the list.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await box.pressSequentially('/');
  await expect(page.getByRole('option', { name: /compact/ })).toBeVisible();
  await box.press('Escape');
  await expect(page.getByRole('option', { name: /compact/ })).toHaveCount(0);
  await box.fill('');

  // All Tabs, scanned open; ⌘T, ⌘1, ⌘W and ⌘⇧T.
  await page.getByRole('button', { name: 'All Tabs' }).click();
  await expect(page.getByRole('menuitem', { name: /Login fails after sleep/ })).toBeVisible();
  // The menu fades in over 150 ms; axe reads it once it is whole.
  await expect(page.getByRole('menu', { name: 'All Tabs' })).toHaveCSS('opacity', '1');
  // Mantine wraps a menu's items in a focusable presentation div, which axe's aria-required-children
  // rule does not accept as a menu's child; the menu's own items are named and keyed by the tests above.
  await scan(page, [1280], 'All Tabs open', ['[data-menu-dropdown]']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+1');
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Meta+w');
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+t');
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toBeVisible();

  // What the live region said, read before the reload empties the page's record.
  const saidBeforeReload = await page.evaluate(
    () => (window as unknown as { announced: string[] }).announced,
  );

  // A reload restores the tab from the daemon.
  await page.getByRole('tab', { name: /Login fails after sleep/ }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toBeVisible();

  // At 480 one switcher stands for the strip.
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(
    page.getByRole('button', { name: /Login fails after sleep.*All Tabs/ }),
  ).toBeVisible();
  await scan(page, [480], 'the conversation at 480');

  // Archive, from the ⋯ menu: the tab is gone, and Recent does not list it on a fresh tab.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'More session actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByRole('tab', { name: /Login fails after sleep/ })).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Recent' }).getByText('Login fails after sleep'),
  ).toHaveCount(0);

  // The announcer said a reply and a question, and nothing it should not.
  const announced = await page.evaluate(
    () => (window as unknown as { announced: string[] }).announced,
  );
  expect(
    [...saidBeforeReload, ...announced].some((line) => line.startsWith('Claude Code replied:')),
  ).toBe(true);

  // Later specs read Factory across projects: the task this chat started is stopped.
  const streams = Workstreams.parse(
    await (await request.get(`${daemonUrl}/workstreams?active=true`, { headers: auth })).json(),
  ).filter((w) => w.projectId === projectId);
  for (const stream of streams)
    await request.post(`${daemonUrl}/workstreams/${stream.id}/cancel`, { headers: auth });
});

const WorkstreamNotices = z.array(
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    notice: z.looseObject({ key: z.string(), line: z.string() }).nullable().optional(),
  }),
);

test('a chat writes in Your folder: an edit and a commit, a task that waits for it, and a message that waits for the task', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const projectId = await createProject(
    request,
    'sessions-folder',
    [{ name: 'repo', globs: ['**'] }],
    {
      'src/login.ts': 'export const login = () => null;\n',
    },
  );
  // The e2e daemon runs no sandbox, so a chat cannot write a file here: the edit is the builder's, left
  // uncommitted in Your folder, and the chat's tool commits it through the daemon's git.
  const repo = join(E2E_DIR, 'sessions-folder-repo');
  writeFileSync(join(repo, 'notes.md'), '# Notes\n\nEdited by a chat.\n');
  await claudeIsInstalled(page);
  await page.addInitScript((id) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
    if (window.localStorage.getItem('mantine-color-scheme-value') === null)
      window.localStorage.setItem('mantine-color-scheme-value', 'dark');
  }, projectId);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/board');
  await expect(page.getByRole('button', { name: /^Project: sessions-folder/ })).toBeVisible();
  await page.keyboard.press('Meta+t');
  await expect(page).toHaveURL(/\/sessions\?fresh=/);

  // The edit and the commit: the agent's rows show, and the bar says the chat is in Your folder.
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.click();
  await composer.pressSequentially('Fix the notes');
  await composer.press('Enter');
  await expect(page.getByText('Committed the notes.')).toBeVisible();
  await expect(page.getByText('Chat · Your folder · on main')).toBeVisible();
  const lastCommit = execFileSync('git', ['log', '-1', '--format=%s|%an'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
  expect(lastCommit).toBe('Add the notes|10db e2e');

  // A task started while the turn holds the folder waits, naming the chat.
  const made = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: auth,
    data: { title: 'Hold the folder', acceptanceCriteria: ['It holds'], areas: ['repo'] },
  });
  expect(made.ok()).toBe(true);
  const taskId = z.looseObject({ id: z.string() }).parse(await made.json()).id;
  expect((await request.post(`${daemonUrl}/tasks/${taskId}/start`, { headers: auth })).ok()).toBe(
    true,
  );
  const notices = async (): Promise<string[]> =>
    WorkstreamNotices.parse(
      await (await request.get(`${daemonUrl}/workstreams?active=true`, { headers: auth })).json(),
    )
      .filter((w) => w.projectId === projectId)
      .flatMap((w) => (w.notice?.key === 'folder-hold' ? [w.notice.line] : []));
  await expect.poll(notices).toEqual([expect.stringContaining('Fix the notes')]);

  // The turn ends; the task takes the folder and keeps it, so the chat reads only.
  await composer.click();
  await composer.pressSequentially('wrap up');
  await composer.press('Enter');
  await expect(page.getByRole('article').getByText('Wrapped up.')).toBeVisible();
  await expect(
    page.getByText('Chat · reads only: Your folder is in use by the task ‘Hold the folder’'),
  ).toBeVisible();

  // A message now asks first; Wait for It parks it, and it runs once the task ends.
  await composer.click();
  await composer.pressSequentially('Fix the notes again');
  await composer.press('Enter');
  const choices = page.getByRole('group', { name: 'Your folder is in use' });
  await expect(choices).toBeVisible();
  await scan(page, [1280], 'the held-folder choices');
  await choices.getByRole('button', { name: 'Wait for It' }).click();
  await expect(
    page.getByText('Waits for Your folder: in use by the task ‘Hold the folder’'),
  ).toBeVisible();
  const streams = Workstreams.parse(
    await (await request.get(`${daemonUrl}/workstreams?active=true`, { headers: auth })).json(),
  ).filter((w) => w.projectId === projectId);
  for (const stream of streams)
    await request.post(`${daemonUrl}/workstreams/${stream.id}/cancel`, { headers: auth });
  await expect(page.getByRole('article').getByText('Looked again.')).toBeVisible();
  await expect(page.getByText('Chat · Your folder · on main')).toBeVisible();
});
