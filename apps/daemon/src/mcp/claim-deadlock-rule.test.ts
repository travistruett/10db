import { describe, expect, it } from 'vitest';
import { DEADLOCK_YIELD_AFTER_MS, DeadlockMove, deadlockMove } from './claim-deadlock-rule';

const at = DEADLOCK_YIELD_AFTER_MS;

describe('deadlockMove', () => {
  it.each([
    [
      'a rule set to ask cards before 2 minutes',
      { asking: true, ageMs: 0, breaks: 0, gives: 1 },
      DeadlockMove.Card,
    ],
    [
      'under 2 minutes waits',
      { asking: false, ageMs: at - 1, breaks: 0, gives: 1 },
      DeadlockMove.Wait,
    ],
    [
      'nothing to give up waits at any count',
      { asking: false, ageMs: at, breaks: 5, gives: 0 },
      DeadlockMove.Wait,
    ],
    [
      'a first deadlock yields',
      { asking: false, ageMs: at, breaks: 0, gives: 1 },
      DeadlockMove.Yield,
    ],
    [
      'a second yields and queues',
      { asking: false, ageMs: at, breaks: 1, gives: 1 },
      DeadlockMove.YieldAndQueue,
    ],
    [
      'a third also reports',
      { asking: false, ageMs: at, breaks: 2, gives: 1 },
      DeadlockMove.YieldQueueAndReport,
    ],
    [
      'a later one still reports',
      { asking: false, ageMs: at, breaks: 7, gives: 2 },
      DeadlockMove.YieldQueueAndReport,
    ],
  ])('%s', (_name, input, expected) => {
    expect(deadlockMove(input)).toBe(expected);
  });
});
