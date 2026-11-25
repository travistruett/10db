import { describe, expect, it } from 'vitest';
import { GATE_TIMEOUT_CAP_MS, gateTimeoutMs } from './gate-timeout';

const MIN = 60_000;
const FLOOR = 30 * MIN;

describe('gateTimeoutMs', () => {
  it.each([
    ['no history keeps the floor', [], FLOOR],
    ['twice the typical pass', [25 * MIN, 20 * MIN, 22 * MIN], 44 * MIN],
    ['one outlier does not move the typical pass', [10 * MIN, 12 * MIN, 90 * MIN], FLOOR],
    ['a quick suite never goes under the floor', [3 * MIN, 5 * MIN], FLOOR],
    ['a very slow suite is capped', [90 * MIN, 100 * MIN], GATE_TIMEOUT_CAP_MS],
  ])('%s', (_name, history, expected) => {
    expect(gateTimeoutMs(history, FLOOR)).toBe(expected);
  });
});
