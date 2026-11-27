import { expect, test } from 'vitest';
import { ManualClock } from '../clock';
import { STOP_DEADLINE_MS, stopWithin } from './stop-within';

test('a shutdown that never ends is given up on at the deadline, and one that ends is not', async () => {
  const clock = new ManualClock();
  const calls: string[] = [];
  const outcome = {
    clock,
    deadlineMs: STOP_DEADLINE_MS,
    onStopped: () => calls.push('stopped'),
    onLate: () => calls.push('late'),
  };

  stopWithin(() => new Promise(() => undefined), outcome);
  clock.advance(STOP_DEADLINE_MS - 1);
  expect(calls).toEqual([]);
  clock.advance(1);
  expect(calls).toEqual(['late']);

  stopWithin(() => Promise.resolve(), outcome);
  await Promise.resolve();
  clock.advance(STOP_DEADLINE_MS);
  expect(calls).toEqual(['late', 'stopped']);
});
