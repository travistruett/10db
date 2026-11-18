import { expect, type Locator } from '@playwright/test';

/** The widest a conversation's column is drawn, on every screen that holds one. */
const COLUMN_MAX = 720;

/**
 * Every conversation (Sessions, Plan, the Workbench) is one column at most 720 px wide, centred in the
 * space its screen gives it, with the composer at its foot: the composer's frame shows where it is.
 */
export async function inConversationColumn(space: Locator, input: Locator, what: string) {
  const frame = input.locator('xpath=ancestor::*[@data-composer-frame][1]');
  // The frame re-measures its container after a resize, so the column settles a moment later.
  await expect
    .poll(
      async () => {
        const outer = await space.boundingBox();
        const box = await frame.boundingBox();
        if (outer === null || box === null) return Number.POSITIVE_INFINITY;
        if (box.width > COLUMN_MAX) return Number.POSITIVE_INFINITY;
        const left = box.x - outer.x;
        const right = outer.x + outer.width - (box.x + box.width);
        return Math.abs(left - right);
      },
      { message: `${what}: the column is centred and no wider than ${String(COLUMN_MAX)} px` },
    )
    .toBeLessThanOrEqual(2);
}
