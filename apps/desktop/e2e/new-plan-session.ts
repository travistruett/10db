import { expect, type Page } from '@playwright/test';

/** Opens Sessions and starts a New Plan; the panel is open and empty. */
export async function openNewPlan(page: Page): Promise<void> {
  await page.goto('/sessions');
  await startNewPlan(page);
}

/**
 * Starts a New Plan on the page that is open with ⌘⇧N, which works whatever the screen shows: an open Plan
 * panel folds the Sessions panel, and its New menu with it.
 */
export async function startNewPlan(page: Page): Promise<void> {
  // The key finds a project to open the tab in only once the projects are read.
  await expect(page.getByRole('button', { name: /^Project: / })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  // The screen hears its keys once it has mounted them, so the press is repeated until it is heard.
  await expect(async () => {
    await page.keyboard.press('Meta+Shift+n');
    await expect(page).toHaveURL(/\/sessions\?fresh=/, { timeout: 2000 });
  }).toPass();
  await expect(page.getByRole('complementary', { name: 'Plan' })).toBeVisible();
}

/** Sends a line from a session's composer. */
export async function sendLine(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.keyboard.press('Enter');
}
