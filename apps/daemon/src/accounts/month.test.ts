import { describe, expect, it } from 'vitest';
import { monthOf, monthWindow, usageWindow } from './index';

describe('months, in local time', () => {
  it.each<[string, Date, string, Date, Date]>([
    [
      'mid-month',
      new Date(2026, 9, 13, 12),
      '2026-10',
      new Date(2026, 9, 1),
      new Date(2026, 10, 1),
    ],
    [
      'the last minute',
      new Date(2026, 9, 31, 23, 59),
      '2026-10',
      new Date(2026, 9, 1),
      new Date(2026, 10, 1),
    ],
    [
      'the first instant',
      new Date(2026, 10, 1, 0, 0),
      '2026-11',
      new Date(2026, 10, 1),
      new Date(2026, 11, 1),
    ],
    [
      'December',
      new Date(2026, 11, 31, 23, 0),
      '2026-12',
      new Date(2026, 11, 1),
      new Date(2027, 0, 1),
    ],
  ])('%s', (_name, at, month, start, end) => {
    expect(monthOf(at)).toEqual({ month, start, end });
  });

  it('opens a named month and refuses a malformed one', () => {
    expect(monthWindow('2026-02')).toEqual({
      month: '2026-02',
      start: new Date(2026, 1, 1),
      end: new Date(2026, 2, 1),
    });
    expect(() => monthWindow('2026-13')).toThrow();
    expect(usageWindow(monthWindow('2026-02'))).toEqual({
      month: '2026-02',
      start: new Date(2026, 1, 1).toISOString(),
      end: new Date(2026, 2, 1).toISOString(),
    });
  });
});
