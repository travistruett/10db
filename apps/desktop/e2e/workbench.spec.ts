import { createServer } from 'node:net';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { auth, createProject } from './shape-project';

// Runs after shape.spec.ts (files run in name order with one worker); it adds its own project, on its
// own repository, and selects it. The fake adapter answers the two pages from script-book.json:
// Settings is Ready after its first turn and works on the builder's message until a second one adds to
// its turn; People asks a question first.

const AREAS = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'repo', globs: ['**'], catchAll: true, role: 'shared' },
] as const;

const Live = z.array(z.looseObject({ pass: z.looseObject({ projectId: z.string() }) }));

/** A real 1×1 PNG, as a screenshot pasted into the composer would be. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A loopback port nothing listens on: the project's app address, which this spec never opens. */
async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no TCP port'));
        else resolve(address.port);
      });
    });
  });
}

/** What the page recorded since it loaded: the announcer's messages and every queue row's lines. */
interface Recorded {
  readonly announced: string[];
  readonly rowLines: string[];
}

/**
 * Records, from the page's first paint, each message the Workbench's live region says and each line
 * a queue row shows, however briefly: a sign-off that lands at once shows "Signing off…" for a moment.
 */
function record(): void {
  const recorded: Recorded = { announced: [], rowLines: [] };
  Object.assign(window, { recorded });
  new MutationObserver(() => {
    const region = document.querySelector('[aria-label="Workbench announcements"]');
    const said = region?.textContent ?? '';
    if (said !== '' && recorded.announced.at(-1) !== said) recorded.announced.push(said);
    for (const row of document.querySelectorAll('[aria-label="Pages in this pass"] li')) {
      const line = row.textContent;
      if (!recorded.rowLines.includes(line)) recorded.rowLines.push(line);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

async function recorded(page: Page): Promise<Recorded> {
  // The page's own record, read back as it was written.
  return page.evaluate(() => (window as unknown as { recorded: Recorded }).recorded);
}

/** The queue's row for a page. */
function row(page: Page, area: string): Locator {
  return page
    .getByRole('list', { name: 'Pages in this pass' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^${area}`) }) });
}

async function queueOrder(page: Page): Promise<string[]> {
  return page
    .getByRole('list', { name: 'Pages in this pass' })
    .getByRole('listitem')
    .evaluateAll((items) =>
      items.map((item) => item.querySelector('button span:not([data-testid])')?.textContent ?? ''),
    );
}

async function scan(page: Page, width: number, scheme: 'dark' | 'light', what: string) {
  await page.setViewportSize({ width, height: 900 });
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
  await expectAccessible(page, `${what}, ${String(width)} ${scheme}`);
}

test('opens a pass on two pages, answers one in place, sends a picture to the other, signs it off, and every view passes axe', async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, 'workbench', AREAS);
  const patched = await request.patch(`${daemonUrl}/projects/${projectId}`, {
    headers: auth,
    data: { appUrl: `http://127.0.0.1:${String(await unusedPort())}` },
  });
  expect(patched.ok()).toBe(true);

  await claudeIsInstalled(page);
  await page.addInitScript((id) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
    // Dark first; a reload later keeps the scheme the spec switched to.
    if (window.localStorage.getItem('mantine-color-scheme-value') === null)
      window.localStorage.setItem('mantine-color-scheme-value', 'dark');
  }, projectId);
  await page.addInitScript(record);
  const announced: string[] = [];

  // The picker, narrow and dark.
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/workbench');
  await expect(page.getByRole('checkbox', { name: 'settings' })).toBeVisible();
  await scan(page, 480, 'dark', 'picker');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('checkbox', { name: 'settings' }).check();
  await page.getByRole('checkbox', { name: 'people' }).check();
  await page.getByRole('textbox', { name: "What's bothering you?" }).fill('these feel cramped');
  await page.getByRole('button', { name: 'Start Pass (2)' }).click();

  // People asks, so it rises to the top of the queue; it is answered on the page.
  await expect(row(page, 'people')).toContainText('Asks a question');
  expect((await queueOrder(page))[0]).toBe('people');
  await row(page, 'people')
    .getByRole('button', { name: /^people/ })
    .click();
  const people = page.getByRole('region', { name: 'people' });
  await expect(people.getByText('Which spacing?')).toBeVisible();
  await people.getByRole('radio', { name: /Roomy/ }).check();
  await people.getByRole('button', { name: 'Send answer' }).click();
  await expect(row(page, 'people')).toContainText('Ready');
  await expect(row(page, 'settings')).toContainText('Ready');

  // A Ready page selected: axe at both widths, dark then light.
  await row(page, 'settings')
    .getByRole('button', { name: /^settings/ })
    .click();
  const settings = page.getByRole('region', { name: 'settings' });
  await expect(settings.getByText('Tidied the settings form.')).toBeVisible();
  await scan(page, 1280, 'dark', 'pass open, a Ready page');
  await scan(page, 480, 'dark', 'pass open, a Ready page');
  announced.push(...(await recorded(page)).announced);
  await page.evaluate(() => {
    window.localStorage.setItem('mantine-color-scheme-value', 'light');
  });
  await page.reload();
  await expect(settings.getByText('Tidied the settings form.')).toBeVisible();
  await scan(page, 480, 'light', 'pass open, a Ready page');
  await scan(page, 1280, 'light', 'pass open, a Ready page');

  // A message with a picture: the picture is drawn with its file name, and the page works.
  const message = settings.getByRole('textbox', { name: 'Message to settings' });
  const chooser = page.waitForEvent('filechooser');
  await settings.getByRole('button', { name: 'Add Picture' }).click();
  await (await chooser).setFiles({ name: 'cramped.png', mimeType: 'image/png', buffer: PICTURE });
  await expect(settings.getByRole('list', { name: 'Pictures to send' })).toContainText(
    'cramped.png',
  );
  await message.fill('padding too tight');
  await message.press('Meta+Enter');
  await expect(settings.getByRole('img', { name: 'cramped.png' })).toBeVisible();
  await expect(row(page, 'settings')).toContainText('Working');
  await expect(settings.getByRole('button', { name: 'Show Log' })).toBeVisible();
  await expect(settings.getByText(/settings\/page\.tsx/).first()).toBeVisible();

  // A word added to the working turn ends it; Ready again, with the files turn 2 changed.
  await message.fill('the header too');
  await message.press('Meta+Enter');
  await expect(row(page, 'settings')).toContainText('Ready');
  await expect(settings.getByText('Loosened the padding.')).toBeVisible();
  await expect(
    settings.getByRole('list', { name: 'Files this turn changed' }).last(),
  ).toContainText('src/settings/page.tsx');

  // Sign Off: "Signing off…", then green "Signed off".
  await settings.getByRole('button', { name: 'Sign Off' }).click();
  await expect(row(page, 'settings')).toContainText('Signed off');
  await expect(row(page, 'settings').getByTestId('status-dot')).toHaveAttribute(
    'data-color',
    'green',
  );
  const seen = await recorded(page);
  expect(seen.rowLines.some((line) => line.includes('Signing off…'))).toBe(true);
  announced.push(...seen.announced);

  // A reload keeps the queue as it was.
  const before = await queueOrder(page);
  await page.reload();
  await expect(row(page, 'settings')).toContainText('Signed off');
  expect(await queueOrder(page)).toEqual(before);

  // The live region said only pages becoming ready and the question.
  const said = announced.flatMap((text) => text.split('. '));
  expect(said).toContain('settings is ready');
  expect(
    said.filter((line) => !/^(settings|people) (is ready|asks a question)$/.test(line)),
  ).toEqual([]);

  // Abandon ends the pass: its confirm names the page that goes back and the one that stays. Later
  // specs read Factory across projects, so nothing of this pass is left running.
  await page.getByRole('button', { name: 'More pass actions' }).click();
  await page.getByRole('menuitem', { name: 'Abandon Pass…' }).click();
  const abandon = page.getByRole('dialog', { name: 'Abandon Pass' });
  await expect(abandon.getByRole('list', { name: 'Pages that go back' })).toHaveText('people');
  await expect(abandon.getByRole('list', { name: 'Pages that stay' })).toHaveText('settings');
  await abandon.getByRole('button', { name: 'Abandon Pass' }).click();
  await expect(page.getByRole('button', { name: /^Start Pass/ })).toBeVisible();
  await expect
    .poll(async () => {
      const live = await request.get(`${daemonUrl}/passes?live=true`, { headers: auth });
      return Live.parse(await live.json()).filter((view) => view.pass.projectId === projectId);
    })
    .toEqual([]);
});
