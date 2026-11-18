import { expect, test, type Page } from '@playwright/test';

// The frame every screen sits in: the rail opens each section, ⌘\ folds Settings' panel, and a narrow window
// opens the rail and panel over the content. It creates nothing, so it reads the projects earlier specs made.

const SECTIONS = [
  { name: 'Inbox', path: '/inbox' },
  { name: 'Factory', path: '/factory' },
  { name: 'Sessions', path: '/sessions' },
  { name: 'Board', path: '/board' },
  { name: 'Plan', path: '/shape' },
  { name: 'UI Workbench', path: '/workbench' },
  { name: 'Knowledge', path: '/knowledge' },
  { name: 'Settings', path: '/settings/' },
] as const;

const panelOf = (page: Page) => page.locator('[data-panel]');

test('every rail item opens its section and marks it as the open one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/factory');
  const rail = page.getByRole('navigation', { name: 'Sections', exact: true });
  for (const { name, path } of SECTIONS) {
    await rail.getByRole('link', { name: new RegExp(`^${name}\\s*(\\d+ .*)?$`) }).click();
    await expect(page).toHaveURL(new RegExp(path));
    await expect(rail.locator('a[data-rail-item][aria-current="page"]')).toContainText(name);
  }
});

test('⌘\\ folds and shows the Settings panel at 1280, and the choice survives a reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings/overview');
  await expect(panelOf(page)).toHaveAttribute('data-panel', 'column');
  await page.keyboard.press('Meta+Backslash');
  await expect(panelOf(page)).toHaveAttribute('data-panel', 'hidden');
  await page.reload();
  await expect(panelOf(page)).toHaveAttribute('data-panel', 'hidden');
  await page.keyboard.press('Meta+Backslash');
  await expect(panelOf(page)).toHaveAttribute('data-panel', 'column');
});

test('at 600 px the button opens the panel over the content and Esc closes it; at 480 px it opens the rail too', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/settings/overview');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: 'Show the panel' }).click();
  await expect(nav).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();

  await page.setViewportSize({ width: 480, height: 800 });
  const rail = page.getByRole('navigation', { name: 'Sections', exact: true });
  await expect(rail).toBeHidden();
  await page.getByRole('button', { name: 'Show the panel' }).click();
  await expect(rail).toBeVisible();
  await expect(nav).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail).toBeHidden();
});

test('at 800 px the open panel sheet sits flush against the rail, below the title row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto('/settings/overview');
  await page.getByRole('button', { name: 'Show the panel' }).click();
  const box = await panelOf(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeCloseTo(52, 0);
  expect(box?.y).toBeCloseTo(44, 0);
});
