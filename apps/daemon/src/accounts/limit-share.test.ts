import { describe, expect, it } from 'vitest';
import { ceilingLimit, limitShare, UNNAMED_LIMIT, type LimitShareState } from './limit-share';

interface Report {
  readonly limitType: string | null;
  readonly utilization: number | null;
}

/** Folds the reports in order, as the runner does for one session. */
function fold(reports: readonly Report[]): LimitShareState {
  return reports.reduce<LimitShareState>((state, report) => limitShare(state, report), new Map());
}

describe('limitShare', () => {
  it.each([
    {
      name: 'one report gives no rise yet',
      reports: [{ limitType: 'seven_day', utilization: 0.4 }],
      expected: { seven_day: null },
    },
    {
      name: 'each later report adds its rise',
      reports: [
        { limitType: 'seven_day', utilization: 0.4 },
        { limitType: 'seven_day', utilization: 0.45 },
        { limitType: 'seven_day', utilization: 0.5 },
      ],
      expected: { seven_day: 0.1 },
    },
    {
      name: 'a reset counts the use since it, not a negative rise',
      reports: [
        { limitType: 'five_hour', utilization: 0.8 },
        { limitType: 'five_hour', utilization: 0.9 },
        { limitType: 'five_hour', utilization: 0.05 },
      ],
      expected: { five_hour: 0.15 },
    },
    {
      name: 'each limit type keeps its own last and rise',
      reports: [
        { limitType: 'seven_day', utilization: 0.1 },
        { limitType: 'five_hour', utilization: 0.5 },
        { limitType: 'seven_day', utilization: 0.12 },
        { limitType: 'five_hour', utilization: 0.6 },
      ],
      expected: { seven_day: 0.02, five_hour: 0.1 },
    },
    {
      name: 'a report with no utilization changes nothing',
      reports: [
        { limitType: 'seven_day', utilization: 0.1 },
        { limitType: 'seven_day', utilization: null },
        { limitType: 'seven_day', utilization: 0.3 },
      ],
      expected: { seven_day: 0.2 },
    },
    {
      name: 'a report with no limit type is the unnamed limit',
      reports: [
        { limitType: null, utilization: 0.2 },
        { limitType: null, utilization: 0.25 },
      ],
      expected: { [UNNAMED_LIMIT]: 0.05 },
    },
  ])('$name', ({ reports, expected }) => {
    const state = fold(reports);
    expect(Object.keys(expected).sort()).toEqual([...state.keys()].sort());
    for (const [type, rise] of Object.entries(expected)) {
      const kept = state.get(type)?.rise;
      if (rise === null) expect(kept).toBeNull();
      else expect(kept).toBeCloseTo(rise, 10);
    }
  });
});

describe('ceilingLimit', () => {
  it.each([
    {
      name: 'the weekly limit when heard',
      heard: ['five_hour', 'seven_day'],
      expected: 'seven_day',
    },
    {
      name: 'the longest named window when the weekly limit is not heard',
      heard: ['five_hour', '1440_minutes'],
      expected: '1440_minutes',
    },
    { name: 'a single named window', heard: ['five_hour'], expected: 'five_hour' },
    {
      name: 'a named window over the unnamed one',
      heard: [UNNAMED_LIMIT, 'five_hour'],
      expected: 'five_hour',
    },
    { name: 'the unnamed limit only when alone', heard: [UNNAMED_LIMIT], expected: UNNAMED_LIMIT },
    { name: 'nothing when none was heard', heard: [], expected: null },
  ])('picks $name', ({ heard, expected }) => {
    expect(ceilingLimit(heard)).toBe(expected);
  });
});
