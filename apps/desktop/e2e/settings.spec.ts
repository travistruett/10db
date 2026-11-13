import { expect, test } from '@playwright/test';
import { expectAccessible } from './expect-accessible';

const SCOPES = 'Settings scope';
const SERVICES = ['GitHub', 'Slack', 'Artificial Analysis'] as const;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
});

test.describe('Settings', () => {
  test('the scope switch shows one scope at a time, under subheads, and the app scope fits unscrolled', async ({
    page,
  }) => {
    await page.goto('/settings/overview');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const scope = page.getByRole('radiogroup', { name: SCOPES });
    await expect(scope.getByRole('radio', { name: 'All projects' })).toBeChecked();

    for (const subhead of ['Models', 'Agents', 'Connections', 'This Mac']) {
      await expect(nav.getByRole('group', { name: subhead })).toBeVisible();
    }
    for (const link of ['Overview', 'Accounts', 'Integrations', 'People', 'Updates']) {
      await expect(nav.getByRole('link', { name: link })).toBeVisible();
    }
    // The project's sections are the other scope's.
    await expect(nav.getByRole('link', { name: 'Board columns' })).toHaveCount(0);
    // The last app-wide link is inside the window, so the list needs no scrolling.
    const keepAwake = await nav.getByRole('link', { name: 'Keep-awake' }).boundingBox();
    expect(keepAwake).not.toBeNull();
    expect((keepAwake?.y ?? Infinity) + (keepAwake?.height ?? 0)).toBeLessThanOrEqual(720);

    await scope.getByText('This project').click();
    await expect(page).toHaveURL(/\/settings\/general/);
    for (const subhead of ['Project', 'Planning', 'Agents']) {
      await expect(nav.getByRole('group', { name: subhead })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Board columns' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Accounts' })).toHaveCount(0);

    await scope.getByText('All projects').click();
    await expect(page).toHaveURL(/\/settings\/overview/);
  });

  test('Overview answers whether anything is broken and has a row per account and service', async ({
    page,
  }) => {
    await page.goto('/settings/overview');
    const main = page.getByRole('main');
    // A row's link reads its name then its state; the summary line's links read the name alone.
    const row = (name: string) => main.getByRole('link', { name: new RegExp(`^${name}\\s.+`) });
    await expect(main.getByText(/connections? work|needs? you|need you/).first()).toBeVisible();
    for (const group of ['Model access', 'Services', 'Data and downloads']) {
      await expect(main.getByRole('heading', { name: group })).toBeVisible();
    }
    // The default account always exists.
    await expect(row('Claude plan')).toBeVisible();
    for (const service of SERVICES) {
      await expect(row(service)).toBeVisible();
    }
    // The e2e daemon starts with benchmarks and Slack off; the rows say so.
    await expect(row('Artificial Analysis')).toContainText('TENDB_BENCHMARKS=off');
    await expect(row('Slack')).toContainText('TENDB_SLACK=off');
    await expectAccessible(page, 'settings overview');
  });

  test('Integrations shows GitHub, Slack and Artificial Analysis, in that order', async ({
    page,
  }) => {
    await page.goto('/settings/integrations');
    const cards = page.getByRole('main').getByRole('group');
    for (const [i, name] of SERVICES.entries()) {
      await expect(cards.nth(i)).toHaveAccessibleName(name);
    }
    await expect(cards).toHaveCount(SERVICES.length);
    await expectAccessible(page, 'settings integrations');
  });

  test("Decisions shows Runs on's empty state with Add OpenRouter Account, which opens Add Account on that kind", async ({
    page,
  }) => {
    await page.goto('/settings/decisions');
    const main = page.getByRole('main');
    await expect(main.getByText('No account can run decisions yet.')).toBeVisible();
    await main.getByRole('button', { name: 'Add OpenRouter Account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Account' });
    await expect(dialog.getByRole('textbox', { name: 'OpenRouter key' })).toBeVisible();
    await expect(
      dialog.getByRole('checkbox', { name: 'Run decisions on this account' }),
    ).toBeChecked();
    await expectAccessible(page, 'settings decisions');
  });
});
