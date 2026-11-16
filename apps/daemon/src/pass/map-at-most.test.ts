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

  it('keeps item order when an earlier item finishes last', async () => {
    const { promise: first, resolve: releaseFirst } = Promise.withResolvers<undefined>();
    const out = await mapAtMost([0, 1, 2], 2, async (n) => {
      if (n === 0) await first;
      else if (n === 2) releaseFirst(undefined);
      return n;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('starts no more items once one has failed', async () => {
    const started: number[] = [];
    await expect(
      mapAtMost([0, 1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        if (n === 0) throw new Error('zero');
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        return n;
      }),
    ).rejects.toThrow('zero');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(started).toEqual([0, 1]);
  });
});
