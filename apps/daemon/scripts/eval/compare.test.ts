import { describe, expect, it } from 'vitest';
import { flipsAgainstBaseline, flipsBetweenRuns, keepRule } from './compare';
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

describe('keepRule', () => {
  const rows = [
    {
      name: 'the same outcomes hold',
      now: [{ id: 'a', outcomes: [Met, NotMet] }],
      before: [{ id: 'a', outcomes: [NotMet, Met] }],
      want: { holds: true, met: 1, baselineMet: 1, lostCases: [] },
    },
    {
      name: 'more met runs hold',
      now: [
        { id: 'a', outcomes: [Met, Met] },
        { id: 'b', outcomes: [Met, NotMet] },
      ],
      before: [
        { id: 'a', outcomes: [Met, Met] },
        { id: 'b', outcomes: [NotMet, NotMet] },
      ],
      want: { holds: true, met: 3, baselineMet: 2, lostCases: [] },
    },
    {
      name: 'fewer met runs fail, though no case is lost',
      now: [{ id: 'a', outcomes: [Met, NotMet] }],
      before: [{ id: 'a', outcomes: [Met, Met] }],
      want: { holds: false, met: 1, baselineMet: 2, lostCases: [] },
    },
    {
      name: 'a case that passed in the baseline and fails in both runs fails, whatever the count',
      now: [
        { id: 'a', outcomes: [Failed, NotMet] },
        { id: 'b', outcomes: [Met, Met] },
      ],
      before: [
        { id: 'a', outcomes: [NotMet, Met] },
        { id: 'b', outcomes: [NotMet, NotMet] },
      ],
      want: { holds: false, met: 2, baselineMet: 1, lostCases: ['a'] },
    },
    {
      name: 'a case only one side has decides nothing',
      now: [
        { id: 'a', outcomes: [Met, Met] },
        { id: 'new', outcomes: [NotMet, NotMet] },
      ],
      before: [
        { id: 'a', outcomes: [Met, Met] },
        { id: 'old', outcomes: [Met, Met] },
      ],
      want: { holds: true, met: 2, baselineMet: 2, lostCases: [] },
    },
  ];
  it.each(rows)('$name', ({ now, before, want }) => {
    expect(keepRule(now, before)).toEqual(want);
  });
});
