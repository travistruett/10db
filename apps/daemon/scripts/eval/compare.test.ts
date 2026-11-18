import { describe, expect, it } from 'vitest';
import { flipsAgainstBaseline, flipsBetweenRuns } from './compare';
import { Outcome } from './grade';

const { Met, NotMet, Failed } = Outcome;

describe('flipsBetweenRuns', () => {
  it('lists only the cases whose two runs ended differently', () => {
    expect(
      flipsBetweenRuns([
        { id: 'same', outcomes: [Met, Met] },
        { id: 'flip', outcomes: [Met, Failed] },
        { id: 'both-bad', outcomes: [NotMet, NotMet] },
      ]),
    ).toEqual(['flip']);
  });
});

describe('flipsAgainstBaseline', () => {
  const rows = [
    {
      name: 'the same outcomes in another order are no flip',
      now: [{ id: 'a', outcomes: [Met, Failed] }],
      before: [{ id: 'a', outcomes: [Failed, Met] }],
      want: { changed: [], added: [], dropped: [] },
    },
    {
      name: 'a case that met before and fails now flipped',
      now: [{ id: 'a', outcomes: [NotMet, Met] }],
      before: [{ id: 'a', outcomes: [Met, Met] }],
      want: {
        changed: [{ id: 'a', now: [Met, NotMet], before: [Met, Met] }],
        added: [],
        dropped: [],
      },
    },
    {
      name: 'cases on one side only are listed as added or dropped',
      now: [{ id: 'new', outcomes: [Met, Met] }],
      before: [{ id: 'old', outcomes: [Met, Met] }],
      want: { changed: [], added: ['new'], dropped: ['old'] },
    },
  ];
  it.each(rows)('$name', ({ now, before, want }) => {
    expect(flipsAgainstBaseline(now, before)).toEqual(want);
  });
});
