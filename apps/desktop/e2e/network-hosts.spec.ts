import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
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

const SAVED_SEEN = '__savedSeen';

/**
 * Starts recording whether the save bar says Saved. The bar says it for a couple of seconds, and a poll
 * on a slow machine can miss that; the recorder cannot. Call it before the action that saves.
 */
async function recordSaved(page: Page): Promise<() => Promise<void>> {
  await page.evaluate((key) => {
    const mark = () => {
      const said = [...document.querySelectorAll('[role="status"]')].some(
        (el) => el.textContent.trim() === 'Saved',
      );
      if (said) Reflect.set(window, key, true);
    };
    Reflect.set(window, key, false);
    new MutationObserver(mark).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    mark();
  }, SAVED_SEEN);
  return async () => {
    await expect
      .poll(() => page.evaluate((key) => Reflect.get(window, key) === true, SAVED_SEEN))
      .toBe(true);
  };
}

// Core flow 10, with process-per-rigor.spec.ts: a setting the builder changes in Settings that changes
// what an agent may do, here which hosts a project's sandbox lets it reach.
test('a builder allows two hosts, is refused localhost and removes them', async ({
  page,
  request,
}) => {
  await ensureProject(request);
  await claudeIsInstalled(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('mantine-color-scheme-value', 'dark');
  });
  await page.goto('/settings/network-hosts');
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  const card = page.getByRole('main');
  await expect(card.getByText('No Hosts Allowed Yet')).toBeVisible();
  // The project's sandbox permissions sit above the hosts.
  await expect(page.getByRole('switch', { name: 'Allow Docker' })).toBeVisible();

  const field = page.getByRole('textbox', { name: 'Host' });
  for (const host of ['index.crates.io', 'static.crates.io']) {
    await field.fill(host);
    await page.getByRole('button', { name: 'Add Host' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: host })).toBeVisible();
  }
  await expectAccessible(page, 'network hosts');

  await field.fill('localhost');
  await page.getByRole('button', { name: 'Add Host' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Allow localhost' })).toBeVisible();
  await expect(field).toHaveValue('localhost');
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await expectAccessible(page, 'network hosts refusal');

  for (const host of ['index.crates.io', 'static.crates.io']) {
    await page.getByRole('button', { name: `Remove ${host}` }).click();
    await expect(page.getByRole('listitem').filter({ hasText: host })).toHaveCount(0);
  }
  await expect(card.getByText('No Hosts Allowed Yet')).toBeVisible();

  // App Preview holds where the app runs and how its pictures are taken. Its fields wait for the save
  // bar, which shows only while Save would send something; Discard puts the field back.
  await page.goto('/settings/pages-and-pictures');
  const preview = page.getByRole('textbox', { name: 'Preview Command' });
  const unsaved = page.getByText('Unsaved changes');
  await expect(preview).toHaveValue('');
  await expect(unsaved).toHaveCount(0);
  await preview.fill('pnpm dev');
  await expect(unsaved).toBeVisible();
  await expectAccessible(page, 'app preview');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(preview).toHaveValue('');
  await expect(unsaved).toHaveCount(0);
  // A value saved with a trailing space leaves nothing unsaved, so leaving does not ask.
  await preview.fill('pnpm dev ');
  const savedPreview = await recordSaved(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await savedPreview();
  await expect(unsaved).toHaveCount(0);
  await page.getByRole('link', { name: 'Sharing' }).click();
  await expect(page).toHaveURL(/\/settings\/sharing$/);
  await expect(page.getByRole('dialog', { name: 'Discard Your Changes?' })).toHaveCount(0);

  // Sharing holds Pictures in Pull Requests and the Slack post; this daemon runs with Slack off. A page
  // of switches saves each at once, with no bar to press.
  const pictures = page.getByRole('switch', { name: 'Pictures in Pull Requests' });
  await expect(pictures).toBeVisible();
  const picturesOn = await pictures.isChecked();
  const savedPictures = await recordSaved(page);
  await pictures.click({ force: true });
  await savedPictures();
  await expect(unsaved).toHaveCount(0);
  await page.reload();
  await expect(pictures).toBeChecked({ checked: !picturesOn });
  await pictures.click({ force: true });
  await expect(pictures).toBeChecked({ checked: picturesOn });
  await expect(page.getByRole('switch', { name: 'Post Pictures to Slack' })).toBeDisabled();
  await expect(page.getByText('Slack is turned off in this copy of 10db.')).toBeVisible();
  await expectAccessible(page, 'sharing');

  // DEBUG (not for merge): repeat the Sharing -> App Preview -> clear -> Save step to catch the flake.
  page.on('console', (m) => {
    if (m.text().startsWith('DBG')) console.log(Date.now() % 100000, m.text());
  });
  for (let round = 0; round < 10; round += 1) {
    console.log(Date.now() % 100000, 'TEST round', round);
    await page.getByRole('link', { name: 'App Preview' }).click();
    await preview.fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(unsaved).toHaveCount(0);
    await preview.fill('pnpm dev ');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(unsaved).toHaveCount(0);
    await page.getByRole('link', { name: 'Sharing' }).click();
    await pictures.click({ force: true });
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  }
  await page.getByRole('link', { name: 'App Preview' }).click();
  await preview.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(unsaved).toHaveCount(0);
});
