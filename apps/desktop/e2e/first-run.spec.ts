import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { E2E_REPO } from './paths';

// Runs before loop.spec.ts (files run in name order with one worker), which creates the project this
// spec must not: the first run shows only while the daemon has none.

async function expectAccessible(page: Page, label: string): Promise<void> {
  // The palette is Selenized exactly, so its contrast is Selenized's, not a WCAG ratio
  // (docs/architecture/decisions/2026-10-28-selenized-exactly.md). Every other rule still runs.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast'])
    .analyze();
  const found = results.violations.map(
    (v) => `${label}: ${v.id} (${v.help}) on ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(found).toEqual([]);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`the first run's three steps have no accessibility violations in ${scheme}`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      window.localStorage.setItem('mantine-color-scheme-value', value);
    }, scheme);
    await claudeIsInstalled(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);

    await expect(page.getByRole('heading', { name: 'Welcome to 10db' })).toBeVisible();
    await expectAccessible(page, `welcome, ${scheme}`);

    await page.getByRole('button', { name: 'Get Started' }).click();
    await expect(page.getByRole('heading', { name: 'Check your setup' })).toBeVisible();
    await expect(page.getByText(/^Tasks will run as /)).toBeVisible();
    await expectAccessible(page, `check your setup, ${scheme}`);

    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('textbox', { name: 'Folder path' }).fill(E2E_REPO);
    await page.getByRole('textbox', { name: 'Folder path' }).press('Enter');
    await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
    await expectAccessible(page, `add a project, ${scheme}`);
  });
}
