import { describe, expect, it } from 'vitest';
import { mapAtMost } from './map-at-most';

describe('mapAtMost', () => {
  it.each([
    { name: 'more items than the limit', items: 20, limit: 4, peak: 4 },
    { name: 'fewer items than the limit', items: 3, limit: 8, peak: 3 },
    { name: 'no items', items: 0, limit: 8, peak: 0 },
  ])(
    '$name: never runs more than the limit at once, and keeps order',
    async ({ items, limit, peak }) => {
      let running = 0;
      let seen = 0;
      const out = await mapAtMost(
        Array.from({ length: items }, (_, i) => i),
        limit,
        async (n) => {
          running += 1;
          seen = Math.max(seen, running);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          running -= 1;
          return n * 2;
        },
      );
      expect(seen).toBe(peak);
      expect(out).toEqual(Array.from({ length: items }, (_, i) => i * 2));
    },
  );

  it('rejects with the first failure', async () => {
    await expect(
      mapAtMost([1, 2, 3], 2, (n) =>
        n === 2 ? Promise.reject(new Error('two')) : Promise.resolve(n),
      ),
    ).rejects.toThrow('two');
  });
});
