import { describe, expect, it } from 'vitest';
import { failedSteps } from './failed-steps';

describe('failedSteps', () => {
  it.each([
    ['no failing-step lines', 'FAIL badge.test.ts\nGATE FAIL: test', []],
    [
      'one step',
      'FAILED lint: pnpm lint (log .gate/lint.log)\nGATE FAIL: lint',
      [{ name: 'lint', command: 'pnpm lint', log: '.gate/lint.log' }],
    ],
    [
      'two steps, a command with spaces and flags',
      'FAILED e2e: pnpm --filter @10db/desktop e2e (log .gate/e2e.log)\nFAILED rust: make rust-check (log .gate/rust.log)',
      [
        { name: 'e2e', command: 'pnpm --filter @10db/desktop e2e', log: '.gate/e2e.log' },
        { name: 'rust', command: 'make rust-check', log: '.gate/rust.log' },
      ],
    ],
    ['a line indented inside a log', '  FAILED lint: pnpm lint (log .gate/lint.log)', []],
    ['a line with no log', 'FAILED lint: pnpm lint', []],
  ])('%s', (_name, output, expected) => {
    expect(failedSteps(output)).toEqual(expected);
  });
});
