import { describe, expect, it } from 'vitest';
import { RESTART_WINDOW_MS, restartsLeft } from './restart-budget';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: a preview that exits while wanted
// restarts by itself at most 3 times in 10 minutes, then stays stopped.

const NOW = 1_000_000_000;
const ago = (ms: number) => NOW - ms;

describe('restartsLeft', () => {
  it.each<{ name: string; exits: number[]; left: boolean }>([
    { name: 'the first exit', exits: [ago(0)], left: true },
    { name: 'a third exit in the window', exits: [ago(60_000), ago(30_000), ago(0)], left: true },
    {
      name: 'a fourth exit in the window gives up',
      exits: [ago(90_000), ago(60_000), ago(30_000), ago(0)],
      left: false,
    },
    {
      name: 'exits older than the window are forgotten',
      exits: [ago(RESTART_WINDOW_MS + 1), ago(RESTART_WINDOW_MS + 2), ago(60_000), ago(0)],
      left: true,
    },
  ])('$name', ({ exits, left }) => {
    expect(restartsLeft(exits, NOW)).toBe(left);
  });
});
