import { describe, expect, it } from 'vitest';
import { minutesBeforeNow } from '../../test/pass-fixtures';
import { PageStatus } from './page-status';
import { isDimmed, queueOrder, queueRank, waitingCount, type QueueEntry } from './queue-order';

const S = PageStatus;

function entry(name: string, status: PageStatus, readyMinutesAgo: number | null = null) {
  return {
    name,
    status,
    readyAt: readyMinutesAgo === null ? null : minutesBeforeNow(readyMinutesAgo),
  } satisfies QueueEntry & { name: string };
}

describe('queueRank', () => {
  it.each<{ status: PageStatus; rank: number; dimmed: boolean }>([
    { status: S.Asks, rank: 1, dimmed: false },
    { status: S.Failed, rank: 1, dimmed: false },
    { status: S.PreviewBroken, rank: 2, dimmed: false },
    { status: S.Ready, rank: 3, dimmed: false },
    { status: S.SigningOff, rank: 4, dimmed: true },
    { status: S.Waiting, rank: 4, dimmed: true },
    { status: S.Working, rank: 4, dimmed: true },
    { status: S.Paused, rank: 4, dimmed: true },
    { status: S.NotStarted, rank: 4, dimmed: true },
    { status: S.SignedOff, rank: 4, dimmed: true },
  ])('$status is rank $rank', ({ status, rank, dimmed }) => {
    expect(queueRank(status)).toBe(rank);
    expect(isDimmed(status)).toBe(dimmed);
  });
});

describe('queueOrder', () => {
  it.each<{ name: string; entries: ReturnType<typeof entry>[]; order: string[]; waiting: number }>([
    {
      name: 'a stalled agent above a Ready page, whatever the page order',
      entries: [entry('Settings', S.Ready, 3), entry('People', S.Asks), entry('Billing', S.Failed)],
      order: ['People', 'Billing', 'Settings'],
      waiting: 3,
    },
    {
      name: 'a page that broke the preview after a stalled agent and before every Ready page',
      entries: [
        entry('Settings', S.Ready, 30),
        entry('People', S.PreviewBroken, 1),
        entry('Billing', S.Failed),
        entry('Home', S.Working),
      ],
      order: ['Billing', 'People', 'Settings', 'Home'],
      waiting: 3,
    },
    {
      name: 'Ready pages, the longest waiting first',
      entries: [
        entry('Settings', S.Ready, 3),
        entry('People', S.Ready, 12),
        entry('Home', S.Ready, 7),
      ],
      order: ['People', 'Home', 'Settings'],
      waiting: 3,
    },
    {
      name: 'the dimmed pages: signing off, then working and paused, then not started, then signed off',
      entries: [
        entry('Home', S.SignedOff),
        entry('Team', S.NotStarted),
        entry('Reports', S.Paused),
        entry('Billing', S.Working),
        entry('People', S.Waiting),
        entry('Settings', S.SigningOff),
      ],
      order: ['People', 'Settings', 'Reports', 'Billing', 'Team', 'Home'],
      waiting: 0,
    },
    {
      name: 'a working page never above a Ready one',
      entries: [entry('Billing', S.Working), entry('Settings', S.Ready, 1)],
      order: ['Settings', 'Billing'],
      waiting: 1,
    },
    { name: 'no pages', entries: [], order: [], waiting: 0 },
  ])('$name', ({ entries, order, waiting }) => {
    expect(queueOrder(entries).map((e) => e.name)).toEqual(order);
    expect(waitingCount(entries)).toBe(waiting);
  });

  it('leaves the pages it is given in their order', () => {
    const entries = [entry('Settings', S.Working), entry('People', S.Ready, 2)];
    queueOrder(entries);
    expect(entries.map((e) => e.name)).toEqual(['Settings', 'People']);
  });
});
