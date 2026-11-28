import { describe, expect, it } from 'vitest';
import { failureSignature, gateFailureAction, type GateFailureAction } from './gate-failure-action';
import type { GateFix } from './gate-fix';

const fix = (overrides: Partial<GateFix> = {}): GateFix => ({
  count: 0,
  allowed: 3,
  signature: null,
  forceInside: false,
  ...overrides,
});

const input = (overrides: Partial<Parameters<typeof gateFailureAction>[0]> = {}) => ({
  outside: false,
  reran: false,
  eligible: true,
  signature: 's',
  fix: fix(),
  ...overrides,
});

describe('gateFailureAction', () => {
  it.each<[string, Parameters<typeof gateFailureAction>[0], GateFailureAction]>([
    [
      '1: an outside failure reruns first, even for a batch that is not eligible',
      input({ outside: true, eligible: false }),
      { kind: 'rerun' },
    ],
    [
      '2: a batch that is not eligible gets the legacy card',
      input({ eligible: false }),
      { kind: 'legacy_card' },
    ],
    [
      '3: an outside failure after the rerun is out of moves',
      input({ outside: true, reran: true }),
      { kind: 'out_of_moves', reason: 'outside_twice' },
    ],
    [
      '4: the failure the last fix was filed for is out of moves, before the budget',
      input({ fix: fix({ count: 3, signature: 's' }) }),
      { kind: 'out_of_moves', reason: 'same_failure' },
    ],
    [
      '5: a spent budget is out of moves',
      input({ fix: fix({ count: 3, signature: 'other' }) }),
      { kind: 'out_of_moves', reason: 'budget' },
    ],
    ['6: two unreadable failures are never the same', input({ signature: null }), { kind: 'fix' }],
    [
      'forceInside skips the outside check and files a fix',
      input({ outside: true, reran: true, fix: fix({ count: 1, forceInside: true }) }),
      { kind: 'fix' },
    ],
  ])('%s', (_case, given, expected) => {
    expect(gateFailureAction(given)).toEqual(expected);
  });
});

describe('failureSignature', () => {
  it('reads the failing tests, not the order or the error line, and is null when nothing reads', () => {
    const step = (name: string, tests: { file: string; name: string | null }[]) => ({
      name,
      command: null,
      logPath: null,
      tests,
    });
    const a = { file: 'a.test.ts', name: 'adds' };
    const b = { file: 'b.test.ts', name: null };
    const first = failureSignature([step('lint', []), step('test', [a, b])], 'Error: one thing\n');
    const reordered = failureSignature(
      [step('test', [b, a, a]), step('lint', [])],
      'Error: another thing\n',
    );
    expect(first).not.toBeNull();
    expect(reordered).toBe(first);
    expect(
      failureSignature([step('lint', []), step('test', [{ ...a, name: 'subtracts' }, b])], ''),
    ).not.toBe(first);
    expect(failureSignature([step('lint', [])], 'ok\n  Container x  Started')).toBeNull();
  });
});
