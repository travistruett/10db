import { describe, expect, it } from 'vitest';
import { queueOrder, type QueueEntry } from './run-next';

const entry = (id: string, createdAt: string, runNextAt: string | null = null): QueueEntry => ({
  id,
  createdAt,
  runNextAt,
});

describe('queueOrder', () => {
  it.each([
    {
      name: 'started earlier first',
      first: entry('b', '2026-10-29T10:00:00.000Z'),
      second: entry('a', '2026-10-29T11:00:00.000Z'),
    },
    {
      name: 'the id when started together',
      first: entry('a', '2026-10-29T10:00:00.000Z'),
      second: entry('b', '2026-10-29T10:00:00.000Z'),
    },
    {
      name: 'a pushed one before an older one that was not',
      first: entry('z', '2026-10-29T12:00:00.000Z', '2026-10-29T12:30:00.000Z'),
      second: entry('a', '2026-10-29T09:00:00.000Z'),
    },
    {
      name: 'the later press before the earlier',
      first: entry('a', '2026-10-29T09:00:00.000Z', '2026-10-29T13:00:00.000Z'),
      second: entry('b', '2026-10-29T10:00:00.000Z', '2026-10-29T12:30:00.000Z'),
    },
    {
      name: 'the later id on a tied press',
      first: entry('b', '2026-10-29T09:00:00.000Z', '2026-10-29T13:00:00.000Z'),
      second: entry('a', '2026-10-29T09:00:00.000Z', '2026-10-29T13:00:00.000Z'),
    },
  ])('puts $name', ({ first, second }) => {
    expect(queueOrder(first, second)).toBeLessThan(0);
    expect(queueOrder(second, first)).toBeGreaterThan(0);
  });

  it('treats an entry as equal to itself', () => {
    const a = entry('a', '2026-10-29T10:00:00.000Z', '2026-10-29T12:00:00.000Z');
    expect(queueOrder(a, a)).toBe(0);
  });
});
