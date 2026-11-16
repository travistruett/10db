import {
  FolderAsker,
  FolderHolderKind,
  FolderLimit,
  FolderOutcome,
  type FolderHolderDto,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { exclusion, holderWords, limitsOf } from './exclusion';

const S = FolderOutcome.Shares;
const W = FolderOutcome.Waits;
const R = FolderOutcome.Refused;
const RW = FolderOutcome.ReadsOrWaits;

// 10db's git work shares with a lane or a pass here: those keep today's checks, so a batch's own row never
// blocks its cut. Rows are holders; columns are lane start, 10db git work, chat turn, takeover.
const TABLE: [FolderHolderKind, FolderOutcome[]][] = [
  [FolderHolderKind.Lane, [S, S, RW, R]],
  [FolderHolderKind.PassOpen, [W, S, RW, R]],
  [FolderHolderKind.PassClosed, [W, S, S, S]],
  [FolderHolderKind.GitWork, [W, W, RW, R]],
  [FolderHolderKind.ChatTurn, [W, W, S, S]],
  [FolderHolderKind.WaitingChat, [W, S, S, S]],
  [FolderHolderKind.Takeover, [W, W, S, S]],
];
const ASKERS = [
  FolderAsker.LaneStart,
  FolderAsker.GitWork,
  FolderAsker.ChatTurn,
  FolderAsker.Takeover,
];

describe('exclusion', () => {
  it.each(
    TABLE.flatMap(([holder, row]) => ASKERS.map((asker, i) => [holder, asker, row[i]] as const)),
  )('%s holds, %s asks: %s', (holder, asker, outcome) => {
    expect(exclusion(holder, asker)).toBe(outcome);
  });

  it('limits a chat only while a closed pass waits for its pull request', () => {
    for (const kind of Object.values(FolderHolderKind))
      expect(limitsOf(kind)).toEqual(
        kind === FolderHolderKind.PassClosed ? [FolderLimit.FolderGitUntilMerge] : [],
      );
  });
});

const holder = (over: Partial<FolderHolderDto>): FolderHolderDto => ({
  kind: FolderHolderKind.Lane,
  name: '',
  more: 0,
  chatId: null,
  what: null,
  ...over,
});

describe('holderWords', () => {
  it.each([
    [holder({ name: 'Bump vite', more: 2 }), 'the task ‘Bump vite’ and 2 more'],
    [holder({ name: 'Bump vite' }), 'the task ‘Bump vite’'],
    [
      holder({ kind: FolderHolderKind.PassClosed, name: 'Settings pass' }),
      'the pass ‘Settings pass’ (until its pull request merges)',
    ],
    [
      holder({ kind: FolderHolderKind.PassOpen, name: 'Settings pass' }),
      'the pass ‘Settings pass’',
    ],
    [holder({ kind: FolderHolderKind.ChatTurn, name: 'Retry login' }), 'the chat ‘Retry login’'],
    [holder({ kind: FolderHolderKind.WaitingChat, name: 'Retry login' }), 'the chat ‘Retry login’'],
    [
      holder({ kind: FolderHolderKind.Takeover, name: 'Retry login' }),
      'the chat ‘Retry login’ in your terminal',
    ],
    [
      holder({ kind: FolderHolderKind.GitWork, what: 'switching Your folder back to `main`' }),
      '10db switching Your folder back to `main`',
    ],
  ])('%j reads %s', (h, words) => {
    expect(holderWords(h)).toBe(words);
  });
});
