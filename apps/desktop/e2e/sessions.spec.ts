import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
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
  // The theme is set in Settings › Appearance; here it is written where Mantine keeps it, and the storage
  // event Mantine listens for applies it without leaving the page under test.
  await page.evaluate((value) => {
    const key = 'mantine-color-scheme-value';
    window.localStorage.setItem(key, value);
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: value, storageArea: window.localStorage }),
    );
  }, scheme);
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

/** axe over an open modal, light then dark, set on the page's own attribute so the modal stays open. */
async function scanModal(page: Page, what: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-mantine-color-scheme', value);
    }, scheme);
    await expectAccessible(page, `${what}, ${scheme}`);
  }
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

/** A session's row in the panel, by its title. */
const sessionRow = (page: Page, title: RegExp) => page.getByRole('option', { name: title });

const sessionsBadge = (page: Page) =>
  page.getByRole('navigation').getByRole('link', { name: /^Sessions/ });

test('a chat end to end: a mention, a reply, the tasks it files, a judge’s card in the panel and the Inbox, the keys, a reload and Archive', async ({
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

  // ⌘T from the Board opens Sessions on a fresh session.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/board');
  await expect(page.getByRole('button', { name: /^Project: sessions/ })).toBeVisible();
  await page.keyboard.press('Meta+t');
  await expect(page).toHaveURL(/\/sessions\?fresh=/);
  await expect(page.getByText(/A chat reads sessions/)).toBeVisible();
  await scan(page, [1280, 480], 'a fresh tab');

  // The first line, then an @ file, then Enter: the session is a row in the panel, named by the agent once
  // it calls set_title (the first-line title is gone before a browser can look).
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.click();
  await composer.pressSequentially(`${FIRST_LINE} @log`);
  await page.getByRole('option', { name: /login\.ts/ }).click();
  await composer.press('Enter');
  await expect(sessionRow(page, /Login fails after sleep/)).toBeVisible();
  await inConversationColumn(page.getByRole('main'), composer, 'Sessions at 1280');

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
  await page.getByRole('button', { name: 'More session actions' }).click();
  await page.getByRole('menuitem', { name: 'File as Tasks' }).click();
  await expect(page.getByText('Retry login once on a 401').first()).toBeVisible();
  await expect(page.getByText('Added to Ready')).toBeVisible();
  await expect(page.getByText(/Started Retry login once on a 401/)).toBeVisible();
  const card = page.getByRole('region', { name: 'Waiting for your answer' });
  await expect(card).toBeVisible();
  await expect(sessionRow(page, /Login fails after sleep/)).toHaveAttribute(
    'data-ring',
    'needs_you',
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
  await page
    .getByRole('option', { name: /Remove “Hold the line”\?/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Open Session' })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: /^Sessions/ })
    .click();
  // Sessions comes back on the fresh session ⌘T opened; the row is the way to the one that waits.
  await sessionRow(page, /Login fails after sleep/).click();

  // Deny in the session: the ring and the badge clear, the builder's task stays and the turn ends.
  await card.getByRole('radio', { name: /Deny/ }).check();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect(sessionRow(page, /Login fails after sleep/)).not.toHaveAttribute('data-ring', /.+/);
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
  await sessionRow(page, /Login fails after sleep/).click();

  // / lists the session's commands; Esc closes the list.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await box.pressSequentially('/');
  await expect(page.getByRole('option', { name: /compact/ })).toBeVisible();
  await box.press('Escape');
  await expect(page.getByRole('option', { name: /compact/ })).toHaveCount(0);
  await box.fill('');

  // The ⌄ switcher, scanned open; ⌘1, ⌘W and ⌘⇧T.
  await page.getByRole('button', { name: 'Switch session' }).click();
  await expect(page.getByRole('menuitem', { name: /Login fails after sleep/ })).toBeVisible();
  // The menu fades in over 150 ms; axe reads it once it is whole.
  await expect(page.getByRole('menu')).toHaveCSS('opacity', '1');
  // Mantine wraps a menu's items in a focusable presentation div, which axe's aria-required-children
  // rule does not accept as a menu's child; the menu's own items are named and keyed by the tests above.
  await scan(page, [1280], 'the switcher open', ['[data-menu-dropdown]']);
  await page.keyboard.press('Escape');
  // ⌘1 is the first row of the panel, whichever session that is; the row of ours is then clicked and ⌘W closes it.
  await page.keyboard.press('Meta+1');
  await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await sessionRow(page, /Login fails after sleep/).click();
  await page.keyboard.press('Meta+w');
  await expect(sessionRow(page, /Login fails after sleep/)).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+t');
  await expect(sessionRow(page, /Login fails after sleep/)).toBeVisible();

  // What the live region said, read before the reload empties the page's record.
  const saidBeforeReload = await page.evaluate(
    () => (window as unknown as { announced: string[] }).announced,
  );

  // A reload restores the tab from the daemon.
  await sessionRow(page, /Login fails after sleep/).click();
  await page.reload();
  await expect(sessionRow(page, /Login fails after sleep/)).toBeVisible();
  await scan(page, [480], 'the conversation at 480');

  // Archive, from the ⋯ menu: the row is gone, and Recent does not list it on a fresh tab.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'More session actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(sessionRow(page, /Login fails after sleep/)).toHaveCount(0);
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

/** Runs git in a repository, with git's own config kept out. */
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
}

const OpenChats = z.array(
  z.looseObject({
    work: z.looseObject({ worktree: z.string().nullable() }).nullable(),
  }),
);

/** The worktree a session works in, read from the daemon's open chats; the only one the project has. */
async function worktreeOf(request: APIRequestContext, project: string): Promise<string> {
  const chats = OpenChats.parse(
    await (await request.get(`${daemonUrl}/chats?open=1`, { headers: auth })).json(),
  );
  const found = chats.flatMap((chat) =>
    chat.work?.worktree?.includes(`/${project}-`) ? [chat.work.worktree] : [],
  );
  expect(found).toHaveLength(1);
  return found[0] ?? '';
}

/** A project of its own, the Board open on it and the window set to dark at 1280. */
async function openProject(page: Page, request: APIRequestContext, name: string): Promise<string> {
  const projectId = await createProject(request, name, [{ name: 'repo', globs: ['**'] }], {
    'notes.md': '# Notes\n',
  });
  await claudeIsInstalled(page);
  await page.addInitScript((id) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
    if (window.localStorage.getItem('mantine-color-scheme-value') === null)
      window.localStorage.setItem('mantine-color-scheme-value', 'dark');
  }, projectId);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/board');
  await expect(page.getByRole('button', { name: new RegExp(`^Project: ${name}`) })).toBeVisible();
  return projectId;
}

/** Sends the first line of a fresh session, which the book scripts. */
async function startSession(page: Page, line: string): Promise<void> {
  await page.keyboard.press('Meta+t');
  await expect(page).toHaveURL(/\/sessions\?fresh=/);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.click();
  await composer.pressSequentially(line);
  await composer.press('Enter');
}

const workBar = (page: Page) => page.getByRole('group', { name: 'Where this work happens' });

test('a session on a new branch: the first change asks, the move cuts a worktree, the edit is not in the checkout, then Commit and Merge into main', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await openProject(page, request, 'sessions-branch');
  const repo = join(E2E_DIR, 'sessions-branch-repo');
  await startSession(page, 'Edit on a branch');

  // The session read, then went to change a file: the bar asks, and the row says it needs the builder.
  await expect(page.getByText('Reading the notes first.')).toBeVisible();
  await expect(workBar(page)).toBeVisible();
  await expect(page.getByText(/waiting for your choice/)).toBeVisible();
  await scan(page, [1280, 900], 'the work bar');

  // On a New Branch: the same conversation carries on in a worktree, which is the root of its edits.
  await workBar(page).getByRole('button', { name: 'On a New Branch' }).click();
  await expect(page.getByText('Wrote the notes.')).toBeVisible();
  await expect(workBar(page)).toHaveCount(0);
  const worktree = await worktreeOf(request, 'sessions-branch');
  expect(worktree).not.toBe(repo);
  expect(git(worktree, 'branch', '--show-current')).toBe('edit-on-a-branch');
  // The e2e daemon runs no sandbox, so the agent's own write is refused; the builder's stand-in lands in
  // the worktree and never in the checkout.
  expect(git(repo, 'status', '--porcelain')).toBe('');
  writeFileSync(join(worktree, 'notes.md'), '# Notes\n\nWritten on a branch.\n');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('# Notes\n');
  await page.reload();
  await expect(page.getByText(/on edit-on-a-branch · 1 file changed, not committed/)).toBeVisible();

  // Commit… lists the file, unchecked as nothing of the session's tools touched it, and commits it.
  await page.getByRole('button', { name: 'Commit…' }).click();
  const modal = page.getByRole('dialog', { name: 'Commit' });
  await expect(modal.getByRole('textbox', { name: 'Message' })).toHaveValue('Edit on a branch');
  await modal.getByRole('checkbox', { name: 'notes.md' }).check();
  await scanModal(page, 'the commit form');
  await modal.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(modal).toBeHidden();
  expect(git(worktree, 'log', '-1', '--format=%s')).toBe('Edit on a branch');
  await expect(page.getByText(/1 commit not merged into main/)).toBeVisible();

  // Changes opens as a drawer and Esc closes it.
  await page.getByRole('button', { name: /^Changes/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Changes' });
  await expect(drawer.getByText('notes.md').first()).toBeVisible();
  await scan(page, [1280], 'the Changes drawer');
  // Esc closes the drawer while focus is inside it; the scan's last click left it on the rail's toggle.
  await drawer.focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Merge into main: main has the commit and the checkout has the file.
  await page.getByRole('button', { name: 'Merge into main' }).click();
  await expect.poll(() => git(repo, 'log', 'main', '--format=%s')).toContain('Edit on a branch');
  expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('# Notes\n\nWritten on a branch.\n');
  await expect(page.getByText(/on edit-on-a-branch · nothing ahead of main/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Merge into main/ })).toHaveCount(0);
});

test('the question survives a reload: the bar and the Inbox card are there again, and 2 answers it', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await openProject(page, request, 'sessions-choosing');
  await startSession(page, 'Choose after a reload');
  await expect(workBar(page)).toBeVisible();
  await page.reload();
  await expect(workBar(page)).toBeVisible();
  await expect(sessionRow(page, /Choose after a reload/)).toHaveAttribute('data-ring', 'needs_you');
  // The daemon holds the question, not the page: its restart is the daemon test's, since the e2e daemon
  // is the runner's to start and stop.
  await page.keyboard.press('2');
  await expect(page.getByText('Wrote the later notes.')).toBeVisible();
  await expect(sessionRow(page, /Choose after a reload/)).not.toHaveAttribute('data-ring', /.+/);
});

test('Archive on a dirty worktree lists what would be lost, deletes it on the builder’s word, and Reopen brings the session back', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await openProject(page, request, 'sessions-archive');
  await startSession(page, 'Edit then archive');
  await expect(workBar(page)).toBeVisible();
  await workBar(page).getByRole('button', { name: 'On a New Branch' }).click();
  await expect(page.getByText('Wrote the dirty notes.')).toBeVisible();
  const worktree = await worktreeOf(request, 'sessions-archive');
  writeFileSync(join(worktree, 'scratch.txt'), 'not committed\n');
  await page.reload();
  await page.getByRole('button', { name: 'More session actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText('scratch.txt')).toBeVisible();
  await scanModal(page, 'the archive question');
  await confirm.getByRole('button', { name: /Archive and Delete/ }).click();
  await expect(sessionRow(page, /Edit then archive/)).toHaveCount(0);
  expect(existsSync(worktree)).toBe(false);

  // Reopen puts the session back on its branch, in a worktree again.
  await page.keyboard.press('Meta+Shift+t');
  await expect(sessionRow(page, /Edit then archive/)).toBeVisible();
  await expect.poll(() => existsSync(worktree)).toBe(true);
  expect(existsSync(join(worktree, 'scratch.txt'))).toBe(false);
  await expect(page.getByText(/^on edit-then-archive/)).toBeVisible();
});

const WorkstreamNotices = z.array(
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    notice: z.looseObject({ key: z.string(), line: z.string() }).nullable().optional(),
  }),
);

test('a chat goes to the builder’s terminal and back: the banner, a held message, a task that waits for it, Hand Back and the notice', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const projectId = await createProject(
    request,
    'sessions-terminal',
    [{ name: 'repo', globs: ['**'] }],
    { 'src/login.ts': 'export const login = () => null;\n' },
  );
  // Copy the Command opens no window, so the run needs no Terminal on the screen.
  const setting = async (terminalApp: 'terminal' | 'copy'): Promise<void> => {
    const saved = await request.patch(`${daemonUrl}/settings/sessions`, {
      headers: auth,
      data: { terminalApp },
    });
    expect(saved.ok()).toBe(true);
  };
  await setting('copy');
  try {
    await claudeIsInstalled(page);
    await page.addInitScript((id) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
      if (window.localStorage.getItem('mantine-color-scheme-value') === null)
        window.localStorage.setItem('mantine-color-scheme-value', 'dark');
    }, projectId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/board');
    await expect(page.getByRole('button', { name: /^Project: sessions-terminal/ })).toBeVisible();
    await page.keyboard.press('Meta+t');
    await expect(page).toHaveURL(/\/sessions\?fresh=/);

    // A reply gives the chat an agent session to resume.
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.click();
    await composer.pressSequentially('Move to the terminal');
    await composer.press('Enter');
    await expect(page.getByText('Ready for the terminal.')).toBeVisible();

    // Open in Terminal warns first; Copy the Command takes the chat and shows the banner.
    await page.getByRole('button', { name: 'Open in Terminal' }).click();
    const popover = page.getByRole('dialog', { name: 'Open in Terminal' });
    await expect(popover.getByText(/runs outside 10db's sandbox/)).toBeVisible();
    await expect(popover.getByText('Your folder is held until you hand back.')).toBeVisible();
    await popover.getByRole('button', { name: 'Copy the Command' }).click();
    const banner = page.getByRole('region', { name: 'In your terminal' });
    await expect(banner).toBeVisible();
    await expect(page.getByText(/^in your terminal since \d\d:\d\d$/)).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Hand Back' })).toBeFocused();
    await scan(page, [1280, 480], 'a chat in the terminal');

    // A message typed meanwhile is held.
    await composer.click();
    // The fake agent scripts a chat by the line it starts with, so the held message starts with it again.
    await composer.pressSequentially('Move to the terminal again');
    await composer.press('Enter');
    await expect(page.getByText('Held until you hand back', { exact: true })).toBeVisible();

    // A task that wants Your folder waits, naming the chat in the terminal.
    const made = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
      headers: auth,
      data: { title: 'Hold the folder', acceptanceCriteria: ['It holds'], areas: ['repo'] },
    });
    expect(made.ok()).toBe(true);
    const taskId = z.looseObject({ id: z.string() }).parse(await made.json()).id;
    expect((await request.post(`${daemonUrl}/tasks/${taskId}/start`, { headers: auth })).ok()).toBe(
      true,
    );
    await expect
      .poll(async () =>
        WorkstreamNotices.parse(
          await (
            await request.get(`${daemonUrl}/workstreams?active=true`, { headers: auth })
          ).json(),
        )
          .filter((w) => w.projectId === projectId)
          .flatMap((w) => (w.notice?.key === 'folder-hold' ? [w.notice.line] : [])),
      )
      .toEqual([expect.stringContaining('in your terminal')]);

    // Hand Back asks first, then gives the chat back with its notice.
    await banner.getByRole('button', { name: 'Hand Back' }).click();
    const question = page.getByRole('dialog', { name: 'Hand Back' });
    await expect(question.getByText('Is Claude Code closed in your terminal?')).toBeVisible();
    await question.getByRole('button', { name: 'Hand Back' }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByText("aren't shown here")).toBeVisible();

    // The task has the folder now; once it ends, the held message runs.
    const streams = Workstreams.parse(
      await (await request.get(`${daemonUrl}/workstreams?active=true`, { headers: auth })).json(),
    ).filter((w) => w.projectId === projectId);
    for (const stream of streams)
      await request.post(`${daemonUrl}/workstreams/${stream.id}/cancel`, { headers: auth });
    await expect(page.getByText('Back from the terminal.')).toBeVisible();
    await scan(page, [1280], 'a chat handed back');
  } finally {
    await setting('terminal');
  }
});
