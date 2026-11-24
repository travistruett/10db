import { describe, expect, it } from 'vitest';
import { gateHoldReason } from './gate-hold-rule';
import type { GateResult } from './gate-runner';

function result(over: Partial<GateResult>): GateResult {
  return {
    exitCode: 2,
    durationMs: 1,
    tail: '',
    logPath: '/log',
    timedOut: false,
    aborted: false,
    blockedHosts: [],
    ...over,
  };
}

describe('gateHoldReason', () => {
  it.each([
    ['a marked line', { tail: 'x\n10db-hold: start the dev stack\n' }, 'start the dev stack'],
    [
      "Ampsio's own message",
      { tail: 'gate: backend source is not current; start make watch and retry\n' },
      'gate: backend source is not current; start make watch and retry',
    ],
    ['an ordinary failure', { tail: '3 failed, 10 passed' }, null],
    ['a passing gate', { exitCode: 0, tail: '10db-hold: x' }, null],
    ['a timeout', { timedOut: true, tail: '10db-hold: x' }, null],
    ['a slow failure', { durationMs: 60_000, tail: '10db-hold: x' }, null],
    ['an echoed line, not final', { tail: '10db-hold: x\na\nb\nc\nd' }, null],
    ['a stop', { aborted: true, tail: 'start make watch' }, null],
  ])('%s', (_name, over, expected) => {
    expect(gateHoldReason(result(over))).toBe(expected);
  });
});
