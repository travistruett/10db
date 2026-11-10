import { describe, expect, it } from 'vitest';
import { nextNotificationId, notificationIdSeed } from './notify-pass';

// A banner from before a reload can still be clicked: its id must not name a page notified after it.

const MAX_ID = 2 ** 31 - 1;

describe('notification ids', () => {
  it.each([
    { name: 'a load a minute after another', first: 1_762_700_000_000, second: 1_762_700_060_000 },
    { name: 'a load a second after another', first: 1_762_700_000_000, second: 1_762_700_001_000 },
  ])('start somewhere else on $name', ({ first, second }) => {
    expect(notificationIdSeed(first)).not.toBe(notificationIdSeed(second));
  });

  it.each([0, 1_762_700_000_000, 2 ** 31, Number.MAX_SAFE_INTEGER])(
    'start inside the native id range (1 to 2^31 - 1) at %d',
    (now) => {
      const id = notificationIdSeed(now);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(MAX_ID);
    },
  );

  it('go on from the largest id back to 1', () => {
    expect(nextNotificationId(7)).toBe(8);
    expect(nextNotificationId(MAX_ID)).toBe(1);
  });
});
