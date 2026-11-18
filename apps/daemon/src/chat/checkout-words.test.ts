import { FolderHolderKind, type FolderHolderDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { blockingHolder, checkoutHolderWords } from './checkout-words';

const holder = (over: Partial<FolderHolderDto>): FolderHolderDto => ({
  kind: FolderHolderKind.Lane,
  name: 'Bump vite',
  more: 0,
  chatId: null,
  what: null,
  ...over,
});

describe('blockingHolder', () => {
  it.each<{ name: string; holders: FolderHolderDto[]; want: FolderHolderKind | null }>([
    { name: 'no holder', holders: [], want: null },
    { name: 'a lane', holders: [holder({})], want: FolderHolderKind.Lane },
    {
      name: 'an open pass',
      holders: [holder({ kind: FolderHolderKind.PassOpen })],
      want: FolderHolderKind.PassOpen,
    },
    {
      name: 'a closed pass',
      holders: [holder({ kind: FolderHolderKind.PassClosed })],
      want: FolderHolderKind.PassClosed,
    },
    {
      name: 'a terminal',
      holders: [holder({ kind: FolderHolderKind.Takeover, chatId: null })],
      want: FolderHolderKind.Takeover,
    },
    {
      name: 'another chat’s turn only waits, so it does not refuse',
      holders: [holder({ kind: FolderHolderKind.ChatTurn })],
      want: null,
    },
    {
      name: '10db’s own git work only waits, so it does not refuse',
      holders: [holder({ kind: FolderHolderKind.GitWork, what: 'switching to main' })],
      want: null,
    },
    {
      name: 'the first refusing holder of several',
      holders: [
        holder({ kind: FolderHolderKind.ChatTurn }),
        holder({ kind: FolderHolderKind.PassOpen, name: 'Polish' }),
        holder({}),
      ],
      want: FolderHolderKind.PassOpen,
    },
  ])('$name', ({ holders, want }) => {
    expect(blockingHolder(holders)?.kind ?? null).toBe(want);
  });
});

describe('checkoutHolderWords', () => {
  it.each<{ name: string; holder: FolderHolderDto; branch: string | null; want: string }>([
    {
      name: 'a task on a branch',
      holder: holder({}),
      branch: 'main',
      want: 'A Board task is changing files on `main`.',
    },
    {
      name: 'several tasks',
      holder: holder({ more: 2 }),
      branch: 'main',
      want: 'Board tasks are changing files on `main`.',
    },
    {
      name: 'a pass',
      holder: holder({ kind: FolderHolderKind.PassOpen, name: 'Polish' }),
      branch: 'main',
      want: 'The pass ‘Polish’ is changing files on `main`.',
    },
    {
      name: 'a closed pass',
      holder: holder({ kind: FolderHolderKind.PassClosed, name: 'Polish' }),
      branch: 'main',
      want: 'The pass ‘Polish’ has your checkout on `main` until its pull request merges.',
    },
    {
      name: 'a terminal',
      holder: holder({ kind: FolderHolderKind.Takeover, name: 'Fix login' }),
      branch: 'main',
      want: 'The session ‘Fix login’ is in your terminal, on `main`.',
    },
    {
      name: 'a checkout on no branch',
      holder: holder({}),
      branch: null,
      want: 'A Board task is changing files in your checkout.',
    },
  ])('$name', ({ holder: h, branch, want }) => {
    expect(checkoutHolderWords(h, branch)).toBe(want);
  });
});
