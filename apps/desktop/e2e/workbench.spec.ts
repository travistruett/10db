import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
import { inConversationColumn } from './conversation-column';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { auth, createProject } from './shape-project';

// Runs after shape.spec.ts (files run in name order with one worker); it adds its own project, on its
// own repository, and selects it. The fake adapter answers the two pages from script-book.json:
// Settings is Ready after its first turn and works on the builder's message until a second one adds to
// its turn; People asks a question first.

/**
 * An app that names its routes in code, with three views and a component they share. The project
 * starts with one area and no page; the setup makes the pages.
 */
const APP: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "workbench-app" }\n',
  'src/router.tsx': [
    "import { createRoute } from '@tanstack/react-router';",
    "import { SettingsView } from './views/settings/settings-view';",
    "import { PeopleView } from './views/people/people-view';",
    "import { BillingView } from './views/billing/billing-view';",
    "const settings = createRoute({ path: '/settings', component: SettingsView });",
    "const people = createRoute({ path: '/people', component: PeopleView });",
    "const billing = createRoute({ path: '/billing', component: BillingView });",
    '',
  ].join('\n'),
  'src/views/settings/settings-view.tsx': "import { Button } from '../../ui/button';\n",
  'src/views/people/people-view.tsx': "import { Button } from '../../ui/button';\n",
  'src/views/billing/billing-view.tsx': "import { Button } from '../../ui/button';\n",
  'src/ui/button.tsx': 'export const Button = () => null;\n',
};

const Live = z.array(z.looseObject({ pass: z.looseObject({ projectId: z.string() }) }));

/** Where the thread checks save a screenshot per width, when set. */
const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

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
    const region = document.querySelector('[aria-label="UI Workbench announcements"]');
    const said = region?.textContent ?? '';
    if (said !== '' && recorded.announced.at(-1) !== said) recorded.announced.push(said);
    for (const row of document.querySelectorAll('[aria-label="Open pages"] li')) {
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
    .getByRole('list', { name: 'Open pages' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^${area}`) }) });
}

async function queueOrder(page: Page): Promise<string[]> {
  return page
    .getByRole('list', { name: 'Open pages' })
    .getByRole('listitem')
    .evaluateAll((items) =>
      items.map((item) => item.querySelector('button span:not([data-testid])')?.textContent ?? ''),
    );
}

/** The frame's panel; `data-panel` is also a conversation's own attribute, so the frame's values are named. */
const framePanel = (page: Page) =>
  page.locator('[data-panel="column"], [data-panel="hidden"], [data-panel="sheet"]');

/** The pass's queue is drawn exactly once at any width, in the panel, the sheet or the strip. */
async function oneQueue(page: Page, width: number) {
  await expect(
    page.getByRole('list', { name: 'Open pages' }),
    `one queue at ${String(width)}`,
  ).toHaveCount(1);
}

/** Nothing on the page scrolls sideways. */
async function expectNoSideways(page: Page, width: number) {
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(sideways, `the page scrolls sideways at ${String(width)}`).toBe(false);
}

/**
 * At `width` with the panel drawn (a wide window), the panel's head holds the pass's name and its ⋯ menu
 * (Finish, Rename, Abandon) on screen, the title row names the shown page, and nothing scrolls sideways.
 */
async function panelHeadFits(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const head = framePanel(page).locator('[data-tauri-drag-region]');
  await expect(head).toContainText('Settings and People');
  const menu = await head.getByRole('button', { name: 'More actions', exact: true }).boundingBox();
  expect(menu, `the ⋯ menu is drawn in the panel's head at ${String(width)}`).not.toBeNull();
  if (menu !== null)
    expect(menu.x + menu.width, `the ⋯ menu is on screen at ${String(width)}`).toBeLessThanOrEqual(
      width,
    );
  // The title row names a page, not the pass.
  await expect(page.locator('[data-title-row]').getByRole('heading', { level: 1 })).toHaveText(
    /^(Settings|People)$/,
  );
  await oneQueue(page, width);
  await expectNoSideways(page, width);
}

/**
 * At `width` with no panel drawn (a window under 1000 px), the pass's line in the title row is drawn (cut
 * with an ellipsis when it must, its whole text in the heading's tooltip), its ⋯ menu (Close Pass, Abandon) is
 * on screen, the content box stops a gutter short of the window's edge and nothing scrolls sideways.
 */
async function headerFits(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const title = page.getByRole('heading', { level: 1, name: /· 1 signed off/ });
  await expect(title).toBeVisible();
  await expect(title).toHaveAttribute('title', /· 1 signed off/);
  const row = await page.locator('[data-title-row]').boundingBox();
  const line = await title.boundingBox();
  expect(row, `the title row is drawn at ${String(width)}`).not.toBeNull();
  expect(line, `the line is drawn at ${String(width)}`).not.toBeNull();
  if (row !== null && line !== null)
    expect(
      line.x + line.width,
      `the line stays in the title row at ${String(width)}`,
    ).toBeLessThanOrEqual(row.x + row.width);
  const menu = await page.getByRole('button', { name: 'More actions', exact: true }).boundingBox();
  expect(menu, `the ⋯ menu is drawn at ${String(width)}`).not.toBeNull();
  if (menu !== null)
    expect(menu.x + menu.width, `the ⋯ menu is on screen at ${String(width)}`).toBeLessThanOrEqual(
      width,
    );
  // The content sits in the frame's rounded box, a gutter in from the window's right edge.
  const content = await page.locator('main').boundingBox();
  expect(content, `the content is drawn at ${String(width)}`).not.toBeNull();
  if (content !== null)
    expect(
      width - (content.x + content.width),
      `the content box stops short of the window's edge at ${String(width)}`,
    ).toBeGreaterThanOrEqual(4);
  await oneQueue(page, width);
  await expectNoSideways(page, width);
}

/**
 * In a window shorter than the page's thread, the window itself never scrolls: the thread scrolls
 * inside the page, so the rail, the title row and the queue stay put and the composer stays at
 * the window's foot.
 */
async function threadScrollsInside(page: Page, region: Locator, label: string, width: number) {
  await page.setViewportSize({ width, height: 420 });
  const scrolls = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1;
  });
  expect(scrolls, `the window scrolls at ${String(width)}x420`).toBe(false);
  // A thread read at its end stays at its end as the window shrinks, as a chat does.
  const messages = region.getByRole('group', { name: 'Messages' });
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      message: `the thread keeps its newest message in view at ${String(width)}x420`,
    })
    .toBeLessThanOrEqual(2);
  const box = await region.getByRole('textbox', { name: `Message to ${label}` }).boundingBox();
  expect(box, `the composer is drawn at ${String(width)}x420`).not.toBeNull();
  if (box !== null)
    expect(
      box.y + box.height,
      `the composer is on screen at ${String(width)}x420`,
    ).toBeLessThanOrEqual(420);
  if (SHOTS !== undefined)
    await page.screenshot({ path: join(SHOTS, `e2e-workbench-thread-${String(width)}.png`) });
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
  const projectId = await createProject(
    request,
    'workbench',
    [{ name: 'repo', globs: ['**'], catchAll: true }],
    APP,
  );
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

  // No page area yet: the setup, narrow and wide, dark. Billing is left out; Apply makes the pages.
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/workbench');
  await expect(
    page.getByRole('heading', { name: 'Set up workbench for the UI Workbench' }),
  ).toBeVisible();
  const billing = page.getByRole('checkbox', { name: 'Make Billing (billing) a page at /billing' });
  await expect(billing).toBeChecked();
  await scan(page, 480, 'dark', 'setup');
  await scan(page, 1280, 'dark', 'setup');
  await billing.uncheck();
  await page.getByRole('button', { name: 'Apply' }).click();

  // The start page's list of pages, narrow and dark, then wide.
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(page.getByRole('checkbox', { name: 'Settings', exact: true })).toBeVisible();
  await scan(page, 480, 'dark', 'picker');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('checkbox', { name: 'Settings', exact: true }).check();
  await page.getByRole('checkbox', { name: 'People', exact: true }).check();
  await page.getByRole('button', { name: 'Start Pass', exact: true }).click();
  await expect(row(page, 'Settings')).toContainText('Your turn');

  // On the Board a page waiting on its first message is in no line: its drawer says where it runs,
  // with no place in line and no Run Next.
  await page.goto('/board');
  await page
    .getByRole('list', { name: 'In progress tasks' })
    .getByRole('button', { name: /^Settings/ })
    .first()
    .click();
  const status = page.getByRole('dialog', { name: 'Task' }).getByTestId('status-line');
  await expect(status.getByText('In the UI Workbench', { exact: true })).toBeVisible();
  await expect(status.getByText('runs when you write to it there')).toBeVisible();
  await expect(status.getByText(/in line/)).toHaveCount(0);
  await expect(status.getByRole('button', { name: 'Run Next' })).toHaveCount(0);
  await page.goto('/workbench');

  // The pages open waiting on the builder; each is sent its first message on its own page.
  for (const area of ['Settings', 'People']) {
    await expect(row(page, area)).toContainText('Your turn');
    await row(page, area)
      .getByRole('button', { name: new RegExp(`^${area}`) })
      .click();
    const first = page
      .getByRole('region', { name: area })
      .getByRole('textbox', { name: `Message to ${area}` });
    await first.fill('these feel cramped');
    await first.press('Meta+Enter');
  }

  // People asks, so it rises to the top of the queue; it is answered on the page.
  await expect(row(page, 'People')).toContainText('Asks a question');
  expect((await queueOrder(page))[0]).toBe('People');
  await row(page, 'People')
    .getByRole('button', { name: /^People/ })
    .click();
  const people = page.getByRole('region', { name: 'People' });
  await expect(people.getByText('Which spacing?', { exact: true })).toBeVisible();
  await people.getByRole('radio', { name: /Roomy/ }).check();
  await people.getByRole('button', { name: 'Send Answer' }).click();
  await expect(row(page, 'People')).toContainText('Ready');
  await expect(row(page, 'Settings')).toContainText('Ready');

  // A Ready page selected: axe at both widths, dark then light.
  await row(page, 'Settings')
    .getByRole('button', { name: /^Settings/ })
    .click();
  const settings = page.getByRole('region', { name: 'Settings' });
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
  const message = settings.getByRole('textbox', { name: 'Message to Settings' });
  const chooser = page.waitForEvent('filechooser');
  await settings.getByRole('button', { name: 'Add Picture' }).click();
  await (await chooser).setFiles({ name: 'cramped.png', mimeType: 'image/png', buffer: PICTURE });
  await expect(settings.getByRole('list', { name: 'Pictures to send' })).toContainText(
    'cramped.png',
  );
  await message.fill('padding too tight');
  await message.press('Meta+Enter');
  await expect(settings.getByRole('img', { name: 'cramped.png' })).toBeVisible();
  await expect(row(page, 'Settings')).toContainText('Working');
  await expect(settings.getByRole('button', { name: 'Show Log' })).toBeVisible();
  await expect(settings.getByText(/settings\/page\.tsx/).first()).toBeVisible();

  // A word added to the working turn ends it; Ready again, with the files turn 2 changed.
  await message.fill('the header too');
  await message.press('Meta+Enter');
  await expect(row(page, 'Settings')).toContainText('Ready');
  await expect(settings.getByText('Loosened the padding.')).toBeVisible();
  await expect(
    settings.getByRole('list', { name: 'Files this turn changed' }).last(),
  ).toContainText('src/views/settings/page.tsx');

  // Two turns outgrow a short window: the thread scrolls inside the page, never the window.
  for (const width of [1280, 480]) await threadScrollsInside(page, settings, 'Settings', width);
  await page.setViewportSize({ width: 1280, height: 900 });
  await inConversationColumn(settings, message, 'the Workbench at 1280');

  // Sign Off: "Signing off…", then green "Signed off".
  await settings.getByRole('button', { name: 'Sign Off' }).click();
  await expect(row(page, 'Settings')).toContainText('Signed off');
  await expect(row(page, 'Settings').getByTestId('status-dot')).toHaveAttribute(
    'data-color',
    'green',
  );
  const seen = await recorded(page);
  expect(seen.rowLines.some((line) => line.includes('Signing off…'))).toBe(true);
  announced.push(...seen.announced);

  // The project has no origin, so no pull request can be opened: no Open Draft PR is drawn anywhere, and
  // the foot of the signed-off page, where the builder is, says why. The header fits at every width.
  await expect(page.getByText(/^Signed off\. No pull request yet: /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Draft PR' })).toHaveCount(0);
  await panelHeadFits(page, 1280);
  for (const width of [900, 520, 420]) await headerFits(page, width);
  // At 900 the queue is the strip until the sheet opens, and it is drawn once in the sheet too. A page picked
  // there with the pointer closes the sheet and takes the cursor in its composer, not on its strip row.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.keyboard.press('Meta+Backslash');
  await oneQueue(page, 900);
  await expect(framePanel(page).getByRole('list', { name: 'Open pages' })).toBeVisible();
  await row(page, 'People')
    .getByRole('button', { name: /^People/ })
    .click();
  await expect(page.getByRole('textbox', { name: 'Message to People' })).toBeFocused();
  await oneQueue(page, 900);
  // A wide window always shows the panel: ⌘\ leaves it a column, so it can never be lost.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(framePanel(page)).toHaveAttribute('data-panel', 'column');
  await page.keyboard.press('Meta+Backslash');
  await expect(framePanel(page)).toHaveAttribute('data-panel', 'column');
  await panelHeadFits(page, 1280);

  // A reload keeps the queue as it was.
  const before = await queueOrder(page);
  await page.reload();
  await expect(row(page, 'Settings')).toContainText('Signed off');
  expect(await queueOrder(page)).toEqual(before);

  // The live region said only pages becoming ready and the question.
  const said = announced.flatMap((text) => text.split('. '));
  expect(said).toContain('Settings is ready');
  expect(
    said.filter((line) => !/^(Settings|People) (is ready|asks a question)$/.test(line)),
  ).toEqual([]);

  // Abandon ends the pass: its confirm names, by label, the page whose changes it deletes and the one
  // that stays. Later specs read Factory across projects, so nothing of this pass is left running.
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Abandon' }).click();
  const abandon = page.getByRole('dialog', { name: 'Abandon' });
  await expect(abandon.getByText('Discards: People (their changes are deleted).')).toBeVisible();
  await expect(abandon.getByText('Stays: Settings (signed off).')).toBeVisible();
  await abandon.getByRole('button', { name: 'Abandon' }).click();
  await expect(page.getByRole('button', { name: 'Start Pass', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const live = await request.get(`${daemonUrl}/passes?live=true`, { headers: auth });
      return Live.parse(await live.json()).filter((view) => view.pass.projectId === projectId);
    })
    .toEqual([]);
});
