import { expect, type Locator } from '@playwright/test';

/** The widest a conversation's column is drawn, on every screen that holds one. */
const COLUMN_MAX = 720;

/**
 * Every conversation (Sessions, Plan, the Workbench) is one column at most 720 px wide, centred in the
 * space its screen gives it, with the composer at its foot: the composer's frame shows where it is.
 */
export async function inConversationColumn(space: Locator, input: Locator, what: string) {
  const frame = input.locator('xpath=ancestor::*[@data-composer-frame][1]');
  const outer = await space.boundingBox();
  const box = await frame.boundingBox();
  expect(outer, `${what}: its space is drawn`).not.toBeNull();
  expect(box, `${what}: its composer is drawn`).not.toBeNull();
  if (outer === null || box === null) return;
  expect(box.width, `${what}: the composer is no wider than the column`).toBeLessThanOrEqual(
    COLUMN_MAX,
  );
  const left = box.x - outer.x;
  const right = outer.x + outer.width - (box.x + box.width);
  expect(Math.abs(left - right), `${what}: the column is centred`).toBeLessThanOrEqual(2);
}
