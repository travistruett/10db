import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { E2E_REPO, E2E_TOKEN } from './paths';

async function ensureProject(request: APIRequestContext) {
  const headers = { Authorization: `Bearer ${E2E_TOKEN}` };
  const listed = await request.get(`${daemonUrl}/projects`, { headers });
  const projects: unknown = await listed.json();
  if (Array.isArray(projects) && projects.length > 0) return;
  const created = await request.post(`${daemonUrl}/projects`, {
    headers,
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
}

async function expectAccessible(page: Page, label: string): Promise<void> {
  // Selenized's contrast is its own (docs/architecture/decisions/2026-10-28-selenized-exactly.md).
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
  test(`a builder allows two hosts, is refused localhost and removes them in ${scheme}`, async ({
    page,
    request,
  }) => {
    await ensureProject(request);
    await claudeIsInstalled(page);
    await page.addInitScript((value) => {
      window.localStorage.setItem('mantine-color-scheme-value', value);
    }, scheme);
    await page.goto('/settings/network-hosts');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
    const card = page.getByRole('main');
    await expect(card.getByText('No hosts are allowed yet.')).toBeVisible();

    const field = page.getByRole('textbox', { name: 'Host' });
    for (const host of ['index.crates.io', 'static.crates.io']) {
      await field.fill(host);
      await page.getByRole('button', { name: 'Add Host' }).click();
      await expect(page.getByRole('listitem').filter({ hasText: host })).toBeVisible();
    }
    await expectAccessible(page, `network hosts, ${scheme}`);

    await field.fill('localhost');
    await page.getByRole('button', { name: 'Add Host' }).click();
    await expect(page.getByRole('alert')).toContainText('Allow localhost');
    await expect(field).toHaveValue('localhost');
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await expectAccessible(page, `network hosts refusal, ${scheme}`);

    for (const host of ['index.crates.io', 'static.crates.io']) {
      await page.getByRole('button', { name: `Remove ${host}` }).click();
      await expect(page.getByRole('listitem').filter({ hasText: host })).toHaveCount(0);
    }
    await expect(card.getByText('No hosts are allowed yet.')).toBeVisible();
  });
}
