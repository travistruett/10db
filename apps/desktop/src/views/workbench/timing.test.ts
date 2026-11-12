import { mintId, type PassTurnTimingDto, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { minutesBeforeNow, passTurnTimingDto, PASS_NOW } from '../../test/pass-fixtures';
import { PageStatus } from './page-status';
import type { QueueEntry } from './queue-order';
import {
  medianReplyMs,
  medianTurnMinutes,
  medianTurnMs,
  pagesFor,
  timingLine,
  waitedMinutes,
} from './timing';

const MIN = 60_000;
const now = Date.parse(PASS_NOW);

/** A turn of `task`, its times in minutes before now; a time left out has not happened. */
function turn(
  task: TaskId,
  times: { started: number; ended?: number; ready?: number; answered?: number; seq?: number },
): PassTurnTimingDto {
  const at = (minutes: number | undefined) =>
    minutes === undefined ? null : minutesBeforeNow(minutes);
  return passTurnTimingDto({
    taskId: task,
    seq: times.seq ?? 1,
    startedAt: minutesBeforeNow(times.started),
    endedAt: at(times.ended),
    readyAt: at(times.ready),
    answeredAt: at(times.answered),
  });
}

const settings = mintId('Task');
const people = mintId('Task');
const billing = mintId('Task');

describe('T, R and how many pages keep the builder busy', () => {
  it('takes T from ended turns and R from answered Ready turns, each a median', () => {
    const turns = [
      turn(settings, { started: 30, ended: 26, ready: 26, answered: 24 }),
      turn(people, { started: 30, ended: 24, ready: 24, answered: 21 }),
      turn(billing, { started: 30, ended: 21, ready: 21, answered: 11 }),
      // Still working: no T. Ready and not answered: no R.
      turn(settings, { started: 20, seq: 2 }),
      turn(people, { started: 20, ended: 15, ready: 15, seq: 2 }),
    ];
    expect(medianTurnMs(turns)).toBe(5.5 * MIN);
    expect(medianTurnMinutes(turns)).toBe(6);
    expect(medianReplyMs(turns)).toBe(3 * MIN);
  });

  it('has no T or R before a turn ends or is answered', () => {
    const turns = [turn(settings, { started: 4 })];
    expect(medianTurnMs(turns)).toBeNull();
    expect(medianTurnMinutes(turns)).toBeNull();
    expect(medianReplyMs(turns)).toBeNull();
  });

  it.each<{ name: string; t: number; r: number; pages: number }>([
    { name: '10 min turns, a 3 min look', t: 10, r: 3, pages: 4 },
    { name: '10 min turns, a 4 min look', t: 10, r: 4, pages: 4 },
    { name: '10 min turns, a 5 min look', t: 10, r: 5, pages: 3 },
    { name: 'one-minute tweaks, a one-minute look', t: 1, r: 1, pages: 2 },
    { name: 'one-minute tweaks, a 3 min look', t: 1, r: 3, pages: 1 },
    { name: 'hour-long turns: never past the cap', t: 60, r: 1, pages: 6 },
    { name: 'an instant look', t: 10, r: 0, pages: 6 },
    { name: 'instant turns', t: 0, r: 3, pages: 1 },
  ])('$name: $pages', ({ t, r, pages }) => {
    expect(pagesFor(t * MIN, r * MIN)).toBe(pages);
  });
});

describe('waitedMinutes: a page working and none ready or asking, over the last 10 minutes', () => {
  it.each<{ name: string; turns: PassTurnTimingDto[]; asking?: number[]; waited: number }>([
    {
      name: 'a page working the whole time',
      turns: [turn(billing, { started: 20 })],
      waited: 10,
    },
    {
      name: 'a page working, another Ready for the last 4 minutes',
      turns: [turn(billing, { started: 20 }), turn(settings, { started: 15, ended: 4, ready: 4 })],
      waited: 6,
    },
    {
      name: 'a page that started working 6 minutes ago',
      turns: [turn(billing, { started: 6 })],
      waited: 6,
    },
    {
      name: 'a Ready page answered 3 minutes ago, after 5 minutes Ready',
      turns: [
        turn(billing, { started: 20 }),
        turn(settings, { started: 15, ended: 8, ready: 8, answered: 3 }),
      ],
      waited: 5,
    },
    {
      name: 'a question open for the last 2 minutes',
      turns: [turn(billing, { started: 20 }), turn(people, { started: 20 })],
      asking: [2],
      waited: 8,
    },
    {
      name: 'a Ready page whose next turn started without an answer recorded',
      turns: [
        turn(billing, { started: 20 }),
        turn(settings, { started: 15, ended: 9, ready: 9 }),
        turn(settings, { started: 5, seq: 2 }),
      ],
      waited: 6,
    },
    { name: 'nothing working', turns: [], waited: 0 },
  ])('$name: $waited', ({ turns, asking = [], waited }) => {
    expect(waitedMinutes(turns, asking.map(minutesBeforeNow), now)).toBe(waited);
  });
});

describe('timingLine', () => {
  /** Settings' first turn gives T = 10 min and R = 3 min, so 4 pages keep the builder busy. */
  const history = [turn(settings, { started: 40, ended: 30, ready: 30, answered: 27 })];
  const page = (status: PageStatus, readyMinutesAgo: number | null = null): QueueEntry => ({
    status,
    readyAt: readyMinutesAgo === null ? null : minutesBeforeNow(readyMinutesAgo),
  });

  it.each<{
    name: string;
    turns: PassTurnTimingDto[];
    pages: QueueEntry[];
    line: string | null;
  }>([
    {
      name: 'the builder waited 6 of 10 minutes with 2 pages where 4 would keep them busy',
      turns: [
        ...history,
        turn(billing, { started: 20 }),
        turn(people, { started: 14, ended: 4, ready: 4 }),
      ],
      pages: [page(PageStatus.Working), page(PageStatus.Ready, 4)],
      line: 'You waited 6 of the last 10 minutes: add a page',
    },
    {
      name: 'waited 4 minutes: too little to say',
      turns: [
        ...history,
        turn(billing, { started: 20 }),
        turn(people, { started: 14, ended: 6, ready: 6 }),
      ],
      pages: [page(PageStatus.Working), page(PageStatus.Ready, 6)],
      line: null,
    },
    {
      name: 'waited, with as many pages in play as keep the builder busy',
      turns: [...history, turn(billing, { started: 20 })],
      pages: [
        page(PageStatus.Working),
        page(PageStatus.Working),
        page(PageStatus.Paused),
        page(PageStatus.NotStarted),
      ],
      line: null,
    },
    {
      name: 'waited, but the pass already holds six pages, two signed off',
      turns: [
        turn(settings, { started: 80, ended: 20, ready: 20, answered: 19 }),
        turn(billing, { started: 20 }),
      ],
      pages: [
        page(PageStatus.Working),
        page(PageStatus.Working),
        page(PageStatus.NotStarted),
        page(PageStatus.NotStarted),
        page(PageStatus.SignedOff),
        page(PageStatus.SignedOff),
      ],
      line: null,
    },
    {
      name: 'waited, before any Ready page was answered: no R to judge by',
      turns: [turn(billing, { started: 20 })],
      pages: [page(PageStatus.Working)],
      line: null,
    },
    {
      name: 'three pages Ready for over 10 minutes',
      turns: history,
      pages: [
        page(PageStatus.Ready, 25),
        page(PageStatus.Ready, 14),
        page(PageStatus.Ready, 11),
        page(PageStatus.Ready, 2),
      ],
      line: '3 pages have been ready for over 10 minutes',
    },
    {
      name: 'one page Ready for over 10 minutes',
      turns: history,
      pages: [page(PageStatus.Ready, 25), page(PageStatus.Ready, 2)],
      line: null,
    },
  ])('$name', ({ turns, pages, line }) => {
    expect(timingLine({ turns, pages, asking: [], now })).toBe(line);
  });
});
